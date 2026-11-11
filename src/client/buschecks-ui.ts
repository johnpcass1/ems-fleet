/**
 * Bus checks (Admin): who has done the start-of-shift check, what was short, the history of checks, and the requirement lists.
 * Reads GET /api/bus-checks/today, /shortages and /bus-checks (paged). The server limits a base supervisor to their own bases; this page only draws what it is sent.
 */
import { SEV, ISSUE_ST } from '../shared/constants';
import { dmy, dmyHM, timeHM } from '../shared/activity';
import { addDays } from '../shared/pure';
import { RESTOCK_NOTE_MAX, flatItems, type BusAnswer, type BusItem } from '../shared/buscheck';
import { D, can, scheduleRender, vehiclesSorted, basesSorted, baseName } from './state';
import { esc, num, toast, selHtml, saveBlob, todayStr, fmtDate } from './util';
import { VIEWS, VT } from './registry';
import { pageHead, emptyState, pill, statusPill } from './bits';
import { icon } from './icons';
import { api, apiFile } from './api';
import { showDrawer, confirmUI, confirmNote } from './dom';
import { reqTab, requirementsActs, resetRequirements } from './busreq-ui';

type Tab = 'today' | 'equipment' | 'shortages' | 'history' | 'requirements';
const STALE_MS = 30e3;
interface Slot { data: any; sig: string; at: number; loading: boolean; err: string; token: number }
const slot = (): Slot => ({ data: null, sig: '', at: 0, loading: false, err: '', token: 0 });
const rs = {
  tab: '' as Tab | '', date: '', from: '', to: '',
  today: slot(), short: slot(), eq: slot(), eqF: { baseId: '', vehicleId: '' }, eqRecent: false, restocking: false,
  hist: { rows: [] as any[], hasMore: false, next: null as string | null, sig: '', at: 0, loading: false, loadingMore: false, err: '', token: 0, f: { vehicleId: '', baseId: '', userId: '', from: '', to: '', shortages: false } },
  unit: {} as Record<string, { rows: any[]; at: number; loading: boolean; err: string }>,
  unitEq: {} as Record<string, { rows: any[]; at: number; loading: boolean; err: string }>,
  exporting: false, opening: false,
};
export const canReports = () => can('busCheckReports');
/** The Equipment tab: the reports right (a supervisor's reaches only their bases) or the right to mark equipment restocked. */
export const canEquipment = () => can('busCheckReports') || can('busCheckRestock');
export const canBusScreen = () => can('busCheckReports') || can('busCheckRestock') || can('busCheckEdit');
/** Today, Equipment, Shortage report, History, Requirements. */
const tabs = (): [Tab, string][] => [
  ...(canReports() ? [['today', 'Today'] as [Tab, string]] : []), ...(canEquipment() ? [['equipment', 'Equipment'] as [Tab, string]] : []),
  ...(canReports() ? [['shortages', 'Shortage report'], ['history', 'History']] as [Tab, string][] : []), ...(can('busCheckEdit') ? [['requirements', 'Requirements'] as [Tab, string]] : []),
];
const curTab = (): Tab => { const t = tabs(); return (t.find(([k]) => k === rs.tab) ? rs.tab : t[0]?.[0]) as Tab; };

/** Show fresh numbers whenever someone opens this screen or a tab (crews may have sent checks since it was last loaded). */
function markStale() { rs.today.at = 0; rs.short.at = 0; rs.eq.at = 0; rs.hist.at = 0; rs.unit = {}; rs.unitEq = {}; }
window.addEventListener('hashchange', () => { if (/^#(buschecks|vehicle)$/.test(location.hash)) markStale(); });

export function resetBusChecks() {
  rs.tab = ''; rs.date = ''; rs.from = ''; rs.to = ''; rs.today = slot(); rs.short = slot(); rs.eq = slot(); rs.eqF = { baseId: '', vehicleId: '' }; rs.eqRecent = false; rs.restocking = false; rs.unit = {}; rs.unitEq = {};
  rs.hist.rows = []; rs.hist.sig = ''; rs.hist.at = 0; rs.hist.err = ''; rs.hist.hasMore = false; rs.hist.token++; rs.hist.f = { vehicleId: '', baseId: '', userId: '', from: '', to: '', shortages: false };
  resetRequirements();
}

/* ---------- loading ---------- */
async function ensure(s: Slot, sig: string, path: string) {
  if (s.loading && s.sig === sig) return;
  if (s.sig === sig && (s.err || Date.now() - s.at < STALE_MS)) return;
  const token = ++s.token;
  s.loading = true; s.sig = sig; s.err = '';
  try { const d = await api('GET', path); if (token !== s.token) return; s.data = d; }
  catch (e: any) { if (token !== s.token) return; s.err = e?.message || 'Could not load this page.'; s.data = null; }
  s.at = Date.now(); s.loading = false;
  scheduleRender();
}
const retry = (s: Slot) => { s.sig = ''; s.err = ''; scheduleRender(); };
const qs = (o: Record<string, string>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const t = p.toString(); return t ? '?' + t : ''; };
const histQs = (extra: Record<string, string> = {}) => { const f = rs.hist.f; return qs({ vehicleId: f.vehicleId, baseId: f.baseId, userId: f.userId, from: f.from, to: f.to, shortages: f.shortages ? '1' : '', ...extra }); };
async function loadHistory(more: boolean) {
  const h = rs.hist, token = ++h.token;
  if (more) h.loadingMore = true; else { h.loading = true; h.sig = histQs(); h.err = ''; }
  try {
    const r = await api('GET', '/bus-checks' + histQs(more && h.next ? { before: h.next } : {}));
    if (token !== h.token) return;
    h.rows = more ? [...h.rows, ...r.rows] : r.rows; h.hasMore = r.hasMore; h.next = r.nextBefore; h.at = Date.now();
  } catch (e: any) { if (token !== h.token) return; h.err = e?.message || 'Could not load the checks.'; if (!more) h.at = Date.now(); }
  h.loading = false; h.loadingMore = false; scheduleRender();
}

/* ---------- Today ---------- */
function cellHtml(c: any) {
  switch (c.state) {
    case 'checked': {
      const k = c.check;
      return `<button type="button" class="bccell ok" data-act="bc-open" data-id="${esc(k.id)}" id="bcc-${esc(k.id)}" aria-label="Open the bus check by ${esc(k.by)} at ${timeHM(k.at)}">
        <span class="bcc-t">${icon('check')}${timeHM(k.at)}</span><span class="tiny">${esc(k.by || 'Unknown')}</span>${k.shortages ? `<span class="badge bad">${k.shortages} short</span>` : '<span class="tiny">No shortages</span>'}${k.count > 1 ? `<span class="tiny muted">${k.count} checks</span>` : ''}</button>`;
    }
    case 'missed': return '<span class="badge bad">Missed</span>';
    case 'due': return '<span class="badge warn">Due</span>';
    case 'upcoming': return '<span class="tiny muted">Not started</span>';
    default: return `<span class="tiny muted">Not expected</span><span class="tiny muted bcreason">${esc(c.reason || '')}</span>`;
  }
}
function todayTab() {
  const date = rs.date || todayStr();
  ensure(rs.today, date, '/bus-checks/today' + qs({ date }));
  const s = rs.today, d = s.data;
  const picker = `<div class="filters" id="bcDateBar"><div class="row tight"><button type="button" class="btn" data-act="bc-day" data-d="-1" id="bcPrev" aria-label="Previous day">${icon('left')}</button>
    <div class="dt"><span class="tiny muted" id="bc-date-l">Date</span><input type="date" id="bc-date" name="bc-date" value="${esc(date)}" data-bcf="date" aria-labelledby="bc-date-l"></div>
    <button type="button" class="btn" data-act="bc-day" data-d="1" id="bcNext" aria-label="Next day">${icon('right')}</button>
    ${date !== todayStr() ? '<button type="button" class="btn sm" data-act="bc-day" data-d="0" id="bcToday">Today</button>' : ''}</div></div>`;
  if (s.err && !d) return `${picker}<div class="warnbox bad" role="alert">${esc(s.err)} <button type="button" class="btn sm" data-act="bc-retry" data-w="today" id="bcRetry">Try again</button></div>`;
  if (!d) return `${picker}<p class="muted" role="status">Loading...</p>`;
  const t = d.totals;
  const kpi = (k: string, v: any, cls = '') => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const head = `<div class="panel"><div class="kpis bckpis" id="bcKpis">${kpi('Checks done', t.checked)}${kpi('Missed', t.missed, t.missed ? 'bad' : '')}${kpi('With shortages', t.withShortages, t.withShortages ? 'warn' : '')}${t.due ? kpi('Due now', t.due) : ''}</div></div>`;
  if (!d.bases.length) return `${picker}${head}<div class="panel">${emptyState('vehicles', 'No units to show', 'There are no units in the bases you can see.')}</div>`;
  const shiftHead = d.shifts.map((sh: any) => `<th scope="col">${esc(sh.label)} shift${sh.state === 'current' ? ' <span class="badge acc">Now</span>' : ''}</th>`).join('');
  return `${picker}${head}<p class="small muted">Times are Guyana time. A check counts for a shift from one hour before the shift starts until one hour before the next one.</p>
    ${d.bases.map((b: any) => `<div class="panel bcbase"><div class="ph"><h2>${esc(b.name)}</h2><span class="muted small">${b.units.length} ${b.units.length === 1 ? 'unit' : 'units'}</span></div>
      <div class="tscroll"><table class="t bctable"><thead><tr><th scope="col">Unit</th>${shiftHead}</tr></thead><tbody>${b.units.map((u: any) => `<tr><th scope="row" class="bcunit"><button type="button" class="ulink" data-act="open-vehicle" data-id="${esc(u.vehicleId)}">${esc(u.unit)}</button><div class="tiny muted">${statusPill(u.status)}</div></th>${u.cells.map((c: any) => `<td data-state="${c.state}">${cellHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('')}`;
}

/* ---------- Equipment (open shortages found by checks) ---------- */
const eqCan = (vehicleId: string) => can('busCheckRestock', D.vehicles[vehicleId]);
const eqUnits = () => vehiclesSorted().filter((v: any) => can('busCheckReports', v) || can('busCheckRestock', v));
const eqQs = () => qs({ recent: '1', baseId: rs.eqF.baseId, vehicleId: rs.eqF.vehicleId });
const lastCheckHtml = (r: any) => (r.lastCheckId && can('busCheckReports') ? `<button type="button" class="btn link" data-act="bc-open" data-id="${esc(r.lastCheckId)}" id="eql-${esc(r.id)}">${esc(dmyHM(r.lastAt))}</button>` : esc(dmyHM(r.lastAt)));
/** The open shortages of one unit as a table; `restock` adds the Mark restocked button where the person may use it. */
function shortageTable(rows: any[], id: string) {
  const any = rows.some((r) => eqCan(r.vehicleId));
  return `<div class="tscroll"><table class="t eqtable" id="${id}"><thead><tr><th scope="col">Item</th><th scope="col">What was found</th><th scope="col">First found</th><th scope="col" class="n">Checks</th><th scope="col">Last check</th>${any ? '<th scope="col"><span class="sr">Action</span></th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr id="eq-${esc(r.id)}"><td>${r.code ? `<span class="bccode">${esc(r.code)}</span> ` : ''}<b>${esc(r.name)}</b>${r.section ? `<div class="tiny muted">${esc(r.section)}</div>` : ''}</td><td>${esc(r.found)}</td><td data-l="First found">${esc(dmyHM(r.firstAt))}</td><td class="n" data-l="Checks">${r.checks}</td><td data-l="Last check">${lastCheckHtml(r)}</td>${any ? `<td class="eqact">${eqCan(r.vehicleId) ? `<button type="button" class="btn sm" data-act="eq-restock" data-id="${esc(r.id)}" id="eqr-${esc(r.id)}" aria-label="Mark ${esc(r.name)} on ${esc(r.unit)} restocked"${rs.restocking ? ' disabled' : ''}>Mark restocked</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
const eqCount = (n: number) => `${n} ${n === 1 ? 'shortage' : 'shortages'}`;
function equipmentTab() {
  const path = '/bus-checks/equipment' + eqQs();
  ensure(rs.eq, path, path);
  const s = rs.eq, d = s.data, f = rs.eqF;
  const units = eqUnits(), baseIds = new Set(units.map((v: any) => v.baseId));
  const bar = `<div class="filters" id="eqBar" role="search">
    <div class="f2"><label for="eqf-base">Station</label>${selHtml('eqf-base', [['', 'All stations'], ...basesSorted().filter((b: any) => baseIds.has(b.id)).map((b: any) => [b.id, b.name])], f.baseId, 'data-eqf="baseId"')}</div>
    <div class="f2"><label for="eqf-unit">Unit</label>${selHtml('eqf-unit', [['', 'All units'], ...units.filter((v: any) => !f.baseId || v.baseId === f.baseId).map((v: any) => [v.id, v.unit])], f.vehicleId, 'data-eqf="vehicleId"')}</div>
    ${f.baseId || f.vehicleId ? '<button type="button" class="btn sm" data-act="eq-clear" id="eqClear">Clear filters</button>' : ''}
    <button type="button" class="btn" data-act="bc-export" data-w="equipment" id="bcExportE"${rs.exporting ? ' disabled' : ''}>${icon('download')}<span class="lbl">Export CSV</span></button></div>`;
  const intro = '<p class="small muted">Equipment that crews found short, missing, failed or expired in a bus check, until someone restocks it. These are not vehicle problems: they do not go to maintenance and do not change a unit\'s status.</p>';
  if (s.err && !d) return `${intro}${bar}<div class="warnbox bad" role="alert">${esc(s.err)} <button type="button" class="btn sm" data-act="bc-retry" data-w="eq" id="bcRetry">Try again</button></div>`;
  if (!d) return `${intro}${bar}<p class="muted" role="status">Loading...</p>`;
  const groups: { name: string; units: { id: string; unit: string; rows: any[] }[] }[] = [];
  for (const r of d.open) {
    const name = r.base || 'Unassigned';
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, units: [] }));
    let u = g.units.find((x) => x.id === r.vehicleId);
    if (!u) g.units.push((u = { id: r.vehicleId, unit: r.unit, rows: [] }));
    u.rows.push(r);
  }
  const body = !d.open.length
    ? `<div class="panel" id="eqEmpty">${emptyState('check', 'No open equipment shortages', f.baseId || f.vehicleId ? 'Nothing is reported short for these filters.' : 'Nothing is reported short right now.')}</div>`
    : `<p class="small muted" role="status" id="eqCount">${eqCount(d.open.length)} open on ${groups.reduce((n, g) => n + g.units.length, 0)} ${groups.reduce((n, g) => n + g.units.length, 0) === 1 ? 'unit' : 'units'}.</p>` + groups.map((g) => `<div class="panel bcbase"><div class="ph"><h2>${esc(g.name)}</h2><span class="muted small">${eqCount(g.units.reduce((n, u) => n + u.rows.length, 0))}</span></div>
      ${g.units.map((u) => `<div class="equnit" id="equ-${esc(u.id)}"><div class="eqhead"><button type="button" class="ulink" data-act="open-vehicle" data-id="${esc(u.id)}">${esc(u.unit)}</button><span class="muted small">${eqCount(u.rows.length)}</span>
        ${eqCan(u.id) && u.rows.length > 1 ? `<button type="button" class="btn sm" data-act="eq-restock-all" data-id="${esc(u.id)}" id="eqa-${esc(u.id)}"${rs.restocking ? ' disabled' : ''}>Mark all restocked</button>` : ''}</div>${shortageTable(u.rows, 'eqt-' + u.id)}</div>`).join('')}</div>`).join('');
  const rec = d.recent || [];
  const recent = `<div class="panel" id="eqRecentPanel"><div class="ph"><button type="button" class="bctoggle" data-act="eq-recent" id="eqRecentBtn" aria-expanded="${rs.eqRecent}" aria-controls="eqRecentBody">${icon(rs.eqRecent ? 'down' : 'right')}<h2>Restocked recently</h2></button><span class="muted small">${rec.length} in the last ${d.recentDays || 30} days</span></div>
    ${rs.eqRecent ? `<div id="eqRecentBody">${rec.length ? `<div class="tscroll"><table class="t" id="eqRecentTable"><thead><tr><th scope="col">Unit</th><th scope="col">Item</th><th scope="col">What was found</th><th scope="col">Restocked</th><th scope="col">Note</th></tr></thead><tbody>
      ${rec.map((r: any) => `<tr><td class="mono-s">${esc(r.unit)}</td><td>${r.code ? `<span class="bccode">${esc(r.code)}</span> ` : ''}${esc(r.name)}</td><td>${esc(r.found)}</td><td>${esc(dmyHM(r.restockedAt))}<div class="tiny muted">${esc(r.restockedByName || '')}</div></td><td class="small">${esc(r.restockNote)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="pb muted small">Nothing was marked restocked in this time.</div>'}</div>` : ''}</div>`;
  return `${intro}${bar}${body}${recent}`;
}

/** Mark shortages restocked: a small confirm with an optional note, then the server closes them (and writes who, when and the note). */
async function restock(ids: string[], rows: any[], unit: string) {
  if (rs.restocking || !ids.length) return;
  const one = rows.length === 1;
  const ok = await confirmUI({
    title: one ? 'Mark this item restocked?' : `Mark ${rows.length} items restocked on ${unit}?`,
    message: one ? `"${rows[0].name}" on ${unit} will be closed as restocked. Your name and the time are recorded.` : `These will be closed as restocked. Your name and the time are recorded.`,
    list: one ? undefined : rows.map((r) => r.name),
    after: 'If a later bus check finds it short again, it is reported as a new shortage.',
    note: { label: 'Note (optional)', max: RESTOCK_NOTE_MAX }, label: one ? 'Mark restocked' : 'Mark all restocked',
  });
  if (!ok) return;
  const note = confirmNote();
  rs.restocking = true; scheduleRender();
  try {
    await api('POST', '/bus-checks/equipment/restock', { ids, note });
    toast(one ? 'Marked restocked' : `Marked ${rows.length} items restocked`);
  } catch (e: any) { toast(e?.message || 'Could not mark that restocked. Please try again.', true); }
  rs.restocking = false; rs.eq.at = 0; rs.unitEq = {}; scheduleRender();
}

/* ---------- Shortage report ---------- */
function range() { const to = rs.to || todayStr(), from = rs.from || addDays(to, -29); return { from, to }; }
function shortagesTab() {
  const { from, to } = range();
  ensure(rs.short, from + '~' + to, '/bus-checks/shortages' + qs({ from, to }));
  const s = rs.short, d = s.data;
  const bar = `<div class="filters" id="bcRangeBar"><div class="dtpair"><div class="dt"><span class="tiny muted" id="bc-from-l">From</span><input type="date" id="bc-from" name="bc-from" value="${esc(from)}" max="${esc(to)}" data-bcf="from" aria-labelledby="bc-from-l"></div>
    <div class="dt"><span class="tiny muted" id="bc-to-l">To</span><input type="date" id="bc-to" name="bc-to" value="${esc(to)}" min="${esc(from)}" data-bcf="to" aria-labelledby="bc-to-l"></div></div>
    <button type="button" class="btn" data-act="bc-export" data-w="shortages" id="bcExportS"${rs.exporting ? ' disabled' : ''}>${icon('download')}<span class="lbl">Export CSV</span></button></div>`;
  if (s.err && !d) return `${bar}<div class="warnbox bad" role="alert">${esc(s.err)} <button type="button" class="btn sm" data-act="bc-retry" data-w="short" id="bcRetry">Try again</button></div>`;
  if (!d) return `${bar}<p class="muted" role="status">Loading...</p>`;
  if (!d.totals.shortages) return `${bar}<div class="panel">${emptyState('check', 'No shortages', `${d.totals.checks} ${d.totals.checks === 1 ? 'check was' : 'checks were'} done between ${fmtDate(from)} and ${fmtDate(to)} and nothing was short.`)}</div>`;
  return `${bar}<p class="small muted" role="status">${d.totals.checks} checks between ${fmtDate(from)} and ${fmtDate(to)}. ${d.totals.withShortages} had shortages (${d.totals.shortages} in all).</p>
    <div class="panel"><div class="ph"><h2>Items most often short</h2></div><div class="tscroll"><table class="t" id="bcItems"><thead><tr><th>Item</th><th class="n">Times short</th><th class="n">Units</th><th>Last</th></tr></thead><tbody>
    ${d.items.map((i: any) => `<tr><td>${i.code ? `<span class="bccode">${esc(i.code)}</span> ` : ''}${esc(i.name)}</td><td class="n">${i.times}</td><td class="n">${i.units}</td><td>${esc(dmyHM(i.lastAt))}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel"><div class="ph"><h2>By unit</h2></div><div class="tscroll"><table class="t" id="bcUnits"><thead><tr><th>Unit</th><th class="n">Checks with shortages</th><th class="n">Shortages</th><th>Last</th></tr></thead><tbody>
    ${d.units.map((u: any) => `<tr><td><button type="button" class="ulink" data-act="open-vehicle" data-id="${esc(u.vehicleId)}">${esc(u.unit)}</button></td><td class="n">${u.checks}</td><td class="n">${u.shortages}</td><td>${esc(dmyHM(u.lastAt))}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ---------- History ---------- */
const filterCount = () => { const f = rs.hist.f; return [f.vehicleId, f.baseId, f.userId, f.from, f.to, f.shortages].filter(Boolean).length; };
function historyTab() {
  const h = rs.hist, f = h.f, sig = histQs();
  if (h.sig !== sig || (!h.loading && !h.err && Date.now() - h.at > STALE_MS * 5)) loadHistory(false);
  const people = Object.values(D.people).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  const bar = `<div class="filters" id="bcHistBar" role="search">
    <div class="f2"><label for="bch-unit">Unit</label>${selHtml('bch-unit', [['', 'All units'], ...vehiclesSorted().map((v: any) => [v.id, v.unit])], f.vehicleId, 'data-bch="vehicleId"')}</div>
    <div class="f2"><label for="bch-base">Station</label>${selHtml('bch-base', [['', 'All stations'], ...basesSorted().map((b: any) => [b.id, b.name])], f.baseId, 'data-bch="baseId"')}</div>
    <div class="f2"><label for="bch-user">Person</label>${selHtml('bch-user', [['', 'Everyone'], ...people.map((p: any) => [p.id, p.name])], f.userId, 'data-bch="userId"')}</div>
    <div class="dtpair"><div class="dt"><span class="tiny muted" id="bch-from-l">From</span><input type="date" id="bch-from" name="bch-from" value="${esc(f.from)}" max="${esc(f.to)}" data-bch="from" aria-labelledby="bch-from-l"></div>
    <div class="dt"><span class="tiny muted" id="bch-to-l">To</span><input type="date" id="bch-to" name="bch-to" value="${esc(f.to)}" min="${esc(f.from)}" data-bch="to" aria-labelledby="bch-to-l"></div></div>
    <label class="chk"><input type="checkbox" id="bch-short" name="bch-short" data-bch="shortages"${f.shortages ? ' checked' : ''}><span>Only with shortages</span></label>
    ${filterCount() ? '<button type="button" class="btn sm" data-act="bc-clear" id="bchClear">Clear filters</button>' : ''}
    <button type="button" class="btn" data-act="bc-export" data-w="history" id="bcExportH"${rs.exporting ? ' disabled' : ''}>${icon('download')}<span class="lbl">Export CSV</span></button></div>`;
  if (h.err && !h.rows.length) return `${bar}<div class="warnbox bad" role="alert">${esc(h.err)} <button type="button" class="btn sm" data-act="bc-retry" data-w="hist" id="bcRetry">Try again</button></div>`;
  if (!h.rows.length && (h.loading || h.sig !== sig)) return `${bar}<p class="muted" role="status">Loading...</p>`;
  if (!h.rows.length) return `${bar}<div class="panel">${emptyState('inbox', filterCount() ? 'No checks found' : 'No bus checks yet', filterCount() ? 'Nothing matches these filters.' : 'Checks will be listed here once crews send them.')}</div>`;
  return `${bar}<div class="panel"><div class="pn small muted" role="status">${h.rows.length} ${h.rows.length === 1 ? 'check' : 'checks'} shown, newest first. Times are Guyana time.</div>
    <div class="tscroll"><table class="t" id="bcHist"><thead><tr><th>When</th><th>Unit</th><th>Station</th><th>Crew</th><th class="n">Km</th><th class="n">Hours</th><th class="n">Shortages</th></tr></thead><tbody>
    ${h.rows.map((r: any) => `<tr><td><button type="button" class="btn link" data-act="bc-open" data-id="${esc(r.id)}" id="bch-${esc(r.id)}">${esc(dmyHM(r.at))}</button><div class="tiny muted">${esc(r.byName)}</div></td><td class="mono-s">${esc(r.unit)}</td><td>${esc(r.base)}</td>
      <td class="small">${esc([r.emt1, r.emt2, r.driver].filter(Boolean).join(', '))}</td><td class="n">${num(r.km)}</td><td class="n">${num(r.hours)}${r.flagged ? ' <span class="badge warn">flagged</span>' : ''}</td><td class="n">${r.shortages ? `<span class="badge bad">${r.shortages}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div>
    ${h.err ? `<div class="warnbox bad" role="alert" style="margin:12px">${esc(h.err)}</div>` : ''}
    ${h.hasMore ? `<div class="actmore-row"><button type="button" class="btn" data-act="bc-more" id="bcMore"${h.loadingMore || h.loading ? ' disabled' : ''}>${h.loadingMore ? 'Loading...' : 'Load more'}</button></div>` : '<div class="pn small muted actend">That is every check for these filters.</div>'}</div>`;
}

/* ---------- the page ---------- */
VIEWS.buschecks = function () {
  if (!canBusScreen()) return '<div class="warnbox bad">You do not have access to this page.</div>';
  const t = curTab(), all = tabs();
  const body = t === 'today' ? todayTab() : t === 'equipment' ? equipmentTab() : t === 'shortages' ? shortagesTab() : t === 'history' ? historyTab() : reqTab();
  return `${pageHead('Bus checks', { sub: 'Whether each unit was checked at the start of each shift, the equipment that is short on each unit, and the requirements crews check against.' })}
    <div class="tabs" role="tablist" aria-label="Bus check sections">${all.map(([k, l]) => `<button role="tab" id="bct-${k}" type="button" data-act="bc-tab" data-tab="${k}" aria-selected="${t === k}">${l}</button>`).join('')}</div>
    <div role="tabpanel" aria-labelledby="bct-${t}">${body}</div>`;
};

/* ---------- one check, read-only ---------- */
const personLine = (p: any) => (p?.name ? esc(p.name) : '–');
function answerText(it: BusItem, a?: BusAnswer): string {
  if (!a) return '–';
  if (it.kind === 'count') return a.status === 'short' ? `Short: ${num(a.qty)} of ${num(it.min)}${it.unit ? ' ' + it.unit : ''}` : 'OK';
  if (it.kind === 'check') return a.status === 'fail' ? 'Fail' : 'Pass';
  if (it.kind === 'number') return `${num(a.value)}${it.unit ? ' ' + it.unit : ''}`;
  if (it.kind === 'date') return fmtDate(a.date);
  return a.status === 'present' ? 'Present' : a.status === 'absent' ? 'Not there' : '–';
}
function checkHtml(c: any) {
  const shortIds = new Set((c.shortageItems || []).map((s: any) => s.itemId));
  const kind = (k: string) => (k === 'new' ? 'Recorded as an equipment shortage' : k === 'existing' ? 'Added to an open equipment shortage' : 'Reported by the crew, sent to maintenance');
  return `<p class="muted small" id="bcvNote">A sent check is a record. It cannot be changed.</p>
    <dl class="dl bcvdl">${[
      ['Unit', `<button class="btn link mono-s" data-act="open-vehicle" data-id="${esc(c.vehicleId)}">${esc(c.unit)}</button>`], ['Station', esc(c.base || '–')],
      ['Sent', esc(dmyHM(c.at))], ['Shift', esc(c.shift)], ['Sent by', esc(c.byName || '–')], ['List used', esc(c.list)],
      ['EMT 1', personLine(c.crew?.emt1)], ['EMT 2', personLine(c.crew?.emt2)], ['Driver', personLine(c.crew?.driver)],
      ['Mileage', `${num(c.km)} km`], ['Engine hours', `${num(c.hours)} h${c.flagged ? ' <span class="badge warn">flagged, not applied</span>' : ''}`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <h3>Shortages and problems from this check</h3>${c.problems.length ? `<ul class="bcvprobs">${c.problems.map((p: any) => `<li>${D.issues[p.issueId] ? `<button type="button" class="btn link" data-act="open-issue" data-id="${esc(p.issueId)}"><b>${esc(p.title)}</b></button>` : `<b>${esc(p.title || 'A problem')}</b>`}
      <div class="tiny muted">${esc(kind(p.kind))}${p.severity ? ' · ' + esc(SEV[p.severity] || p.severity) : ''}${p.status ? ' · ' + esc(ISSUE_ST[p.status] || p.status.replace(/_/g, ' ')) : ''}</div></li>`).join('')}</ul>` : '<p class="muted small">None. Nothing was short and no problems were reported.</p>'}
    <h3>All answers</h3>${(c.snapshot.sections || []).map((s: any) => `<div class="bcvsec"><h4>${esc(s.title)}</h4><table class="t"><tbody>${s.items.map((it: BusItem) => `<tr class="${shortIds.has(it.id) ? 'bcvbad' : ''}"><td>${it.code ? `<span class="bccode">${esc(it.code)}</span> ` : ''}${esc(it.name)}${c.answers[it.id]?.note ? `<div class="tiny muted">Note: ${esc(c.answers[it.id].note)}</div>` : ''}</td><td class="n">${shortIds.has(it.id) ? '<span class="badge bad">Short</span> ' : ''}${esc(answerText(it, c.answers[it.id]))}</td></tr>`).join('')}</tbody></table></div>`).join('')}
    <h3>Confirmation</h3><p class="small" id="bcvAttest">${esc(c.attestation)}</p><p class="tiny muted">${flatItems(c.snapshot.sections || []).length} items on the list.</p>`;
}
async function openCheck(id: string) {
  if (rs.opening) return;
  rs.opening = true;
  try { const r = await api('GET', '/bus-checks/' + encodeURIComponent(id)); showDrawer(`Bus check: ${r.check.unit}`, checkHtml(r.check), { wide: true, focusClose: true }); }
  catch (e: any) { toast(e?.message || 'Could not open that check.', true); }
  rs.opening = false;
}

/* ---------- the Bus checks tab on a unit ---------- */
/** The unit's open equipment shortages (with Mark restocked where allowed). Loaded for the unit page only; refreshed after a restock. */
function unitShortages(v: any): string {
  let e = rs.unitEq[v.id];
  if (!e || (!e.loading && !e.err && Date.now() - e.at > STALE_MS)) {
    const mine = (rs.unitEq[v.id] ||= { rows: e?.rows || [], at: 0, loading: true, err: '' });
    mine.loading = true;
    api('GET', '/bus-checks/equipment' + qs({ vehicleId: v.id })).then((r: any) => { mine.rows = r.open; mine.err = ''; }).catch((x: any) => { mine.err = x?.message || 'Could not load the equipment shortages.'; }).finally(() => { mine.loading = false; mine.at = Date.now(); scheduleRender(); });
    e = mine;
  }
  const head = `<div class="ph"><h2>Equipment shortages</h2>${e.rows.length > 1 && eqCan(v.id) ? `<button type="button" class="btn sm" data-act="eq-restock-unit" data-id="${esc(v.id)}" id="equAll"${rs.restocking ? ' disabled' : ''}>Mark all restocked</button>` : ''}</div>`;
  if (e.err && !e.rows.length) return `<div class="panel" id="vEquip">${head}<div class="pb"><div class="warnbox bad" role="alert">${esc(e.err)} <button type="button" class="btn sm" data-act="bc-unit-retry" data-id="${esc(v.id)}" id="equRetry">Try again</button></div></div></div>`;
  if (!e.rows.length) return `<div class="panel" id="vEquip">${head}<div class="pb muted small" role="status">${e.loading ? 'Loading...' : 'Nothing is reported short on this unit.'}</div></div>`;
  return `<div class="panel" id="vEquip">${head}${shortageTable(e.rows, 'vEquipTable')}</div>`;
}
VT.buschecks = function (v: any) {
  const reports = can('busCheckReports', v), equip = reports || can('busCheckRestock', v);
  if (!equip) return '<div class="panel"><div class="pb muted small">You do not have access to the bus checks of this unit.</div></div>';
  const shortages = unitShortages(v);
  if (!reports) return shortages;
  let u = rs.unit[v.id];
  if (!u || (!u.loading && !u.err && Date.now() - u.at > STALE_MS)) {
    const mine = (rs.unit[v.id] ||= { rows: u?.rows || [], at: 0, loading: true, err: '' });
    mine.loading = true;
    api('GET', '/bus-checks' + qs({ vehicleId: v.id, limit: '15' })).then((r: any) => { mine.rows = r.rows; mine.err = ''; }).catch((e: any) => { mine.err = e?.message || 'Could not load the checks.'; }).finally(() => { mine.loading = false; mine.at = Date.now(); scheduleRender(); });
    u = mine;
  }
  if (u.err && !u.rows.length) return `${shortages}<div class="panel"><div class="pb"><div class="warnbox bad" role="alert">${esc(u.err)} <button type="button" class="btn sm" data-act="bc-unit-retry" data-id="${esc(v.id)}" id="bcuRetry">Try again</button></div></div></div>`;
  if (!u.rows.length) return `${shortages}<div class="panel">${u.loading ? '<div class="pb muted" role="status">Loading...</div>' : emptyState('check', 'No bus checks yet', 'Checks for this unit will be listed here.')}</div>`;
  return `${shortages}<div class="panel"><div class="ph"><h2>Recent bus checks</h2><button type="button" class="btn sm" data-act="bc-go-history" data-id="${esc(v.id)}" id="bcuAll">See all</button></div><div class="tscroll"><table class="t" id="bcuTable"><thead><tr><th>When</th><th>Crew</th><th class="n">Km</th><th class="n">Hours</th><th class="n">Shortages</th></tr></thead><tbody>
    ${u.rows.map((r: any) => `<tr><td><button type="button" class="btn link" data-act="bc-open" data-id="${esc(r.id)}" id="bcu-${esc(r.id)}">${esc(dmyHM(r.at))}</button><div class="tiny muted">${esc(r.byName)}</div></td><td class="small">${esc([r.emt1, r.emt2, r.driver].filter(Boolean).join(', '))}</td><td class="n">${num(r.km)}</td><td class="n">${num(r.hours)}</td><td class="n">${r.shortages ? `<span class="badge bad">${r.shortages}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div></div>`;
};

/* ---------- actions ---------- */
export const busChecksActs: Record<string, any> = {
  ...requirementsActs,
  'bc-tab': (el: HTMLElement) => { rs.tab = el.dataset.tab as Tab; markStale(); scheduleRender(); },
  'bc-day': (el: HTMLElement) => { const n = Number(el.dataset.d); rs.date = n === 0 ? '' : addDays(rs.date || todayStr(), n); scheduleRender(); },
  'bc-retry': (el: HTMLElement) => { const w = el.dataset.w; if (w === 'today') retry(rs.today); else if (w === 'short') retry(rs.short); else if (w === 'eq') retry(rs.eq); else { rs.hist.sig = ''; rs.hist.err = ''; scheduleRender(); } },
  'bc-unit-retry': (el: HTMLElement) => { delete rs.unit[el.dataset.id!]; delete rs.unitEq[el.dataset.id!]; scheduleRender(); },
  'eq-recent': () => { rs.eqRecent = !rs.eqRecent; scheduleRender(); },
  'eq-clear': () => { rs.eqF = { baseId: '', vehicleId: '' }; scheduleRender(); },
  /** One shortage (from the Equipment tab or a unit's page). The row is found in whichever list is on screen. */
  'eq-restock': (el: HTMLElement) => {
    const id = el.dataset.id!, r = (rs.eq.data?.open || []).find((x: any) => x.id === id) || Object.values(rs.unitEq).flatMap((u) => u.rows).find((x: any) => x.id === id);
    if (r) restock([id], [r], r.unit);
  },
  'eq-restock-unit': (el: HTMLElement) => { const rows = rs.unitEq[el.dataset.id!]?.rows || []; if (rows.length) restock(rows.map((r: any) => r.id), rows, rows[0].unit); },
  'eq-restock-all': (el: HTMLElement) => {
    const vid = el.dataset.id!, rows = (rs.eq.data?.open || []).filter((x: any) => x.vehicleId === vid);
    if (rows.length) restock(rows.map((r: any) => r.id), rows, rows[0].unit);
  },
  'bc-open': (el: HTMLElement) => openCheck(el.dataset.id!),
  'bc-more': () => { if (!rs.hist.loadingMore && !rs.hist.loading && rs.hist.hasMore) { loadHistory(true); scheduleRender(); } },
  'bc-clear': () => { rs.hist.f = { vehicleId: '', baseId: '', userId: '', from: '', to: '', shortages: false }; rs.hist.sig = ''; scheduleRender(); },
  /** From the unit's Bus checks tab: the full history, for this unit. */
  'bc-go-history': (el: HTMLElement) => { rs.hist.f = { vehicleId: el.dataset.id!, baseId: '', userId: '', from: '', to: '', shortages: false }; rs.hist.sig = ''; rs.tab = 'history'; location.hash = '#buschecks'; },
  'bc-export': async (el: HTMLElement) => {
    if (rs.exporting) return;
    rs.exporting = true; scheduleRender();
    try {
      const which = el.dataset.w;
      const path = which === 'equipment' ? '/bus-checks/equipment/export' + qs({ baseId: rs.eqF.baseId, vehicleId: rs.eqF.vehicleId }) : which === 'shortages' ? '/bus-checks/shortages/export' + qs(range()) : '/bus-checks/export' + histQs();
      const { blob, headers } = await apiFile(path);
      const n = Number(headers.get('X-Rows') || 0);
      saveBlob(`gema-fleet-bus-${which === 'equipment' ? 'equipment' : which === 'shortages' ? 'shortages' : 'checks'}-${todayStr()}.csv`, blob);
      toast(headers.get('X-Truncated') === '1' ? `Exported the newest ${n.toLocaleString('en-US')} rows (the export limit). Narrow the dates to get the rest.` : `Exported ${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`);
    } catch (e: any) { toast(e?.message || 'Could not export. Please try again.', true); }
    rs.exporting = false; scheduleRender();
  },
};
document.addEventListener('change', (e: any) => {
  const el = e.target;
  if (!el?.dataset) return;
  const k = el.dataset.bcf, h = el.dataset.bch, q = el.dataset.eqf;
  if (q) {
    const f: any = rs.eqF;
    f[q] = el.value;
    if (q === 'baseId' && f.vehicleId && el.value && D.vehicles[f.vehicleId]?.baseId !== el.value) f.vehicleId = '';
    scheduleRender();
  } else if (k) {
    if (k === 'date') rs.date = el.value;
    else {
      if (k === 'from') { rs.from = el.value; if (el.value && rs.to && el.value > rs.to) rs.to = el.value; }
      if (k === 'to') { rs.to = el.value; if (el.value && rs.from && el.value < rs.from) rs.from = el.value; }
    }
    scheduleRender();
  } else if (h) {
    const f: any = rs.hist.f;
    f[h] = h === 'shortages' ? el.checked : el.value;
    if (h === 'from' && el.value && f.to && el.value > f.to) f.to = el.value;
    if (h === 'to' && el.value && f.from && el.value < f.from) f.from = el.value;
    rs.hist.sig = ''; scheduleRender();
  }
});
void pill; void baseName; void dmy;
