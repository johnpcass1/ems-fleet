/** Entry point: decide between the login screen and the app, then keep the data fresh. */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './style.css';
import { api, setAuthHook, setRouteGetter, startPolling, stopPolling, syncNow, syncIdle, resetSyncState } from './api';
import { S, COLS, D, LST, loadUi, hooks, rememberAgency } from './state';
import { $, toast, val } from './util';
import { route } from './nav';
import { render, showLogin, showForcedChange, changeFormHtml, clearChrome } from './shell';
import { loadLayout, wireLayout } from './layout';
import { icon } from './icons';
import { showForgot, showForgotDone, showLinkProblem, showSetPassword, passwordProblem, generatePassword, type LinkInfo } from './accounts-ui';
import { wireEvents, acts, FORMS } from './ui';
import { showDrawer, closeDrawer } from './dom';
import { resetUsersCache, syncUserForm } from './users-ui';
import { resetAgenciesCache } from './agencies-ui';
import { setProgressHook } from './files';
import { refreshAtt } from './views-b';
import { resetActivity } from './activity-ui';
import { resetBusCheck } from './buscheck-ui';
import { resetBusChecks } from './buschecks-ui';
import { isDemo, startDemo, switchDemoPerson, exitDemo, demoFailed } from './demo';

let started = false;
let linkToken = '';
let linkPurpose: 'invite' | 'reset' | null = null;

function clearData() {
  COLS.forEach((c) => { D[c] = {}; LST[c] = []; });
  resetSyncState();
  resetUsersCache();
  resetAgenciesCache();
  resetActivity();
  resetBusCheck();
  resetBusChecks();
  closeDrawer();
}
function toLogin(message = '') {
  stopPolling();
  started = false;
  S.me = null;
  clearData();
  clearChrome();
  showLogin(message);
}
/** The super user opened another agency or came back: forget everything cached for the old one and load the new one from scratch. */
hooks.agencySwitched = async (hash = '#board') => {
  clearData();
  if (!S.me) return;
  $('#view').innerHTML = '<p class="muted">Loading fleet data...</p>';
  if (location.hash !== hash) location.hash = hash;
  await syncNow();
  render();
};
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
  if (isDemo()) { exitDemo(); return; } // the demo has no login: anything that would log someone out simply leaves the demo
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
    const agencyId = val('lg-agency').toUpperCase(), email = val('lg-email'), password = (document.getElementById('lg-pass') as HTMLInputElement).value;
    if (!agencyId || !email || !password) { err.textContent = 'Enter your Agency ID, email and password.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/login', { agencyId, email, password });
      rememberAgency(agencyId);
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
    const agencyId = val('fg-agency').toUpperCase(), email = val('fg-email');
    if (!agencyId) { err.textContent = 'Enter your Agency ID.'; err.hidden = false; return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email address.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/forgot', { agencyId, email });
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
      if (S.me?.agency) rememberAgency(S.me.agency.id);
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
  if (isDemo()) { exitDemo(); return; }
  stopPolling();
  started = false;
  await syncIdle();
  try { await api('POST', '/auth/logout', {}, { quiet: true }); } catch { /* the session may already be gone */ }
  location.hash = '';
  toLogin('You are logged out.');
};

/* ---------- demo (see demo.ts) ---------- */
acts['demo-start'] = async (el: HTMLButtonElement) => {
  el.disabled = true;
  el.textContent = 'Starting the demo...';
  try {
    await startDemo();
    const r = await api('GET', '/auth/session');
    S.me = r.user;
    S.emailEnabled = false;
    location.hash = '#board';
    await startApp();
    toast(`Demo started. You are ${S.me!.name}.`);
  } catch (e) {
    demoFailed(e);
    el.disabled = false;
    el.textContent = 'Try the demo';
  }
};
acts['demo-exit'] = () => exitDemo();
document.addEventListener('change', async (e) => {
  const t = e.target as HTMLSelectElement;
  if (!t || t.id !== 'demoPerson' || !isDemo()) return;
  t.disabled = true;
  try {
    await syncIdle();
    await switchDemoPerson(t.value);
    clearData();
    const r = await api('GET', '/auth/session');
    S.me = r.user;
    $('#view').innerHTML = '<p class="muted">Loading fleet data...</p>';
    await syncNow(); // the page stays the same when the new person may see it; otherwise route() falls back to their first page
    render();
    toast(`You are now ${S.me!.name}.`);
  } catch (ex) {
    console.error(ex);
    toast('Could not switch person. Reload the page to start the demo again.', true);
  }
  const sel = document.getElementById('demoPerson') as HTMLSelectElement | null;
  if (sel) { sel.disabled = false; sel.focus(); }
});

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
  loadLayout();
  $('#menuBtn').innerHTML = icon('menu');
  wireLayout();
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
