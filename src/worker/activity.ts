/**
 * Activity history (read side of audit_log): filters, newest-first cursor paging, actor names resolved from the users table, CSV export.
 * Who may call it is decided in index.ts (super user or system administrator). Nothing here writes.
 */
import { z } from 'zod';
import type { Env } from './env';
import { isSuperuserEmail } from './env';
import { all } from './db';
import { bad, zDate } from './http';
import { ACTIVITY_CSV_HEADER, CATEGORY_KEYS, NO_LOOKUP, activityCsvRow, categoryOf, gyDayEndISO, gyDayStartISO, rulesFor, sanitizeAudit, type Lookup } from '../shared/activity';
import { gyDate, toCsv } from '../shared/pure';

export const PAGE_SIZE = 50;
export const EXPORT_MAX = 5000;

const filterIn = z.object({
  userId: z.string().trim().max(80).optional(),
  type: z.string().trim().max(40).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(120).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  q: z.string().trim().max(100).optional(),
});
const blank = (v: string | null) => (v == null || v.trim() === '' ? undefined : v);
const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** The WHERE clause for the filters in the query string. Dates are Guyana calendar days (UTC-4), both ends included. */
function whereFor(sp: URLSearchParams) {
  const f = filterIn.safeParse(Object.fromEntries(['userId', 'type', 'entityType', 'entityId', 'from', 'to', 'q'].map((k) => [k, blank(sp.get(k))])));
  if (!f.success) { const i = f.error.issues[0]; throw bad(`${i.path.join('.')}: ${i.message}`); }
  const i = f.data;
  const w: string[] = [], p: unknown[] = [];
  let joinNames = false;
  if (i.userId) { w.push('a.user_id = ?'); p.push(i.userId); }
  if (i.type) {
    if (!CATEGORY_KEYS.includes(i.type)) throw bad('Unknown type.');
    w.push('(' + rulesFor(i.type).map((r) => { p.push(r.prefix + '%'); if (r.entityType) { p.push(r.entityType); return '(a.action LIKE ? AND a.entity_type = ?)'; } return 'a.action LIKE ?'; }).join(' OR ') + ')');
  }
  if (i.entityId && !i.entityType) throw bad('entityId needs entityType.');
  if (i.entityType) { w.push('a.entity_type = ?'); p.push(i.entityType); }
  if (i.entityId) { w.push('a.entity_id = ?'); p.push(i.entityId); }
  if (i.from && i.to && i.from > i.to) throw bad('The From date is after the To date.');
  if (i.from) { w.push('a.at >= ?'); p.push(gyDayStartISO(i.from)); }
  if (i.to) { w.push('a.at < ?'); p.push(gyDayEndISO(i.to)); }
  if (i.q) {
    const like = '%' + escLike(i.q) + '%';
    joinNames = true;
    w.push("(a.action LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR a.user_email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR v.unit LIKE ? ESCAPE '\\' OR wo.number LIKE ? ESCAPE '\\')");
    p.push(like, like, like, like, like, like, like);
  }
  return { w, p, joinNames };
}

const SELECT = `SELECT a.id, a.at, a.user_id, a.user_email, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json,
  u.name AS u_name, u.email AS u_email, u.role AS u_role, u.active AS u_active
  FROM audit_log a LEFT JOIN users u ON u.id = a.user_id`;
const JOIN_ITEMS = " LEFT JOIN vehicles v ON a.entity_type = 'vehicle' AND v.id = a.entity_id LEFT JOIN work_orders wo ON a.entity_type = 'work_order' AND wo.id = a.entity_id";

const parseJson = (s: string | null) => { if (!s) return null; try { return sanitizeAudit(JSON.parse(s)); } catch { return null; } };

export interface ActivityRow {
  id: number; at: string; action: string; category: string; entityType: string; entityId: string | null;
  before: any; after: any; email: string | null;
  actor: { id: string; name: string | null; email: string | null; role: string | null; active: boolean; isSuper: boolean } | null;
}
function shape(env: Env, r: any): ActivityRow {
  // The CURRENT name (people get renamed or deactivated); if the account is gone, the stored id.
  const actor = r.user_id ? { id: r.user_id, name: r.u_name ?? r.user_id, email: r.u_email ?? r.user_email ?? null, role: r.u_role ?? null, active: r.u_active == null ? false : !!r.u_active, isSuper: isSuperuserEmail(env, r.u_email ?? r.user_email) } : null;
  return { id: r.id, at: r.at, action: r.action, category: categoryOf(r.action, r.entity_type), entityType: r.entity_type, entityId: r.entity_id, before: parseJson(r.before_json), after: parseJson(r.after_json), email: r.user_email ?? null, actor };
}

async function fetchRows(env: Env, sp: URLSearchParams, limit: number, cursor: boolean) {
  const { w, p, joinNames } = whereFor(sp);
  if (cursor) {
    const b = blank(sp.get('before'));
    if (b !== undefined) {
      if (!/^\d{1,15}$/.test(b)) throw bad('before must be an activity id.');
      const at = await all<{ at: string }>(env.DB, 'SELECT at FROM audit_log WHERE id = ?', Number(b));
      if (!at.length) throw bad('before: unknown activity id.');
      w.push('(a.at < ? OR (a.at = ? AND a.id < ?))');
      p.push(at[0].at, at[0].at, Number(b));
    }
  }
  const sql = `${SELECT}${joinNames ? JOIN_ITEMS : ''}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY a.at DESC, a.id DESC LIMIT ?`;
  return all<any>(env.DB, sql, ...p, limit);
}

/** GET /api/admin/activity: one page, newest first. `before=<id of the last row you have>` gets the next page. */
export async function listActivity(env: Env, sp: URLSearchParams) {
  const lim = Math.min(200, Math.max(1, Number(sp.get('limit') || PAGE_SIZE) || PAGE_SIZE));
  const rows = await fetchRows(env, sp, lim + 1, true);
  const more = rows.length > lim;
  const page = rows.slice(0, lim).map((r) => shape(env, r));
  return { rows: page, hasMore: more, nextBefore: more && page.length ? page[page.length - 1].id : null };
}

/* ---------- CSV ---------- */
const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
async function byIds(env: Env, table: string, cols: string, ids: string[]) {
  const out: any[] = [];
  for (const c of chunk([...new Set(ids)], 80)) out.push(...(await all<any>(env.DB, `SELECT ${cols} FROM ${table} WHERE id IN (${c.map(() => '?').join(',')})`, ...c)));
  return out;
}
/** Names for the sentences in the export, read with a handful of queries (small tables whole; work orders and problems only the ones the rows mention). */
async function lookupFor(env: Env, rows: ActivityRow[]): Promise<Lookup> {
  const [bases, vehicles, users, mechanics, parts] = await Promise.all([
    all<any>(env.DB, 'SELECT id, name FROM bases'), all<any>(env.DB, 'SELECT id, unit FROM vehicles'), all<any>(env.DB, 'SELECT id, name FROM users'),
    all<any>(env.DB, 'SELECT id, name FROM mechanics'), all<any>(env.DB, 'SELECT id, number FROM parts'),
  ]);
  const wos = await byIds(env, 'work_orders', 'id, number', rows.filter((r) => r.entityType === 'work_order' && r.entityId).map((r) => r.entityId!));
  const issues = await byIds(env, 'issues', 'id, title, vehicle_id', rows.filter((r) => (r.entityType === 'issue') && r.entityId).map((r) => r.entityId!));
  const m = (xs: any[], f: (x: any) => any) => new Map(xs.map((x) => [x.id, f(x)]));
  const B = m(bases, (x) => x.name), V = m(vehicles, (x) => x.unit), U = m(users, (x) => x.name), M = m(mechanics, (x) => x.name), P = m(parts, (x) => x.number), W = m(wos, (x) => x.number), I = m(issues, (x) => ({ title: x.title, vehicleId: x.vehicle_id }));
  return { ...NO_LOOKUP, base: (id) => B.get(id) ?? null, unit: (id) => V.get(id) ?? null, person: (id) => U.get(id) ?? null, mechanic: (id) => M.get(id) ?? null, part: (id) => P.get(id) ?? null, wo: (id) => W.get(id) ?? null, issue: (id) => I.get(id) ?? null };
}

/** GET /api/admin/activity/export: the same filters, up to EXPORT_MAX rows (newest first), as CSV. */
export async function activityCsv(env: Env, sp: URLSearchParams) {
  const raw = await fetchRows(env, sp, EXPORT_MAX + 1, false);
  const truncated = raw.length > EXPORT_MAX;
  const rows = raw.slice(0, EXPORT_MAX).map((r) => shape(env, r));
  const L = await lookupFor(env, rows);
  const body = '﻿' + toCsv([ACTIVITY_CSV_HEADER, ...rows.map((r) => activityCsvRow(r, L))]);
  return { body, rows: rows.length, truncated, date: gyDate(Date.now()) };
}
