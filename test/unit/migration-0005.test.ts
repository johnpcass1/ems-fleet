import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Migration 0005 (many agencies) on a database that already has data from migrations 0001-0004, and on a brand new one.
 * Runs the real SQL files in SQLite. Rows are made by reading each table's columns, so a table or column added later is covered too.
 */
const files = readdirSync('migrations').filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const sql = (f: string) => readFileSync('migrations/' + f, 'utf8');
const before = files.filter((f) => f < '0005');
const AGENCY_TABLES = ['bases', 'pm_programs', 'pm_tasks', 'mechanics', 'parts', 'settings', 'vehicles', 'vehicle_pm', 'meter_readings', 'status_events', 'moves', 'issues', 'work_orders', 'work_order_lines', 'wo_issue_links', 'wo_pm_tasks', 'attachments', 'users', 'sessions', 'audit_log', 'account_tokens', 'tombstones', 'login_attempts'];
const GLOBAL_TABLES = ['counter', 'auth_throttle', 'backup_jobs'];

/** Values for columns with a CHECK list, where 'x' would be refused. */
const CHECKS: Record<string, any> = { entity_type: 'issue', severity: 'minor', status: 'open', role: 'crew', purpose: 'invite', kind: 'labor', type: 'corrective', priority: 'normal', coll: 'vehicles' };

function fill(db: DatabaseSync, table: string, over: Record<string, any> = {}) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  const names: string[] = [], vals: any[] = [];
  let n = 0;
  for (const c of cols) {
    if (c.pk && /INT/i.test(c.type) && c.name === 'id') continue; // autoincrement
    if (!c.notnull && !(c.name in over)) continue;
    if (c.dflt_value !== null && !(c.name in over)) continue;
    names.push(c.name);
    vals.push(c.name in over ? over[c.name] : c.name in CHECKS ? CHECKS[c.name] : /INT|REAL/i.test(c.type) ? 1 : `${table}-${c.name}-${++n}`);
  }
  db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals);
}

function oldDb() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const f of before) db.exec(sql(f));
  return db;
}
function seedOld(db: DatabaseSync) {
  for (const t of AGENCY_TABLES) {
    const over: Record<string, any> = t === 'settings' ? { id: 'main' } : t === 'vehicles' ? { unit: 'AMB-1' } : t === 'work_orders' ? { number: 'WO-0001' } : t === 'users' ? { email: 'a@old.test' } : t === 'tombstones' ? { coll: 'vehicles', id: 'gone-1' } : {};
    try { fill(db, t, over); } catch (e: any) { throw new Error(`could not seed ${t}: ${e.message}`); }
  }
  db.exec('UPDATE counter SET v = 41 WHERE id = 1');
}

describe('migration 0005 on a database with data', () => {
  const db = oldDb();
  seedOld(db);
  const countBefore = Object.fromEntries(AGENCY_TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n]));
  db.exec(sql('0005_agencies.sql'));

  it('creates the agencies table with GEMA, active', () => {
    expect(db.prepare('SELECT id, name, active, created_by FROM agencies').all()).toEqual([{ id: 'GEMA', name: 'GEMA', active: 1, created_by: null }]);
  });
  it('keeps every row and files it under GEMA', () => {
    for (const t of AGENCY_TABLES) {
      expect(countBefore[t], t + ' had a row').toBeGreaterThan(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, t).toBe(countBefore[t]);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE agency_id = 'GEMA'`).get() as any).n, t + ' agency_id').toBe(countBefore[t]);
    }
  });
  it('has no agency_id on the global tables', () => {
    for (const t of GLOBAL_TABLES) expect((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name), t).not.toContain('agency_id');
  });
  it('renames the settings row main -> GEMA and gives it a new change number', () => {
    const r = db.prepare('SELECT id, seq FROM settings').all() as any[];
    expect(r.map((x) => x.id)).toEqual(['GEMA']);
    expect(r[0].seq).toBe(42);
    expect((db.prepare('SELECT v FROM counter WHERE id = 1').get() as any).v).toBe(42);
  });
  it('uniqueness is per agency', () => {
    // the same unit, WO number and email in a second agency are fine; inside one agency they are still refused
    fill(db, 'vehicles', { unit: 'amb-1', agency_id: 'OTHER' });
    fill(db, 'work_orders', { number: 'WO-0001', agency_id: 'OTHER' });
    fill(db, 'users', { email: 'A@OLD.test', agency_id: 'OTHER' });
    expect(() => fill(db, 'vehicles', { unit: 'Amb-1', agency_id: 'GEMA' })).toThrow(/UNIQUE/);
    expect(() => fill(db, 'work_orders', { number: 'WO-0001', agency_id: 'GEMA' })).toThrow(/UNIQUE/);
    expect(() => fill(db, 'users', { email: 'a@OLD.test', agency_id: 'GEMA' })).toThrow(/UNIQUE/);
  });
  it('replaces the old indexes with agency-first ones', () => {
    const idx = (db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as any[]);
    const names = idx.map((i) => i.name);
    for (const gone of ['idx_bases_seq', 'idx_vehicles_seq', 'idx_users_seq', 'idx_tombstones_seq', 'idx_settings_seq']) expect(names).not.toContain(gone);
    for (const t of ['bases', 'pm_programs', 'mechanics', 'parts', 'settings', 'vehicles', 'meter_readings', 'status_events', 'moves', 'issues', 'work_orders', 'users', 'tombstones']) {
      expect(idx.some((i) => i.tbl_name === t && /\(agency_id, seq\)/.test(i.sql)), `${t} (agency_id, seq)`).toBe(true);
    }
    expect(idx.find((i) => i.name === 'idx_users_email')!.sql).toMatch(/\(agency_id, email\)/);
    expect(idx.find((i) => i.name === 'idx_vehicles_unit')!.sql).toMatch(/\(agency_id, lower\(unit\)\)/);
    expect(idx.find((i) => i.name === 'idx_work_orders_number')!.sql).toMatch(/\(agency_id, number\)/);
  });
  it('the agencies table refuses a bad code', () => {
    const add = (id: string) => db.prepare("INSERT INTO agencies (id, name, created_at, updated_at) VALUES (?, 'n', 'x', 'x')").run(id);
    add('OK-1');
    for (const bad of ['x', 'lower', 'A'.repeat(21), 'HAS SPACE', 'UN_DER']) expect(() => add(bad), bad).toThrow();
    expect(() => add('OK-1')).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe('migration 0005 on a new database', () => {
  it('applies after 0001-0004 with no rows, leaving only the GEMA agency', () => {
    const db = oldDb();
    db.exec(sql('0005_agencies.sql'));
    for (const t of AGENCY_TABLES) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, t).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agencies').get() as any).n).toBe(1);
  });
  it('every agency-owned table has agency_id NOT NULL DEFAULT GEMA, and every table is accounted for', () => {
    const db = oldDb();
    db.exec(sql('0005_agencies.sql'));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").all() as any[]).map((t) => t.name).filter((t) => t !== 'agencies');
    expect(tables.sort()).toEqual([...AGENCY_TABLES, ...GLOBAL_TABLES].sort());
    for (const t of AGENCY_TABLES) {
      const c = (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).find((x) => x.name === 'agency_id');
      expect(c, t).toBeTruthy();
      expect(c.notnull, t).toBe(1);
      expect(c.dflt_value, t).toBe("'GEMA'");
    }
  });
});
