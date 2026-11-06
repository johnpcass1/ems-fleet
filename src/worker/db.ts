import { conflict, nowISO } from './http';
import type { Actor } from '../shared/perm';

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
  constructor(public db: D1Database, public actor: Actor | null) {
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
    return this.run(`INSERT OR REPLACE INTO tombstones (coll, id, seq) VALUES (?, ?, ${SEQ})`, coll, id);
  }
  /** Write an audit row (inside the same batch). */
  audit(action: string, entityType: string, entityId: string | null, before: unknown, after: unknown) {
    const a = this.actor;
    return this.run(
      `INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, before_json, after_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.at, a?.id ?? null, a?.email ?? null, action, entityType, entityId,
      before === undefined || before === null ? null : JSON.stringify(before),
      after === undefined || after === null ? null : JSON.stringify(after),
      this.at, this.at,
    );
  }
  async commit() {
    try {
      return await this.db.batch(this.stmts);
    } catch (e: any) {
      const msg = String(e?.message || e) + String(e?.cause?.message || '');
      if (msg.includes(GUARD_FAIL)) throw conflict('Someone else changed this just now. Refresh and try again.', 'stale');
      if (/UNIQUE constraint failed: vehicles/i.test(msg)) throw conflict('Another unit already uses that name.', 'duplicate_unit');
      if (/UNIQUE constraint failed: work_orders\.number/i.test(msg)) throw conflict('Please try again.', 'wo_number_taken');
      if (/UNIQUE constraint failed: users\.email/i.test(msg)) throw conflict('Another user already has that email address.', 'duplicate_email');
      throw e;
    }
  }
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
