/** Hash routing and the "Back to ..." navigation stack. */
import { ui, saveUi, D, S, hasSample } from './state';
import { closeDrawer } from './dom';
import { $, esc } from './util';
import { hasPerm } from '../shared/perm';

export const ALL_ROUTES = ['board', 'dispatch', 'vehicles', 'vehicle', 'pm', 'issues', 'work-orders', 'parts', 'reports', 'setup', 'users'];
export const ROUTE_LABELS: Record<string, string> = { board: 'Status board', dispatch: 'Dispatch', vehicles: 'Vehicles', pm: 'Preventive maintenance', issues: 'Problems', 'work-orders': 'Work orders', parts: 'Parts & mechanics', reports: 'Reports', setup: 'Setup', users: 'Users' };
/** Sidebar groups, in order. The vehicle screen is reached from the lists, so it is not in the sidebar. */
export const NAV_GROUPS: [string, string[]][] = [['Operations', ['board', 'dispatch', 'issues', 'work-orders', 'pm']], ['Fleet', ['vehicles', 'parts']], ['Admin', ['reports', 'setup', 'users']]];
export const groupOf = (r: string) => NAV_GROUPS.find(([, rs]) => rs.includes(r))?.[0] || '';

/** Which screens a person may open. The dispatcher sees Dispatch only. */
export function allowedRoutes(): string[] {
  const role = S.me?.role;
  if (!role) return [];
  if (role === 'dispatcher') return ['dispatch'];
  const r = ALL_ROUTES.filter((x) => x !== 'users');
  if (hasPerm(role, 'users')) r.push('users');
  return r;
}
export function route(): string {
  const allowed = allowedRoutes();
  const h = (location.hash || '').replace(/^#/, '');
  if (!allowed.length) return 'board';
  if (allowed.includes(h)) return h;
  return allowed[0] === 'dispatch' ? 'dispatch' : 'board';
}
let renderFn: () => void = () => {};
export const setRenderFn = (f: () => void) => { renderFn = f; };

export const routeLabel = (r: string, vid?: string | null) => (r === 'vehicle' ? D.vehicles[vid as string]?.unit || 'vehicle' : ROUTE_LABELS[r] || 'Status board');
/** Each entry remembers where to return to (route, selected unit, tab, scroll). Filters live in ui.f and persist. */
export let navStack: any[] = [];
export let pendingRestore: any = null;
export const setPendingRestore = (v: any) => { pendingRestore = v; };
export let skipNext = false;
export const setSkipNext = (v: boolean) => { skipNext = v; };
export let restoreScroll = 0;
export const clearNavStack = () => { navStack.length = 0; };

export function viewChanged() {
  closeDrawer();
  ui.selIssues = [];
  renderFn();
  const el = $('#view');
  window.scrollTo(0, restoreScroll || 0);
  restoreScroll = 0;
  if (el) el.focus({ preventScroll: true });
}
export const go = (r: string) => { if (location.hash === '#' + r) viewChanged(); else location.hash = '#' + r; };
const navSnap = () => ({ route: route(), vehicleId: ui.vehicleId, vtab: ui.vtab, scroll: window.scrollY || 0 });
export function openVehicle(id: string, tab?: string) {
  closeDrawer();
  navStack.push(navSnap());
  ui.vehicleId = id;
  ui.vtab = tab || 'overview';
  saveUi();
  go('vehicle');
}
export const backLabel = () => {
  const t = navStack[navStack.length - 1];
  return t ? routeLabel(t.route, t.vehicleId) : 'Status board';
};
export function applyNav(e: any) {
  closeDrawer();
  if (e.route === 'vehicle') { ui.vehicleId = e.vehicleId; ui.vtab = e.vtab || 'overview'; }
  saveUi();
  restoreScroll = e.scroll || 0;
  viewChanged();
}
export function restoreNav(e: any) {
  if (location.hash === '#' + e.route) { applyNav(e); return; }
  if (e.route === 'vehicle') { ui.vehicleId = e.vehicleId; ui.vtab = e.vtab || 'overview'; }
  saveUi();
  restoreScroll = e.scroll || 0;
  skipNext = true;
  location.hash = '#' + e.route;
}
export function goBack() {
  const e = navStack.pop();
  if (!e) { go('board'); return; }
  if (e.route === route()) { applyNav(e); return; }
  pendingRestore = e;
  history.back();
  setTimeout(() => { if (pendingRestore) { const x = pendingRestore; pendingRestore = null; restoreNav(x); } }, 500);
}
export const backBtn = () => `<button class="crumb" type="button" data-act="nav-back" id="navBack" aria-label="Back to ${esc(backLabel())}">${esc(backLabel())}</button>`;
void hasSample;
