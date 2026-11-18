/**
 * A tiny stand-in for Cloudflare D1 on top of sql.js (SQLite compiled to WebAssembly), so the real Worker code can run inside the browser for the demo.
 * Only the parts of the D1 API this project uses are here: prepare / bind / first / all / run / raw, batch and exec.
 * Everything lives in memory: closing the tab or reloading the page throws it all away.
 */
import type { Database, SqlValue } from 'sql.js';

type Row = Record<string, unknown>;

/** D1 turns booleans into 1/0 and undefined into NULL; sql.js does not, so do it here. */
const toSql = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || v instanceof Uint8Array) return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return String(v);
};

export class DemoStatement {
  constructor(private d1: DemoD1, readonly sql: string, readonly params: SqlValue[] = []) {}
  bind(...values: unknown[]) { return new DemoStatement(this.d1, this.sql, values.map(toSql)); }
  /** Runs the statement and returns every row as an object. */
  exec(): Row[] {
    const st = this.d1.db.prepare(this.sql);
    try {
      st.bind(this.params);
      const out: Row[] = [];
      while (st.step()) out.push(st.getAsObject() as Row);
      return out;
    } finally {
      st.free();
    }
  }
  private meta() { return { changes: this.d1.db.getRowsModified(), last_row_id: 0, duration: 0, rows_read: 0, rows_written: 0, changed_db: false, size_after: 0 }; }
  async all<T = Row>() { const results = this.exec() as T[]; return { results, success: true as const, meta: this.meta() }; }
  async run<T = Row>() { return this.all<T>(); }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const r = this.exec()[0];
    if (!r) return null;
    return (col ? (r[col] as T) : (r as T)) ?? null;
  }
  async raw<T = unknown[]>(): Promise<T[]> { return this.exec().map((r) => Object.values(r)) as T[]; }
}

export class DemoD1 {
  constructor(readonly db: Database) {}
  prepare(sql: string) { return new DemoStatement(this, sql); }
  /** Like D1: every statement commits together, or (on any error) none of them do. */
  async batch(stmts: DemoStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out: Awaited<ReturnType<DemoStatement["all"]>>[] = [];
      for (const s of stmts) out.push(await s.all());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 1, duration: 0 }; }
  dump(): never { throw new Error('Not available in the demo.'); }
  withSession() { return this; }
}
