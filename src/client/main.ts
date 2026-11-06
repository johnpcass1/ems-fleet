/** Entry point: decide between the login screen and the app, then keep the data fresh. */
import './style.css';
import { api, setAuthHook, setRouteGetter, startPolling, stopPolling, syncNow, syncIdle, resetSyncState } from './api';
import { S, COLS, D, LST, loadUi } from './state';
import { $, toast, val } from './util';
import { route } from './nav';
import { render, showLogin, showForcedChange, changeFormHtml } from './shell';
import { showForgot, showForgotDone, showLinkProblem, showSetPassword, passwordProblem, generatePassword, type LinkInfo } from './accounts-ui';
import { wireEvents, acts, FORMS } from './ui';
import { showDrawer, closeDrawer } from './dom';
import { resetUsersCache, syncUserForm } from './users-ui';
import { setProgressHook } from './files';
import { refreshAtt } from './views-b';

let started = false;
let linkToken = '';
let linkPurpose: 'invite' | 'reset' | null = null;

function clearData() {
  COLS.forEach((c) => { D[c] = {}; LST[c] = []; });
  resetSyncState();
  resetUsersCache();
  closeDrawer();
}
function toLogin(message = '') {
  stopPolling();
  started = false;
  S.me = null;
  clearData();
  $('#userbar').innerHTML = '';
  $('#userbar').dataset.sig = '';
  $('#nav').dataset.sig = '';
  $('#nav').innerHTML = '';
  $('#banners').innerHTML = '';
  showLogin(message);
}
async function startApp() {
  if (!S.me) return;
  document.body.classList.remove('loggedout');
  $('#view').innerHTML = '<p class="muted">Loading fleet data...</p>';
  if (!location.hash || location.hash === '#') location.hash = S.me.role === 'dispatcher' ? '#dispatch' : '#board';
  await syncNow();
  render();
  if (!started) { started = true; startPolling(); }
}

setAuthHook((kind) => {
  if (kind === 'login') { if (S.me) toLogin('You were logged out. Please log in again.'); }
  else if (S.me) { S.me.mustChangePassword = true; stopPolling(); started = false; showForcedChange(); }
});

/* login / change password forms are not data-form forms, so they are handled here */
document.addEventListener('submit', async (e) => {
  const f = e.target as HTMLFormElement;
  if (f.id === 'loginForm') {
    e.preventDefault();
    const btn = $('#lg-submit'), err = $('#lg-err');
    err.hidden = true;
    const email = val('lg-email'), password = (document.getElementById('lg-pass') as HTMLInputElement).value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/login', { email, password });
      S.me = r.user;
      S.emailEnabled = !!r.emailEnabled;
      if (S.me!.mustChangePassword) showForcedChange(); else await startApp();
    } catch (ex: any) {
      err.textContent = ex.message || 'Could not log in.';
      err.hidden = false;
      btn.disabled = false;
    }
  } else if (f.id === 'forgotForm') {
    e.preventDefault();
    const err = $('#fg-err'), btn = $('#fg-submit');
    err.hidden = true;
    const email = val('fg-email');
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/forgot', { email });
      showForgotDone(r.message);
    } catch (ex: any) {
      err.textContent = ex.message || 'Could not send the link. Please try again.';
      err.hidden = false;
      btn.disabled = false;
    }
  } else if (f.id === 'spForm') {
    e.preventDefault();
    const err = $('#sp-err'), btn = $('#sp-submit');
    err.hidden = true;
    const n1 = (document.getElementById('sp-new') as HTMLInputElement).value, n2 = (document.getElementById('sp-new2') as HTMLInputElement).value;
    const problem = passwordProblem(n1, n2);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/set-password', { token: linkToken, newPassword: n1 });
      linkToken = '';
      S.me = r.user;
      S.emailEnabled = !!r.emailEnabled;
      history.replaceState(null, '', '/');
      await startApp();
    } catch (ex: any) {
      if (ex.code && String(ex.code).startsWith('token_')) { showLinkProblem({ valid: false, reason: String(ex.code).slice(6) as any, purpose: linkPurpose }); return; }
      err.textContent = ex.message || 'Could not save the password.';
      err.hidden = false;
      btn.disabled = false;
    }
  } else if (f.id === 'pwForm') {
    e.preventDefault();
    const err = $('#cp-err');
    err.hidden = true;
    const cur = (document.getElementById('cp-cur') as HTMLInputElement).value, n1 = (document.getElementById('cp-new') as HTMLInputElement).value, n2 = (document.getElementById('cp-new2') as HTMLInputElement).value;
    const fail = (m: string) => { err.textContent = m; err.hidden = false; };
    if (n1.length < 10) return fail('Use at least 10 characters.');
    if (n1 !== n2) return fail('The two new passwords do not match.');
    const btn = $('#cp-submit');
    btn.disabled = true;
    try {
      await api('POST', '/auth/change-password', { currentPassword: cur, newPassword: n1 });
      const wasForced = S.me!.mustChangePassword;
      S.me!.mustChangePassword = false;
      if (wasForced) await startApp(); else { toast('Password changed'); closeDrawer(); }
    } catch (ex: any) {
      fail(ex.message || 'Could not change the password.');
      btn.disabled = false;
    }
  }
});
acts['forgot'] = () => showForgot();
acts['to-login'] = () => { history.replaceState(null, '', '/'); showLogin(); };
acts['gen-pw'] = (el: HTMLElement) => {
  const p = el.dataset.p!, pw = generatePassword();
  for (const id of [`${p}-pw`, `${p}-pw2`]) { const i = document.getElementById(id) as HTMLInputElement; i.value = pw; i.type = 'text'; }
  const t = document.getElementById(`${p}-show`); if (t) { t.textContent = 'Hide'; t.setAttribute('aria-pressed', 'true'); }
};
acts['toggle-pw'] = (el: HTMLElement) => {
  const p = el.dataset.p!, show = el.getAttribute('aria-pressed') !== 'true';
  for (const id of [`${p}-pw`, `${p}-pw2`]) (document.getElementById(id) as HTMLInputElement).type = show ? 'text' : 'password';
  el.textContent = show ? 'Hide' : 'Show'; el.setAttribute('aria-pressed', String(show));
};
acts['change-password'] = () => showDrawer('Change password', changeFormHtml());
acts['logout'] = async () => {
  stopPolling();
  started = false;
  await syncIdle();
  try { await api('POST', '/auth/logout', {}, { quiet: true }); } catch { /* the session may already be gone */ }
  location.hash = '';
  toLogin('You are logged out.');
};
document.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.id === 'uf-role' || t.name === 'uf-how') syncUserForm(); });
void FORMS;

/** The page behind the link in an invite or reset email. The secret is in the address after "#", so it never reaches a server log; it is removed from the address bar straight away. */
async function bootSetPassword() {
  const m = /^#t=([A-Za-z0-9_-]+)$/.exec(location.hash);
  history.replaceState(null, '', '/set-password');
  try { S.emailEnabled = !!(await api('GET', '/auth/config', undefined, { quiet: true })).emailEnabled; } catch { /* the link page still works */ }
  if (!m) { showLinkProblem(null); return; }
  linkToken = m[1];
  try {
    const info: LinkInfo = await api('POST', '/auth/token-info', { token: linkToken }, { quiet: true });
    linkPurpose = info.purpose ?? null;
    if (info.valid) showSetPassword(info); else showLinkProblem(info);
  } catch (e: any) {
    showLinkProblem(null);
    const p = $('#sp-problem'); if (p) p.textContent = e.message || 'Could not check this link. Please try again.';
  }
}

async function boot() {
  loadUi();
  wireEvents();
  setRouteGetter(route);
  setProgressHook(refreshAtt);
  if (location.pathname.replace(/\/+$/, '') === '/set-password') { await bootSetPassword(); return; }
  try {
    const r = await api('GET', '/auth/session', undefined, { quiet: true });
    S.emailEnabled = !!r.emailEnabled;
    if (!r.user) { showLogin(); return; }
    S.me = r.user;
    if (S.me!.mustChangePassword) showForcedChange(); else await startApp();
  } catch {
    showLogin();
  }
}
boot();
