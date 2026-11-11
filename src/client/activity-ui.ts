/**
 * Activity history (super user and system administrators): who changed what, and when.
 * Reads GET /api/admin/activity (newest first, 50 at a time) and turns each row into a plain-English sentence with src/shared/activity.ts.
 */
import { ROLES } from '../shared/constants';
import { ACTIVITY_CATEGORIES, categoryLabel, describe, diffFields, dayLabel, dmyHM, timeHM, truncate, type FieldChange, type Lookup, type Seg } from '../shared/activity';
import { gyDate } from '../shared/pure';
import { D, S, can, ui, saveUi, scheduleRender, agencySettings } from './state';
import { esc, selHtml, toast, saveBlob, todayStr } from './util';
import { VIEWS } from './registry';
import { pageHead, emptyState } from './bits';
import { icon } from './icons';
import { api, apiFile } from './api';
import { go, canSeeActivity } from './nav';

interface Row {
  id: number; at: string; action: string; category: string; entityType: string; entityId: string | null; before: any; after: any; email: string | null;
  actor: { id: string; name: string | null; email: string | null; role: string | null; active: boolean; isSuper: boolean } | null;
  _d?: FieldChange[];
}
const BLANK = { q: '', userId: '', type: '', from: '', to: '', entityType: '', entityId: '' };
const STALE_MS = 5 * 60e3;
/** The list on screen. Kept while you look at a unit and come Back, so the page is where you left it. */
const st = { rows: [] as Row[], hasMore: false, next: null as number | null, loading: false, loadingMore: false, err: '', sig: '', at: 0, token: 0, open: new Set<number>(), shown: new Set<string>(), filtersOpen: false, exporting: false };
const F = (): typeof BLANK => ui.f.activity;
const sigOf = () => JSON.stringify(F());

const L: Lookup = {
  unit: (id) => D.vehicles[id]?.unit ?? null,
  wo: (id) => D.workOrders[id]?.number ?? null,
  base: (id) => D.bases[id]?.name ?? null,
  person: (id) => D.people[id]?.name ?? null,
  mechanic: (id) => D.mechanics[id]?.name ?? null,
  part: (id) => D.parts[id]?.number ?? null,
  issue: (id) => (D.issues[id] ? { title: D.issues[id].title, vehicleId: D.issues[id].vehicleId ?? null } : null),
  get currency() { return agencySettings().currency; },
};

function qs(extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(F())) if (v) p.set(k, v as string);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
async function load(more: boolean) {
  const token = ++st.token;
  if (more) st.loadingMore = true; else { st.loading = true; st.sig = sigOf(); st.err = ''; }
  try {
    const r = await api<{ rows: Row[]; hasMore: boolean; nextBefore: number | null }>('GET', '/admin/activity?' + qs(more && st.next ? { before: String(st.next) } : {}), undefined, { quiet: true });
    if (token !== st.token) return;
    st.rows = more ? [...st.rows, ...r.rows] : r.rows;
    if (!more) { st.open.clear(); st.shown.clear(); }
    st.hasMore = r.hasMore; st.next = r.nextBefore; st.at = Date.now();
  } catch (e: any) {
    if (token !== st.token) return;
    st.err = e.message || 'Could not load the activity.';
    if (!more) st.at = Date.now();
  }
  st.loading = false; st.loadingMore = false;
  scheduleRender();
}
/** Re-read from the first page with the current filters. */
function reload() { st.sig = ''; st.next = null; scheduleRender(); }

/* ---------- drawing ---------- */
const segHtml = (s: Seg) => {
  if (s.k === 't' || !s.id) return esc(s.v);
  if (s.k === 'unit') return `<button type="button" class="ulink" data-act="open-vehicle" data-id="${esc(s.id)}">${esc(s.v)}</button>`;
  if (s.k === 'wo') return `<button type="button" class="ulink" data-act="open-wo" data-id="${esc(s.id)}">${esc(s.v)}</button>`;
  return can('users') ? `<button type="button" class="btn link" data-act="activity-user" data-id="${esc(s.id)}">${esc(s.v)}</button>` : `<b>${esc(s.v)}</b>`;
};
const changes = (r: Row) => (r._d ??= diffFields(r.entityType, r.before, r.after, L));
const who = (r: Row) => {
  const a = r.actor;
  if (!a) return { name: r.action === 'auth.login_failed' ? 'Not signed in' : r.email || 'System', sub: '' };
  const role = a.isSuper ? 'Super user' : a.role ? ROLES[a.role as keyof typeof ROLES] || a.role : '';
  return { name: a.name || a.id, sub: [role, a.active ? '' : 'deactivated'].filter(Boolean).join(' · ') };
};
const valHtml = (text: string, key: string) => {
  const t = truncate(text);
  if (!t.cut) return esc(text);
  return st.shown.has(key) ? `${esc(text)} <button type="button" class="btn link tiny" data-act="activity-showall" data-k="${esc(key)}" id="sa-${esc(key)}">Show less</button>` : `${esc(t.text)} <button type="button" class="btn link tiny" data-act="activity-showall" data-k="${esc(key)}" id="sa-${esc(key)}">Show all</button>`;
};
const diffHtml = (r: Row) => `<div class="actdiff" id="ad-${r.id}"><h4>What changed</h4><div class="tscroll"><table class="t"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
  ${changes(r).map((c, i) => `<tr><td class="fl">${esc(c.label)}</td><td>${valHtml(c.from, `${r.id}-${i}-b`)}</td><td><span class="arr" aria-hidden="true">→</span>${valHtml(c.to, `${r.id}-${i}-a`)}</td></tr>`).join('')}</tbody></table></div></div>`;
function rowHtml(r: Row) {
  const w = who(r), ch = changes(r), open = st.open.has(r.id) && ch.length > 0;
  const bad = r.action === 'auth.login_failed' || r.action === 'auth.locked';
  return `<li class="actrow${open ? ' open' : ''}" id="ar-${r.id}" data-cat="${esc(r.category)}">
    <time class="at-t" datetime="${esc(r.at)}" title="${esc(dmyHM(r.at))}">${timeHM(r.at)}</time>
    <div class="at-who"><b>${esc(w.name)}</b>${w.sub ? `<span class="tiny muted">${esc(w.sub)}</span>` : ''}</div>
    <div class="at-what">${describe(r, L).map(segHtml).join('')}${bad ? ' <span class="badge bad">Failed</span>' : ''}</div>
    ${ch.length ? `<button type="button" class="btn sm ghost at-x" data-act="activity-toggle" data-id="${r.id}" id="ax-${r.id}" aria-expanded="${open}" aria-controls="ad-${r.id}" aria-label="What changed: ${esc(describe(r, L).map((s) => s.v).join(''))}">${icon(open ? 'down' : 'right')}<span class="lbl">What changed</span></button>` : '<span class="at-x"></span>'}
    ${open ? diffHtml(r) : ''}</li>`;
}
function entityLabel() {
  const f = F();
  if (!f.entityType) return '';
  const name = f.entityType === 'vehicle' ? L.unit(f.entityId) : f.entityType === 'work_order' ? L.wo(f.entityId) : f.entityType === 'user' ? L.person(f.entityId) : null;
  return name || `${f.entityType.replace(/_/g, ' ')}${f.entityId ? ' ' + f.entityId : ''}`;
}
const filterCount = () => (['userId', 'type', 'from', 'to'] as const).filter((k) => F()[k]).length + (F().entityType ? 1 : 0);

function toolbar() {
  const f = F();
  const people = Object.values(D.people).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  const popts: string[][] = [['', 'Everyone'], ...people.map((p: any) => [p.id, p.name])];
  if (f.userId && !D.people[f.userId]) popts.push([f.userId, f.userId]);
  const n = filterCount();
  return `<div class="filters actbar" id="actFilters" role="search">
    <div class="f2 q"><label for="act-q">Search activity</label><span class="srch">${icon('search')}<input id="act-q" name="act-q" type="search" value="${esc(f.q)}" placeholder="Search: name, unit, work order, action" autocomplete="off" maxlength="100"></span></div>
    <button type="button" class="btn actfbtn" data-act="activity-filters" id="actFiltersBtn" aria-expanded="${st.filtersOpen}" aria-controls="actMore">${icon('filter')}Filters${n ? ` <span class="badge acc">${n}</span>` : ''}</button>
    <div class="actmore${st.filtersOpen ? ' open' : ''}" id="actMore">
      <div class="f2"><label for="act-user">Person</label>${selHtml('act-user', popts, f.userId, 'data-actf="userId"')}</div>
      <div class="f2"><label for="act-type">Type</label>${selHtml('act-type', [['', 'All types'], ...ACTIVITY_CATEGORIES.map((c) => [c.key, c.label])], f.type, 'data-actf="type"')}</div>
      <div class="dtpair"><div class="dt"><span class="tiny muted" id="act-from-l">From</span><input type="date" id="act-from" name="act-from" value="${esc(f.from)}" max="${esc(f.to)}" data-actf="from" aria-labelledby="act-from-l"></div>
      <div class="dt"><span class="tiny muted" id="act-to-l">To</span><input type="date" id="act-to" name="act-to" value="${esc(f.to)}" min="${esc(f.from)}" data-actf="to" aria-labelledby="act-to-l"></div></div>
    </div>
    <button type="button" class="btn" data-act="activity-export" id="actExport"${st.exporting ? ' disabled' : ''}>${icon('download')}<span class="lbl">Export CSV</span></button>
  </div>
  ${f.entityType ? `<div class="row actchips"><span class="chip acc" id="actEntity">Showing activity for ${esc(entityLabel())}<button type="button" class="iconbtn chipx" data-act="activity-clear-entity" id="actEntityClear" aria-label="Show all activity">${icon('x')}</button></span></div>` : ''}`;
}

VIEWS.activity = function () {
  if (!canSeeActivity()) return '<div class="warnbox bad">You do not have access to this page.</div>';
  if (st.sig !== sigOf() || (!st.loading && !st.err && Date.now() - st.at > STALE_MS)) load(false);
  const today = todayStr();
  const groups: [string, Row[]][] = [];
  for (const r of st.rows) {
    const d = gyDate(Date.parse(r.at));
    const g = groups[groups.length - 1];
    if (g && g[0] === d) g[1].push(r); else groups.push([d, [r]]);
  }
  const filtered = filterCount() > 0 || !!F().q;
  let body: string;
  if (st.err && !st.rows.length) body = `<div class="warnbox bad" role="alert">${esc(st.err)} <button type="button" class="btn sm" data-act="activity-refresh" id="actRetry">Try again</button></div>`;
  else if (!st.rows.length && (st.loading || st.sig !== sigOf())) body = '<p class="muted" role="status">Loading activity...</p>';
  else if (!st.rows.length) body = `<div class="panel">${emptyState('inbox', filtered ? 'No activity found' : 'No activity yet', filtered ? 'Nothing matches these filters. Try a wider date range, another person or a different search.' : 'Changes people make will be listed here.', filtered ? '<button type="button" class="btn" data-act="activity-clear" id="actClear">Clear filters</button>' : '')}</div>`;
  else body = `<div class="panel" id="actPanel"><div class="pn small muted" role="status" aria-live="polite">${st.rows.length} ${st.rows.length === 1 ? 'change' : 'changes'} shown, newest first${st.loading ? ' (updating...)' : ''}. Times are Guyana time.</div>
    ${groups.map(([d, rs]) => `<section class="actgrp" aria-label="${esc(dayLabel(d, today))}"><h3 class="actday">${esc(dayLabel(d, today))}</h3><ul class="actlist">${rs.map(rowHtml).join('')}</ul></section>`).join('')}
    ${st.err ? `<div class="warnbox bad" role="alert" style="margin:12px">${esc(st.err)}</div>` : ''}
    ${st.hasMore ? `<div class="actmore-row"><button type="button" class="btn" data-act="activity-more" id="actMoreBtn"${st.loadingMore || st.loading ? ' disabled' : ''}>${st.loadingMore ? 'Loading...' : 'Load more'}</button></div>` : '<div class="pn small muted actend">That is everything for these filters.</div>'}</div>`;
  return `${pageHead('Activity history', { sub: 'Who changed what, and when. Only the super user and system administrators can see this page.' })}${toolbar()}${body}`;
};

/* ---------- actions ---------- */
export const activityActs: Record<string, any> = {
  'activity-toggle': (el: HTMLElement) => { const id = Number(el.dataset.id); if (st.open.has(id)) st.open.delete(id); else st.open.add(id); scheduleRender(); },
  'activity-showall': (el: HTMLElement) => { const k = el.dataset.k!; if (st.shown.has(k)) st.shown.delete(k); else st.shown.add(k); scheduleRender(); },
  'activity-more': () => { if (!st.loadingMore && !st.loading && st.hasMore) { load(true); scheduleRender(); } },
  'activity-refresh': () => reload(),
  'activity-filters': () => { st.filtersOpen = !st.filtersOpen; scheduleRender(); },
  'activity-clear': () => { ui.f.activity = { ...BLANK }; saveUi(); reload(); },
  'activity-clear-entity': () => { F().entityType = ''; F().entityId = ''; saveUi(); reload(); },
  'activity-user': () => go('users'),
  /** "View activity for this person / unit" from the Users screen and the unit History tab. */
  'activity-for': (el: HTMLElement) => {
    const type = el.dataset.type!, id = el.dataset.id!;
    ui.f.activity = type === 'user' ? { ...BLANK, userId: id } : { ...BLANK, entityType: type, entityId: id };
    saveUi(); st.rows = []; st.sig = ''; st.next = null; st.err = '';
    go('activity');
  },
  'activity-export': async () => {
    if (st.exporting) return;
    st.exporting = true; scheduleRender();
    try {
      const { blob, headers } = await apiFile('/admin/activity/export?' + qs());
      saveBlob(`gema-fleet-activity-${todayStr()}.csv`, blob);
      const n = Number(headers.get('X-Activity-Rows') || 0);
      toast(headers.get('X-Activity-Truncated') === '1' ? `Exported the newest ${n.toLocaleString('en-US')} changes (the export limit). Narrow the dates to get the rest.` : `Exported ${n.toLocaleString('en-US')} ${n === 1 ? 'change' : 'changes'}`);
    } catch (e: any) { toast(e?.message || 'Could not export. Please try again.', true); }
    st.exporting = false; scheduleRender();
  },
};

/* ---------- toolbar events (own listeners: filters here reload from the server) ---------- */
let timer: any = null;
document.addEventListener('input', (e: any) => {
  const el = e.target;
  if (!el || el.id !== 'act-q') return;
  F().q = el.value; saveUi();
  clearTimeout(timer);
  timer = setTimeout(reload, 300);
});
document.addEventListener('change', (e: any) => {
  const el = e.target, k = el && el.dataset && el.dataset.actf;
  if (!k) return;
  (F() as any)[k] = el.value;
  // keep the range sensible: moving From past To (or To before From) moves the other end with it
  if (k === 'from' && el.value && F().to && el.value > F().to) F().to = el.value;
  if (k === 'to' && el.value && F().from && el.value < F().from) F().from = el.value;
  saveUi(); reload();
});
/** Opening the page from the sidebar always shows fresh data. */
document.addEventListener('click', (e: any) => { if (e.target.closest && e.target.closest('#nav a[data-r="activity"]')) { st.at = 0; st.err = ''; } }, true);
/** A new login must not see the previous person's list. */
export const resetActivity = () => { st.rows = []; st.sig = ''; st.at = 0; st.err = ''; st.hasMore = false; st.open.clear(); st.shown.clear(); st.token++; };
void S;
