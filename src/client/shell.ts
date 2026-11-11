/** The page frame: nav, banners, the current screen, and the login / change-password screens. */
import { D, S, COLS, hasSample, setRenderHook, role } from './state';
import { $, $$, esc, toast } from './util';
import { VIEWS } from './registry';
import { route, setRenderFn } from './nav';
import { brandHtml } from './bits';
import { drawNav, drawUserbar, drawSample, drawCrumbs, placeActions, setPageTitle, applyChrome, setLayoutRender, wallOn } from './layout';
import { refreshDrawer } from './drawers';
import { api } from './api';
import './views-a';
import './views-b';
import './views-c';
import './users-ui';
import './roles-ui';
import './activity-ui';

let queued = false;
export function scheduleRenderSoon() { if (queued) return; queued = true; setTimeout(() => { queued = false; render(); }, 16); }

export function render() {
  if (!S.me) return;
  document.body.classList.remove('loggedout');
  const r = route();
  applyChrome();
  drawNav();
  drawUserbar();
  drawSample();
  drawCrumbs(r);
  let b = '';
  if (S.connFailed) b += '<div class="banner bad" role="status">Can’t reach the server right now. Showing the last data received.</div>';
  if (hasSample()) b += '<div class="banner info mobonly" role="status">Sample data is loaded</div>';
  $('#banners').innerHTML = b;
  const view = $('#view'), ae: any = document.activeElement;
  const aid = ae && (view.contains(ae) || $('#topact').contains(ae)) && ae.id ? ae.id : null, ss = aid && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  let html;
  try { html = S.ready ? VIEWS[r]() : '<p class="muted">Loading fleet data...</p>'; } catch (e) { console.error(e); html = '<div class="warnbox bad">Something went wrong drawing this page. Try reloading.</div>'; }
  view.innerHTML = html;
  placeActions();
  setPageTitle(r);
  if (aid) { const el: any = document.getElementById(aid); if (el) { el.focus(); if (ss && el.setSelectionRange) { try { el.setSelectionRange(ss[0], ss[1]); } catch { /* ignore */ } } } }
  refreshDrawer();
}
setRenderFn(render);
setLayoutRender(render);
setRenderHook(scheduleRenderSoon);

/* ---------- logged-out screens ---------- */
export function clearChrome() {
  document.body.classList.remove('wallmode', 'navopen');
  $('#topact').replaceChildren();
  $('#crumbs').innerHTML = '';
  $('#userbar').innerHTML = '';
  $('#userbar').dataset.sig = '';
  $('#nav').dataset.sig = '';
  $('#nav').innerHTML = '';
  $('#banners').innerHTML = '';
  $('#sampleChip').hidden = true;
}
export function showLogin(message = '') {
  document.body.classList.add('loggedout');
  document.body.classList.remove('wallmode', 'navopen');
  $('#view').innerHTML = `<div class="loginwrap">${brandHtml()}<div class="panel"><div class="pb"><h1>Log in</h1><p class="muted small">GEMA Fleet, the fleet maintenance system for the Guyana EMS ambulance program.</p>
    ${message ? `<div class="warnbox" role="status">${esc(message)}</div>` : ''}
    <form id="loginForm" novalidate>
      <label class="f"><span class="l">Email</span><input id="lg-email" name="email" type="email" autocomplete="username" required autocapitalize="off" spellcheck="false"></label>
      <label class="f"><span class="l">Password</span><input id="lg-pass" name="password" type="password" autocomplete="current-password" required></label>
      <div id="lg-err" class="warnbox bad" role="alert" hidden></div>
      <button class="btn primary block" type="submit" id="lg-submit">Log in</button>
    </form><p class="small muted" style="margin:14px 0 0">${S.emailEnabled ? '<a href="/" data-act="forgot" id="forgotLink">Forgot password?</a>' : 'Forgot your password? Ask your fleet manager or the system administrator to set a new one.'}</p></div></div></div>`;
  $('#lg-email').focus();
}
export function showForcedChange() {
  document.body.classList.add('loggedout');
  $('#userbar').innerHTML = '';
  $('#view').innerHTML = `<div class="loginwrap">${brandHtml()}<div class="panel"><div class="pb"><h1>Choose a new password</h1><p class="muted small">Choose your own password to continue.</p>
    ${changeFormHtml()}</div></div></div>`;
  $('#cp-new').focus();
}
export function changeFormHtml(withCurrent = true) {
  return `<form id="pwForm" data-forced="${withCurrent ? '' : '1'}" novalidate>
    <label class="f"><span class="l">Current password</span><input id="cp-cur" type="password" autocomplete="current-password" required></label>
    <label class="f"><span class="l">New password</span><input id="cp-new" type="password" autocomplete="new-password" required minlength="10"><span class="hint">At least 10 characters. A few random words is a good choice.</span></label>
    <label class="f"><span class="l">New password again</span><input id="cp-new2" type="password" autocomplete="new-password" required></label>
    <div id="cp-err" class="warnbox bad" role="alert" hidden></div>
    <div class="dfoot"><button class="btn primary" type="submit" id="cp-submit">Save new password</button></div></form>`;
}
void api; void toast; void role; void COLS; void D; void wallOn;
