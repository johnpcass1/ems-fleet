/** The page frame behaviour: sidebar (collapse, mobile drawer), top bar (breadcrumbs, page actions), menus and wall display. */
import { ROLES } from '../shared/constants';
import { S, D, ui, hasSample } from './state';
import { $, $$, esc } from './util';
import { icon } from './icons';
import { initials } from './bits';
import { allowedRoutes, ROUTE_LABELS, NAV_GROUPS, groupOf, route, backBtn } from './nav';

const LS_RAIL = 'gema-fleet-sidebar', LS_WALL = 'gema-fleet-wall';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };

let rail = false, wallPref = false;
let renderFn: () => void = () => {};
export const setLayoutRender = (f: () => void) => { renderFn = f; };
const mq = window.matchMedia('(min-width: 1024px)');
export const isDesktop = () => mq.matches;

export function loadLayout() {
  rail = lsGet(LS_RAIL) === '1';
  wallPref = lsGet(LS_WALL) === '1';
  document.body.classList.toggle('rail', rail);
  mq.addEventListener('change', () => { closeNav(false); closeMenus(); renderFn(); });
}

/* ---------- sidebar ---------- */
export function drawNav() {
  const nav = $('#nav');
  const routes = allowedRoutes().filter((r) => r !== 'vehicle');
  const sig = routes.join(',');
  if (nav.dataset.sig !== sig) {
    nav.dataset.sig = sig;
    nav.innerHTML = NAV_GROUPS.map(([g, rs]) => ({ g, rs: rs.filter((r) => routes.includes(r)) })).filter((x) => x.rs.length).map(({ g, rs }) =>
      `<div class="navgrp" role="group" aria-label="${esc(g)}"><div class="navlbl" aria-hidden="true">${esc(g)}</div>${rs.map((r) => `<a href="#${r}" data-r="${r}" title="${esc(ROUTE_LABELS[r])}">${icon(r)}<span class="lbl">${esc(ROUTE_LABELS[r])}</span></a>`).join('')}</div>`).join('');
  }
  const cur = route();
  $$('#nav a').forEach((a: any) => { if (a.dataset.r === cur || (cur === 'vehicle' && a.dataset.r === 'vehicles')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const cb = $('#collapseBtn');
  if (cb) {
    cb.innerHTML = `${icon(rail ? 'expand' : 'collapse')}<span class="lbl">Collapse sidebar</span>`;
    cb.setAttribute('aria-label', rail ? 'Expand sidebar' : 'Collapse sidebar');
    cb.setAttribute('title', rail ? 'Expand sidebar' : 'Collapse sidebar');
  }
}
export function drawUserbar() {
  const u = S.me;
  const el = $('#userbar');
  if (!u) { el.innerHTML = ''; el.dataset.sig = ''; return; }
  const sig = u.name + u.role;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = `<div class="menu"><button type="button" class="userbtn" id="userMenuBtn" data-act="menu-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="userPop" title="${esc(u.name)}">
      <span class="av" aria-hidden="true">${esc(initials(u.name))}</span><span class="un"><b>${esc(u.name)}</b><small>${esc(ROLES[u.role] || u.role)}</small></span><span class="chev">${icon('down')}</span></button>
    <div class="menupop up" id="userPop" role="menu" hidden>
      <button type="button" role="menuitem" data-act="change-password" id="chgPw">${icon('key')}Change password</button>
      <button type="button" role="menuitem" data-act="logout" id="logoutBtn">${icon('logout')}Log out</button></div></div>`;
}
export function drawSample() { $('#sampleChip').hidden = !hasSample(); }

/* ---------- top bar: breadcrumbs and page actions ---------- */
export function drawCrumbs(r: string) {
  const el = $('#crumbs');
  if (r === 'vehicle') {
    const v = D.vehicles[ui.vehicleId];
    el.innerHTML = `<nav aria-label="Breadcrumb" class="crumbs-in">${backBtn()}<span class="sep" aria-hidden="true">/</span><span class="cur" aria-current="page">${esc(v ? v.unit : 'Vehicle')}</span></nav>`;
  } else {
    const g = groupOf(r);
    el.innerHTML = `<nav aria-label="Breadcrumb" class="crumbs-in">${g ? `<span class="grp">${esc(g)}</span><span class="sep grp" aria-hidden="true">/</span>` : ''}<span class="cur" aria-current="page">${esc(ROUTE_LABELS[r] || '')}</span></nav>`;
  }
}
/** Pages draw their action buttons in a .pactions row. On desktop they move to the top bar; on smaller screens only the primary one does (as an icon button) and the rest stay under the title. */
export function placeActions() {
  const top = $('#topact');
  top.replaceChildren();
  const pa = $('#view .pactions');
  if (!pa) return;
  if (isDesktop()) {
    while (pa.firstChild) top.appendChild(pa.firstChild);
    pa.remove();
  } else {
    const p = pa.querySelector(':scope > .btn.primary');
    if (p) top.appendChild(p);
    if (!pa.children.length) pa.remove();
  }
}
export function setPageTitle(r: string) {
  const h = $('#view h1');
  document.title = (h && h.textContent ? h.textContent.trim() + ' - ' : '') + 'GEMA Fleet';
  void r;
}

/* ---------- menus ---------- */
export function closeMenus(except?: HTMLElement | null) {
  let any = false;
  $$('.menupop:not([hidden])').forEach((p: HTMLElement) => {
    if (p === except) return;
    p.hidden = true;
    const b = document.querySelector(`[aria-controls="${p.id}"]`);
    if (b) b.setAttribute('aria-expanded', 'false');
    any = true;
  });
  return any;
}
const items = (pop: HTMLElement) => $$('[role=menuitem]', pop).filter((x: any) => !x.hidden && x.offsetParent !== null);

/* ---------- mobile navigation drawer ---------- */
export const navRoot = (): HTMLElement | null => (document.body.classList.contains('navopen') ? $('#sidebar') : null);
export function openNav() {
  if (isDesktop()) return;
  document.body.classList.add('navopen');
  const sb = $('#sidebar');
  sb.setAttribute('role', 'dialog'); sb.setAttribute('aria-modal', 'true'); sb.setAttribute('aria-label', 'Menu');
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  const first = $('#nav a[aria-current="page"]') || $('#nav a');
  if (first) first.focus();
}
export function closeNav(refocus = true) {
  if (!document.body.classList.contains('navopen')) return false;
  document.body.classList.remove('navopen');
  const sb = $('#sidebar');
  sb.removeAttribute('role'); sb.removeAttribute('aria-modal'); sb.removeAttribute('aria-label');
  const mb = $('#menuBtn');
  mb.setAttribute('aria-expanded', 'false');
  if (refocus) mb.focus();
  return true;
}

/* ---------- wall display ---------- */
export const wallOn = () => wallPref && route() === 'dispatch';
export const wallPressed = () => wallPref;
export function applyChrome() {
  document.body.classList.toggle('wallmode', wallOn());
}

/** Escape closes the topmost thing the frame owns. Returns true when it did something. */
export function escLayout(): boolean {
  if (closeMenus()) return true;
  if (closeNav()) return true;
  if (wallOn()) { setWall(false); return true; }
  return false;
}
function setWall(on: boolean) {
  wallPref = on;
  lsSet(LS_WALL, on ? '1' : '0');
  renderFn();
  const t = $(on ? '#wallExit' : '#wallToggle');
  if (t) t.focus();
}

export const layoutActs: Record<string, any> = {
  'menu-toggle': (el: HTMLElement) => {
    const pop = document.getElementById(el.getAttribute('aria-controls') || '') as HTMLElement | null;
    if (!pop) return;
    const open = pop.hidden;
    closeMenus(pop);
    pop.hidden = !open;
    el.setAttribute('aria-expanded', String(open));
    if (open) { const f = items(pop)[0]; if (f) f.focus(); }
  },
  'nav-open': () => openNav(),
  'nav-close': () => closeNav(),
  'sb-toggle': () => {
    rail = !rail;
    lsSet(LS_RAIL, rail ? '1' : '0');
    document.body.classList.toggle('rail', rail);
    drawNav();
    const b = $('#collapseBtn'); if (b) b.focus();
  },
  'wall-toggle': () => setWall(!wallPref),
  'wall-exit': () => setWall(false),
};

export function wireLayout() {
  /* runs before the app's own handlers so a menu is already closed and focus is back on its button when an item's action opens a drawer */
  document.addEventListener('click', (e: any) => {
    const item = e.target.closest && e.target.closest('.menupop [role=menuitem]');
    if (item) {
      const pop = item.closest('.menupop');
      const btn = document.querySelector(`[aria-controls="${pop.id}"]`) as HTMLElement | null;
      closeMenus();
      if (btn) btn.focus();
    } else if (!e.target.closest('.menu')) closeMenus();
    if (e.target.closest && e.target.closest('#nav a')) closeNav(false);
  }, true);
  document.addEventListener('keydown', (e: any) => {
    const pop = e.target.closest && e.target.closest('.menupop');
    if (pop) {
      const list = items(pop), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (list[(i + 1) % list.length] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[(i - 1 + list.length) % list.length] || list[0]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Tab') closeMenus();
    } else if ((e.key === 'ArrowDown') && e.target.matches && e.target.matches('[data-act="menu-toggle"]') && e.target.getAttribute('aria-expanded') === 'false') {
      e.preventDefault();
      layoutActs['menu-toggle'](e.target);
    }
  });
}
