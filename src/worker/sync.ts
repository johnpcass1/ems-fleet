import { SPECS, FULL_COLLS, DISPATCH_COLLS, redactForDispatch } from './docs';
import type { Actor } from '../shared/perm';

/**
 * Incremental sync. The browser sends the cursor it last saw; the Worker returns only rows whose `seq`
 * is newer, plus tombstones for deleted rows. When nothing changed this is a single one-row read.
 */
export async function syncSince(db: D1Database, actor: Actor, sinceRaw: number) {
  const colls = actor.role === 'dispatcher' ? DISPATCH_COLLS : FULL_COLLS;
  const cur = await db.prepare('SELECT v FROM counter WHERE id = 1').first<{ v: number }>();
  const cursor = cur?.v ?? 0;
  let since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  // The database was restored from an older backup: the browser is "ahead". Send everything again.
  const resync = since > cursor;
  if (resync) since = 0;
  const full = since === 0;
  if (!full && since === cursor) return { cursor, full: false, data: {} as Record<string, any[]>, deleted: {} as Record<string, string[]> };

  const stmts: D1PreparedStatement[] = colls.map((c) => {
    const s = SPECS[c];
    return db.prepare(`${s.select} WHERE X.seq > ? AND X.seq <= ?`).bind(since, cursor);
  });
  if (!full) stmts.push(db.prepare('SELECT coll, id FROM tombstones WHERE seq > ? AND seq <= ?').bind(since, cursor));
  const res = await db.batch(stmts);
  const data: Record<string, any[]> = {};
  colls.forEach((c, i) => {
    let docs = (res[i].results || []).map(SPECS[c].map);
    if (actor.role === 'dispatcher') docs = docs.map((d) => redactForDispatch(c, d));
    if (full || docs.length) data[c] = docs;
  });
  const deleted: Record<string, string[]> = {};
  if (!full) for (const t of (res[colls.length].results || []) as any[]) (deleted[t.coll] = deleted[t.coll] || []).push(t.id);
  return { cursor, full, data, deleted };
}
