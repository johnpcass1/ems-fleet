/**
 * Nightly backup, built to fit the Workers Free plan (10 ms CPU per invocation).
 *
 * One call to backupStep() does ONE small piece of work: it reads up to CHUNK rows of one table,
 * gzips them and saves the piece to R2. The cron runs every minute in the 07:00-08:59 UTC window
 * (03:00-04:59 in Guyana), so a whole backup takes a few dozen runs. The final step joins the pieces
 * (a file made of gzip pieces is still a valid .gz) and keeps only the newest 30 backups.
 *
 * The "Run backup now" button in the app simply calls the same step over and over until it says "done".
 */
import type { Env } from './env';
import { all, first } from './db';
import { nowISO } from './http';

export const BACKUP_TABLES = [
  'counter', 'tombstones', 'bases', 'pm_programs', 'pm_tasks', 'mechanics', 'parts', 'settings', 'vehicles', 'vehicle_pm', 'meter_readings', 'status_events', 'moves',
  'issues', 'work_orders', 'work_order_lines', 'wo_issue_links', 'wo_pm_tasks', 'attachments', 'users', 'audit_log',
];
// account_tokens and auth_throttle are left out on purpose: they only hold hashes of short-lived links and counters, and a restored link would be dead anyway.
export const KEEP_BACKUPS = 30;
export const CHUNK_ROWS = 1000;
const FILE_RE = /^backups\/(\d{4}-\d{2}-\d{2})\.json\.gz$/;

interface State { n: number; idx: number; lastRowid: number | null; rowsInTable: number; parts: { key: string; size: number }[]; createdAt: string; rows: number }

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function backupStep(env: Env, opts: { now?: Date; force?: boolean } = {}): Promise<{ status: 'idle' | 'running' | 'done'; date: string; step?: number; of?: number; key?: string }> {
  const now = opts.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const stamp = nowISO();
  let job = await first<any>(env.DB, 'SELECT * FROM backup_jobs WHERE id = ?', date);
  if (job && job.status === 'done' && opts.force) {
    await env.DB.prepare('DELETE FROM backup_jobs WHERE id = ?').bind(date).run();
    job = null;
  }
  if (job && job.status === 'done') return { status: 'idle', date };
  let st: State;
  if (!job) {
    st = { n: 0, idx: 0, lastRowid: null, rowsInTable: 0, parts: [], createdAt: now.toISOString(), rows: 0 };
    await env.DB.prepare("INSERT OR IGNORE INTO backup_jobs (id, status, state, created_at, updated_at) VALUES (?, 'running', ?, ?, ?)").bind(date, JSON.stringify(st), stamp, stamp).run();
    // housekeeping that is cheap enough to do once a day
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(stamp),
      env.DB.prepare('DELETE FROM login_attempts WHERE at_ms < ?').bind(Date.now() - 24 * 3600e3),
      env.DB.prepare('DELETE FROM auth_throttle WHERE at_ms < ?').bind(Date.now() - 24 * 3600e3),
      env.DB.prepare('DELETE FROM account_tokens WHERE expires_at < ?').bind(new Date(Date.now() - 30 * 864e5).toISOString()),
    ]);
    // pieces left over from a backup that never finished on an earlier day
    const stale = await env.FILES.list({ prefix: 'backups/tmp/', limit: 200 });
    for (const o of stale.objects) if (!o.key.startsWith(`backups/tmp/${date}/`)) await env.FILES.delete(o.key);
  } else {
    st = JSON.parse(job.state);
  }

  const table = BACKUP_TABLES[st.idx];
  const rows = await all<any>(env.DB, `SELECT rowid AS _r, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, st.lastRowid ?? -1, CHUNK_ROWS);
  let text = '';
  if (st.n === 0) text += `{"app":"gema-fleet","version":1,"createdAt":${JSON.stringify(st.createdAt)},"tables":{`;
  if (st.lastRowid === null && st.rowsInTable === 0) text += (st.idx > 0 ? ',' : '') + JSON.stringify(table) + ':[';
  let k = st.rowsInTable;
  for (const r of rows) {
    const { _r, ...rest } = r;
    text += (k++ > 0 ? ',' : '') + JSON.stringify(rest);
  }
  const tableDone = rows.length < CHUNK_ROWS;
  if (tableDone) text += ']';
  const last = st.idx === BACKUP_TABLES.length - 1 && tableDone;
  if (last) text += '}}';

  const key = `backups/tmp/${date}/${String(st.n).padStart(5, '0')}.gz`;
  const gz = await gzip(text);
  await env.FILES.put(key, gz);
  const next: State = {
    ...st, n: st.n + 1, parts: [...st.parts, { key, size: gz.byteLength }], rows: st.rows + rows.length,
    idx: tableDone ? st.idx + 1 : st.idx, lastRowid: tableDone ? null : rows[rows.length - 1]._r, rowsInTable: tableDone ? 0 : k,
  };
  // compare-and-set so two overlapping runs (cron + button) never both advance the same step
  const upd = await env.DB.prepare("UPDATE backup_jobs SET state = ?, updated_at = ? WHERE id = ? AND status = 'running' AND json_extract(state, '$.n') = ?").bind(JSON.stringify(next), stamp, date, st.n).run();
  if (!upd.meta.changes) return { status: 'running', date, step: st.n, of: BACKUP_TABLES.length };
  if (!last) return { status: 'running', date, step: next.n, of: BACKUP_TABLES.length };

  const finalKey = await finalize(env, date, next);
  await env.DB.prepare("UPDATE backup_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(nowISO(), date).run();
  return { status: 'done', date, key: finalKey };
}

async function finalize(env: Env, date: string, st: State): Promise<string> {
  const total = st.parts.reduce((s, p) => s + p.size, 0);
  const finalKey = `backups/${date}.json.gz`;
  const { readable, writable } = new FixedLengthStream(total);
  const put = env.FILES.put(finalKey, readable, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { rows: String(st.rows), createdAt: st.createdAt } });
  for (const p of st.parts) {
    const o = await env.FILES.get(p.key);
    if (!o) throw new Error('Backup piece missing: ' + p.key);
    await o.body.pipeTo(writable, { preventClose: true });
  }
  await writable.close();
  await put;
  for (const p of st.parts) await env.FILES.delete(p.key);
  await pruneBackups(env);
  return finalKey;
}

export async function listBackups(env: Env) {
  const out: { date: string; name: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const r = await env.FILES.list({ prefix: 'backups/', cursor });
    for (const o of r.objects) {
      const m = FILE_RE.exec(o.key);
      if (m) out.push({ date: m[1], name: `gema-fleet-${m[1]}.json.gz`, size: o.size, uploaded: o.uploaded.toISOString() });
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function pruneBackups(env: Env) {
  const all = await listBackups(env);
  const old = all.slice(KEEP_BACKUPS);
  for (const b of old) await env.FILES.delete(`backups/${b.date}.json.gz`);
  return old.length;
}
