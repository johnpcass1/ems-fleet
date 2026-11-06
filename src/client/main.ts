/** Entry point: decide between the login screen and the app, then keep the data fresh. */
import './style.css';
import { api, setAuthHook, setRouteGetter, startPolling, stopPolling, syncNow, resetSyncState } from './api';
import { S, COLS, D, LST, loadUi } from './state';
import { $, toast, val } from './util';
import { route } from './nav';
import { render, showLogin, showForcedChange, changeFormHtml } from './shell';
import { wireEvents, acts, FORMS } from './ui';
import { showDrawer, closeDrawer } from './dom';
import { resetUsersCache, syncUserForm } from './users-ui';
import { setProgressHook } from './files';
import { refreshAtt } from './views-b';

let started = false;

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
      if (S.me!.mustChangePassword) showForcedChange(); else await startApp();
    } catch (ex: any) {
      err.textContent = ex.message || 'Could not log in.';
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
acts['change-password'] = () => showDrawer('Change password', changeFormHtml());
acts['logout'] = async () => {
  try { await api('POST', '/auth/logout', {}, { quiet: true }); } catch { /* the session may already be gone */ }
  location.hash = '';
  toLogin('You are logged out.');
};
document.addEventListener('input', (e) => { if ((e.target as HTMLElement).id === 'uf-role') syncUserForm(); });
void FORMS;

async function boot() {
  loadUi();
  wireEvents();
  setRouteGetter(route);
  setProgressHook(refreshAtt);
  try {
    const r = await api('GET', '/auth/session', undefined, { quiet: true });
    if (!r.user) { showLogin(); return; }
    S.me = r.user;
    if (S.me!.mustChangePassword) showForcedChange(); else await startApp();
  } catch {
    showLogin();
  }
}
boot();
