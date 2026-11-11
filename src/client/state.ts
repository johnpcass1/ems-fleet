/** Client-side data cache, session info and the lookups the views share. */
import { RANK, addDays, avgHoursPerDay, daysBetween, pmTaskStatus, projectDue, woTotal } from '../shared/pure';
import { STATUS, isAvail, isOos } from '../shared/constants';
import { canOnVehicle, canWorkWO, can as canActor, type Actor } from '../shared/perm';
import { esc, todayStr } from './util';

export const COLS = ['bases', 'pmPrograms', 'vehicles', 'meterReadings', 'statusEvents', 'issues', 'workOrders', 'parts', 'mechanics', 'settings', 'moves', 'people'];
export const D: Record<string, Record<string, any>> = {};
export const LST: Record<string, any[]> = {};
COLS.forEach((c) => { D[c] = {}; LST[c] = []; });

export interface Me extends Actor { mustChangePassword: boolean; isSuperuser?: boolean }
/** Mutable app-wide flags. */
export const S = {
  me: null as Me | null,
  ready: false, // first full sync done
  ver: 0, // bumped on every data change
  cursor: 0,
  connFailed: false,
  emailEnabled: false, // the server can send invite and reset emails
  idxVer: -1,
  IDX: {} as any,
};

export const ui: any = {
  vehicleId: null, vtab: 'overview', period: 90, selIssues: [], drawer: null,
  f: { board: { base: '', status: '', q: '' }, vehicles: { base: '', status: '', q: '' }, pm: { base: '' }, issues: { status: 'active', severity: '', base: '' }, wo: { status: 'active', view: 'table' }, hist: 'all', activity: { q: '', userId: '', type: '', from: '', to: '', entityType: '', entityId: '' } },
};
const LS_KEY = 'gema-fleet-ui-v1';
/** Filters and the last unit are remembered per browser (never anything that matters). */
export function loadUi() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (j) {
      if (j.vehicleId) ui.vehicleId = j.vehicleId;
      if (j.period) ui.period = j.period;
      if (j.f) for (const k of Object.keys(ui.f)) if (j.f[k] != null) ui.f[k] = typeof ui.f[k] === 'object' ? { ...ui.f[k], ...j.f[k] } : j.f[k];
    }
  } catch { /* storage may be blocked */ }
}
export function saveUi() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ vehicleId: ui.vehicleId, period: ui.period, f: ui.f })); } catch { /* ignore */ }
}

/* ---- permissions (the server enforces the same rules; this only hides buttons that would be refused) ---- */
export const role = () => S.me?.role || 'viewer';
/** can('move') = role may ever do it. can('move', vehicle) = and for this unit. */
export function can(key: string, v?: any): boolean {
  if (!S.me) return false;
  if (!canActor(S.me, key)) return false;
  if (v === undefined) return true;
  return canOnVehicle(S.me, key, v?.baseId);
}
export function canWo(wo: any): boolean {
  if (!S.me || !wo) return false;
  return canWorkWO(S.me, wo, D.vehicles[wo.vehicleId]?.baseId);
}
/** Planning rights on a work order (create / schedule / reassign / close / cancel). */
export const canPlan = (key: string, wo: any) => can(key, D.vehicles[wo.vehicleId]);

/* ---- change handling ---- */
let renderHook: () => void = () => {};
export const setRenderHook = (f: () => void) => { renderHook = f; };
export const scheduleRender = () => renderHook();

/** The server sends the person's current role and permissions with every sync. Returns true when something changed, so the screen is redrawn. */
export function applyMe(m: any): boolean {
  if (!m || !S.me) return false;
  const sig = (x: any) => JSON.stringify([x.role, x.baseIds, x.mechanicId, x.isSuperuser, x.perms]);
  if (sig(S.me) === sig(m)) return false;
  Object.assign(S.me, { role: m.role, baseIds: m.baseIds, mechanicId: m.mechanicId, isSuperuser: !!m.isSuperuser, perms: m.perms });
  return true;
}
export function applySync(res: any) {
  if (res.full) COLS.forEach((c) => { D[c] = {}; });
  for (const c of Object.keys(res.data || {})) {
    if (!D[c]) continue;
    for (const d of res.data[c]) D[c][d.id] = d;
  }
  for (const c of Object.keys(res.deleted || {})) for (const id of res.deleted[c]) if (D[c]) delete D[c][id];
  COLS.forEach((c) => { LST[c] = Object.values(D[c]); });
  S.cursor = res.cursor;
  S.ver++;
  S.ready = true;
  S.connFailed = false;
}

/* ---- indexes ---- */
const groupBy = (arr: any[], key: string, sortKey?: string) => {
  const m: Record<string, any[]> = {};
  arr.forEach((x) => (m[x[key]] = m[x[key]] || []).push(x));
  if (sortKey) Object.values(m).forEach((a) => a.sort((p, q) => Date.parse(p[sortKey]) - Date.parse(q[sortKey])));
  return m;
};
export function idx() {
  if (S.idxVer === S.ver) return S.IDX;
  S.IDX = { readings: groupBy(LST.meterReadings, 'vehicleId', 'at'), events: groupBy(LST.statusEvents, 'vehicleId', 'at'), issues: groupBy(LST.issues, 'vehicleId', 'reportedAt'), wos: groupBy(LST.workOrders, 'vehicleId', 'openedAt'), sum: {} };
  S.idxVer = S.ver;
  return S.IDX;
}
export const nameOf = (id: any) => (id && D.people[id]?.name) || 'Someone';

/* ---- lookups ---- */
export const settings = () => ({ approvalThresholdGYD: 150000, dueSoonHours: 25, dueSoonDays: 14, comebackDays: 30, dueSoonKm: 1000, ...(D.settings.main || {}) });
/** Photo and PDF uploads switch (Setup). Anything but a real `true` (including a missing key) means OFF. */
export const featureUploads = () => (D.settings.main || {}).features?.uploads === true;
/** 'on' = may upload; 'off' = the site-wide switch is off (super user only can change it); 'noperm' = switch is on but this person has no upload permission. */
export const uploadState = (): 'on' | 'off' | 'noperm' => (!featureUploads() ? 'off' : can('upload') ? 'on' : 'noperm');
export const uploadsOn = () => uploadState() === 'on';
export const vehiclesSorted = () => LST.vehicles.slice().sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }));
export const basesSorted = () => LST.bases.slice().sort((a, b) => (a.name === 'HQ' ? -1 : b.name === 'HQ' ? 1 : String(a.name).localeCompare(b.name)));
export const baseName = (id: any) => D.bases[id]?.name || 'Unassigned';
export const mechName = (id: any) => D.mechanics[id]?.name || 'Not assigned';
export const unitOf = (id: any) => D.vehicles[id]?.unit || 'Unknown unit';
export const readingsOf = (id: string) => idx().readings[id] || [];
export const eventsOf = (id: string) => idx().events[id] || [];
export const issuesOf = (id: string) => idx().issues[id] || [];
export const wosOf = (id: string) => idx().wos[id] || [];
export const openIssues = (id: string) => issuesOf(id).filter((i: any) => i.status === 'open' || i.status === 'in_work_order');
export const prog = (v: any) => D.pmPrograms[v.pmProgramId] || LST.pmPrograms[0] || null;
export const hasSample = () => COLS.some((c) => LST[c].some((x) => x.sample));

export function remH(st: any, rate?: number | null) {
  if (st.hoursRemaining != null) return st.hoursRemaining;
  if (st.daysRemaining != null) return st.daysRemaining * (rate || 5);
  if (st.kmRemaining != null) return st.kmRemaining / 30;
  return null;
}
export const cmpPm = (a: any, b: any) => RANK[b.state] - RANK[a.state] || (remH(a) ?? 1e9) - (remH(b) ?? 1e9);
export function vsum(v: any) {
  const I = idx();
  if (I.sum[v.id]) return I.sum[v.id];
  const S_ = settings(), p = prog(v), cur = { hours: v.engineHours || 0, km: v.odometerKm || 0, date: todayStr() };
  const rate = avgHoursPerDay(readingsOf(v.id), Date.now());
  const tasks = (p?.tasks || []).map((t: any) => {
    const st: any = pmTaskStatus(t, v.pm?.[t.id], cur, S_);
    st.task = t;
    st.projected = projectDue(st, rate, cur.date);
    return st;
  });
  const cmp = (a: any, b: any) => RANK[b.state] - RANK[a.state] || (remH(a, rate) ?? 1e9) - (remH(b, rate) ?? 1e9);
  const sorted = tasks.slice().sort(cmp);
  return (I.sum[v.id] = { tasks, due: sorted.filter((t: any) => t.state !== 'ok'), next: sorted[0] || null, overdue: tasks.filter((t: any) => t.state === 'overdue').length, soon: tasks.filter((t: any) => t.state === 'due_soon').length, rate });
}
export function leadBasis(st: any) {
  let best: string | null = null;
  for (const k of ['hours', 'days', 'km']) {
    if (st.bases[k] == null) continue;
    if (best == null || RANK[st.bases[k]] > RANK[st.bases[best]]) best = k;
  }
  return best;
}
export function remText(st: any) {
  if (st.never) return 'Never done';
  const k = leadBasis(st);
  if (!k) return '–';
  const rem = k === 'hours' ? st.hoursRemaining : k === 'days' ? st.daysRemaining : st.kmRemaining, u = k === 'hours' ? 'h' : k === 'days' ? 'd' : 'km';
  const fmt = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (rem < 0) return `overdue by ${fmt(-rem)} ${u}`;
  if (rem === 0) return 'due now';
  return `${fmt(rem)} ${u} left`;
}
/** Base coverage: available units vs minimum. */
export function coverage(baseId: string) {
  const vs = LST.vehicles.filter((v) => v.baseId === baseId && v.status !== 'decommissioned');
  const avail = vs.filter((v) => isAvail(v.status)).length, b = D.bases[baseId], min = b?.minUnits ?? 0;
  return { avail, total: vs.length, min, low: avail < min };
}
export function coverageAfterRemoval(v: any) {
  if (!isAvail(v.status)) return null;
  const c = coverage(v.baseId);
  return c.avail - 1 < c.min ? { base: baseName(v.baseId), avail: c.avail - 1, total: c.total, min: c.min } : null;
}
export function coverageEffect(ids: string[], to: string) {
  const m: Record<string, any> = {};
  const touch = (b: string) => (m[b] = m[b] || (() => { const c = coverage(b); return { name: baseName(b), before: c.avail, after: c.avail, min: c.min }; })());
  ids.forEach((id) => {
    const v = D.vehicles[id];
    if (!v || !to || v.baseId === to || !isAvail(v.status)) return;
    touch(v.baseId).after--;
    touch(to).after++;
  });
  return Object.values(m);
}
export const woTotalAll = woTotal;
export { STATUS, isAvail, isOos, esc, addDays, daysBetween };
