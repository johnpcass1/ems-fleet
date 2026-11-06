/** The three read/write drawers (work order, problem, unit) and how they refresh when data changes. */
import { D, S, ui, role } from './state';
import { showDrawer, closeDrawer, drawerBack } from './dom';
import { $ } from './util';
import { route, routeLabel } from './nav';
import { woHtml, issueHtml } from './views-b';
import { unitHtml } from './views-a';

let drawerSig = '';
const woSigOf = (wo: any) => { const v = wo && D.vehicles[wo.vehicleId]; return JSON.stringify([wo, v && [v.status, v.engineHours, v.odometerKm], Object.keys(D.parts).length, Object.keys(D.mechanics).length, role()]); };
export const DRAWER_TYPES: Record<string, any> = {
  wo: { doc: (id: string) => D.workOrders[id], title: (d: any) => d.number, html: (d: any) => woHtml(d), wide: true, label: (d: any) => d.number, sig: (d: any) => woSigOf(d) },
  issue: { doc: (id: string) => D.issues[id], title: () => 'Problem', html: (d: any) => issueHtml(d), label: (d: any) => d.title, sig: () => S.ver + ':' + role() },
  unit: { doc: (id: string) => D.vehicles[id], title: () => 'Unit details', html: (d: any) => unitHtml(d), label: (d: any) => d.unit, sig: () => S.ver + ':' + role() },
};
function drawerBackLabel() {
  const p = drawerBack[drawerBack.length - 1];
  if (p) { const T = DRAWER_TYPES[p.type], d = T.doc(p.id); return d ? T.label(d) : 'previous'; }
  return routeLabel(route(), ui.vehicleId);
}
/** mode: 'fresh' (from a page), 'push' (from inside another drawer; Back returns to it), 'pop' (returning) */
export function openDrawer(type: string, id: string, mode: string) {
  const T = DRAWER_TYPES[type], d = T.doc(id);
  if (!d) return;
  if (mode === 'push' && ui.drawer) drawerBack.push({ type: ui.drawer.type, id: ui.drawer.id });
  else if (mode !== 'pop') drawerBack.length = 0;
  drawerSig = T.sig(d);
  showDrawer(T.title(d), T.html(d), { wide: T.wide, focusClose: true, drawer: { type, id }, back: 'Back to ' + drawerBackLabel() });
}
export function refreshDrawer() {
  if (!ui.drawer) return;
  const T = DRAWER_TYPES[ui.drawer.type], d = T && T.doc(ui.drawer.id);
  if (!d) { closeDrawer(); return; }
  const s = T.sig(d);
  if (s === drawerSig) return;
  drawerSig = s;
  const body = $('#dBody');
  if (!body) return;
  const top = body.scrollTop;
  body.innerHTML = T.html(d);
  body.scrollTop = top;
  const t = $('#dTitle');
  if (t) t.textContent = T.title(d);
}
