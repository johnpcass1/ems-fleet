import { conflict, nowISO } from './http';
import type { Actor } from '../shared/perm';
import { sanitizeAudit } from '../shared/activity';

/** The change counter value for the batch being built. Every row written in the batch gets this `seq`. */
export const SEQ = '(SELECT v FROM counter WHERE id = 1)';

const GUARD_FAIL = 'integer overflow';

/**
 * A write transaction. All statements go to D1 in one batch, so they commit together or not at all.
 * The first statement bumps the change counter; rows written afterwards use SEQ.
 */
export class Tx {
  stmts: D1PreparedStatement[] = [];
  readonly at = nowISO();
  /** The agency every row written in this transaction belongs to. Taken from the actor (the session's agency) unless the caller names one (agency management, sign-in). */
  readonly agency: string;
  constructor(public db: D1Database, public actor: Actor | null, agencyId?: string) {
    const a = agencyId ?? actor?.agencyId;
    if (!a) throw new Error('Tx needs an agency (an actor with agencyId, or an explicit agency id).');
    this.agency = a;
    this.stmts.push(db.prepare('UPDATE counter SET v = v + 1 WHERE id = 1'));
  }
  run(sql: string, ...params: unknown[]) {
    this.stmts.push(this.db.prepare(sql).bind(...params.map((p) => (p === undefined ? null : p))));
    return this;
  }
  /** Fail (and roll back the whole batch) unless the condition holds. */
  guard(condSql: string, ...params: unknown[]) {
    return this.run(`SELECT CASE WHEN (${condSql}) THEN 1 ELSE abs(-9223372036854775808) END`, ...params);
  }
  /** Record a delete so every browser removes the row on its next sync. */
  tomb(coll: string, id: string) {
    return this.run(`INSERT OR REPLACE INTO tombstones (coll, id, seq, agency_id) VALUES (?, ?, ${SEQ}, ?)`, coll, id, this.agency);
  }
  /** Write an audit row (inside the same batch). The sanitiser removes anything that looks like a password, hash, token or session. */
  audit(action: string, entityType: string, entityId: string | null, before: unknown, after: unknown) {
    const a = this.actor;
    this.stmts.push(auditStmt(this.db, { agencyId: this.agency, at: this.at, userId: a?.id ?? null, email: a?.email ?? null, action, entityType, entityId, before, after }));
    return this;
  }
  /**
   * Several audit rows in ONE statement (a D1 batch counts every statement, and the free plan allows few per request), written through the same
   * sanitiser as `audit`. Use it where one action writes many rows, for example a bus check that creates many problems.
   */
  auditMany(rows: { action: string; entityType: string; entityId: string | null; before?: unknown; after?: unknown }[]) {
    if (!rows.length) return this;
    const a = this.actor;
    const js = (x: unknown) => (x === undefined || x === null ? null : JSON.stringify(sanitizeAudit(x)));
    const payload = JSON.stringify(rows.map((r) => ({ action: r.action, et: r.entityType, id: r.entityId, b: js(r.before), a: js(r.after) })));
    return this.run(
      `INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, before_json, after_json, created_at, updated_at, agency_id)
       SELECT ?, ?, ?, json_extract(j.value, '$.action'), json_extract(j.value, '$.et'), json_extract(j.value, '$.id'), json_extract(j.value, '$.b'), json_extract(j.value, '$.a'), ?, ?, ? FROM json_each(?) j ORDER BY j.key`,
      this.at, a?.id ?? null, a?.email ?? null, this.at, this.at, this.agency, payload,
    );
  }
  async commit() {
    try {
      return await this.db.batch(this.stmts);
    } catch (e: any) {
      const msg = String(e?.message || e) + String(e?.cause?.message || '');
      if (msg.includes(GUARD_FAIL)) throw conflict('Someone else changed this just now. Refresh and try again.', 'stale');
      // The unique rules are per agency: (agency_id, lower(unit)), (agency_id, number) and (agency_id, email).
      if (/UNIQUE constraint failed: (vehicles|index 'idx_vehicles_unit')/i.test(msg)) throw conflict('Another unit already uses that name.', 'duplicate_unit');
      if (/UNIQUE constraint failed: (work_orders\.|index 'idx_work_orders_number')/i.test(msg)) throw conflict('Please try again.', 'wo_number_taken');
      if (/UNIQUE constraint failed: (users\.|index 'idx_users_email')/i.test(msg)) throw conflict('Another user already has that email address.', 'duplicate_email');
      if (/UNIQUE constraint failed: agencies\./i.test(msg)) throw conflict('That Agency ID is already in use.', 'duplicate_agency');
      throw e;
    }
  }
}

export interface AuditInput { agencyId: string; at: string; userId: string | null; email: string | null; action: string; entityType: string; entityId: string | null; before?: unknown; after?: unknown }
/**
 * THE way an audit row is written (the Tx helper and the sign-in code both use it), so the sanitiser always runs:
 * no password, password hash, session or token (or reset / invite link secret) can reach audit_log through here.
 */
export function auditStmt(db: D1Database, a: AuditInput): D1PreparedStatement {
  const js = (x: unknown) => (x === undefined || x === null ? null : JSON.stringify(sanitizeAudit(x)));
  return db
    .prepare(
      `INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, before_json, after_json, created_at, updated_at, agency_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(a.at, a.userId, a.email, a.action, a.entityType, a.entityId, js(a.before), js(a.after), a.at, a.at, a.agencyId);
}

/** Run a read query and return rows. */
export async function all<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results || [];
}
export async function first<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}
export const b2i = (v: unknown) => (v ? 1 : 0);
export const sampleCol = (r: any) => (r.sample ? { sample: true } : {});

/**
 * Fetch ONE row of an agency-owned table by id, only if it belongs to `agency`. Anything else (unknown id, another agency's id) is simply "no row",
 * so callers answer exactly as they do for an id that does not exist. `table` must be one of the agency tables below (never user input).
 */
export const AGENCY_TABLES = ['bases', 'pm_programs', 'pm_tasks', 'mechanics', 'parts', 'vehicles', 'meter_readings', 'issues', 'work_orders', 'attachments', 'users', 'bus_check_lists', 'bus_checks'] as const;
export type AgencyTable = (typeof AGENCY_TABLES)[number];
export function agencyRow<T = any>(db: D1Database, table: AgencyTable, agency: string, id: string): Promise<T | null> {
  if (!(AGENCY_TABLES as readonly string[]).includes(table)) throw new Error('agencyRow: not an agency table ' + table);
  return first<T>(db, `SELECT * FROM ${table} WHERE agency_id = ? AND id = ?`, agency, id);
}
/** True when a row with this id exists in the agency. */
export async function inAgency(db: D1Database, table: AgencyTable, agency: string, id: string): Promise<boolean> {
  if (!(AGENCY_TABLES as readonly string[]).includes(table)) throw new Error('inAgency: not an agency table ' + table);
  return !!(await first(db, `SELECT 1 FROM ${table} WHERE agency_id = ? AND id = ?`, agency, id));
}
