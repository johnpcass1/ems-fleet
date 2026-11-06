/** Users screen (fleet manager and system administrator) and the Backups panel (system administrator). */
import { ROLES, ROLE_LIST } from '../shared/constants';
import { D, LST, S, can, basesSorted } from './state';
import { $, $$, esc, fmtDT, fmtDate, toast, field, inp, selHtml, val, run } from './util';
import { VIEWS } from './registry';
import { showDrawer, closeDrawer, confirmUI } from './dom';
import { listUsers, createUser, updateUser, resetPassword, setUserActive, listBackups, backupStep } from './actions';
import { api } from './api';
import { scheduleRender } from './state';

export let usersCache: any[] | null = null;
export let backupsCache: any[] | null = null;
let loadingU = false, loadingB = false, usersErr = '';

export async function loadUsers(force = false) {
  if (loadingU || (usersCache && !force)) return;
  loadingU = true;
  try { usersCache = (await listUsers()).users; usersErr = ''; } catch (e: any) { usersErr = e.message || 'Could not load users.'; usersCache = usersCache || []; }
  loadingU = false;
  scheduleRender();
}
export async function loadBackups(force = false) {
  if (loadingB || (backupsCache && !force)) return;
  loadingB = true;
  try { backupsCache = (await listBackups()).backups; } catch { backupsCache = backupsCache || []; }
  loadingB = false;
  scheduleRender();
}
export const resetUsersCache = () => { usersCache = null; backupsCache = null; };

const roleChoices = () => ROLE_LIST.filter((r) => r !== 'system_admin' || S.me?.role === 'system_admin');
const scoped = (r: string) => r === 'base_supervisor' || r === 'crew';

VIEWS.users = function () {
  if (!can('users')) return '<div class="warnbox bad">You do not have access to this page.</div>';
  loadUsers();
  const list = usersCache;
  const bn = (id: string) => D.bases[id]?.name || id;
  const sysAdmin = S.me?.role === 'system_admin';
  return `<div class="vhead"><h1>Users</h1><div class="row"><button class="btn primary" data-act="add-user" id="addUser">Add user</button></div></div>
  <div class="warnbox">Accounts are created here and nowhere else. When you add a person or reset a password, the temporary password is shown <b>once</b>. Give it to the person yourself, in person or by phone. The system does not email passwords. They must choose their own password the first time they log in.</div>
  ${usersErr ? `<div class="warnbox bad" role="alert">${esc(usersErr)}</div>` : ''}
  <div class="panel" style="padding:0"><div class="tscroll"><table class="t" id="usersTable"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Bases / mechanic</th><th>Last login</th><th>State</th><th></th></tr></thead><tbody>
  ${list === null ? '<tr><td colspan="7" class="muted">Loading...</td></tr>' : list.map((u) => `<tr class="${u.active ? '' : 'muted'}"><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(ROLES[u.role] || u.role)}</td>
    <td>${scoped(u.role) ? esc((u.baseIds || []).map(bn).join(', ') || 'No base') : u.role === 'mechanic' ? esc(D.mechanics[u.mechanicId]?.name || 'No mechanic linked') : 'All'}</td>
    <td>${u.lastLoginAt ? fmtDT(u.lastLoginAt) : 'Never'}</td><td>${u.active ? (u.mustChangePassword ? '<span class="pill warn">Password not set yet</span>' : '<span class="pill ok">Active</span>') : '<span class="pill off">Deactivated</span>'}</td>
    <td><div class="row">${u.role === 'system_admin' && !sysAdmin ? '' : `<button class="btn sm" data-act="edit-user" data-id="${esc(u.id)}" id="eu-${esc(u.id)}">Edit</button>
      <button class="btn sm" data-act="reset-user" data-id="${esc(u.id)}" id="ru-${esc(u.id)}">Reset password</button>
      ${u.id === S.me.id ? '' : `<button class="btn sm ${u.active ? 'danger' : ''}" data-act="${u.active ? 'deactivate-user' : 'reactivate-user'}" data-id="${esc(u.id)}" id="du-${esc(u.id)}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}`}</div></td></tr>`).join('')}
  </tbody></table></div></div>
  ${can('backups') ? backupsPanel() : ''}`;
};

function backupsPanel() {
  loadBackups();
  const b = backupsCache;
  return `<div class="panel" id="backupsPanel"><div class="ph"><h2>Backups</h2><button class="btn sm" data-act="backup-now" id="backupNow">Back up now</button></div>
  <p class="small muted">A full copy of all fleet records is saved every night (about 03:00 Guyana time) and the last 30 are kept. Download one to keep it somewhere safe. See docs/RESTORE.md for how to restore.</p>
  <div class="tscroll"><table class="t"><thead><tr><th>Date</th><th class="n">Size</th><th></th></tr></thead><tbody>
  ${b === null ? '<tr><td colspan="3" class="muted">Loading...</td></tr>' : b.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="n">${(x.size / 1024).toFixed(0)} KB</td><td><a class="btn sm" href="/api/admin/backups/${esc(x.date)}" download id="bk-${esc(x.date)}">Download</a></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No backups yet. The first one is made tonight, or press Back up now.</td></tr>'}
  </tbody></table></div></div>`;
}

function userFormHtml(u: any) {
  const e = !!u;
  u = u || { role: 'viewer', baseIds: [] };
  const mechs = [['', 'Choose a mechanic'], ...LST.mechanics.map((m) => [m.id, m.name])];
  return `<form data-form="user" data-id="${e ? esc(u.id) : ''}" id="userForm" novalidate>
    ${field('Full name', inp('uf-name', u.name, 'text', 'required maxlength="120" autocomplete="off"'))}
    ${e ? field('Email', `<input id="uf-email" type="email" value="${esc(u.email)}" disabled>`, 'The email address cannot be changed.') : field('Email', inp('uf-email', '', 'email', 'required maxlength="200" autocomplete="off"'))}
    ${field('Role', selHtml('uf-role', roleChoices().map((r) => [r, ROLES[r]]), u.role))}
    <div id="uf-basewrap" ${scoped(u.role) ? '' : 'hidden'}><fieldset class="f"><legend class="l">Bases this person can see</legend>
      ${basesSorted().map((b) => `<label class="chk"><input type="checkbox" name="ufb" id="ufb-${esc(b.id)}" value="${esc(b.id)}" ${(u.baseIds || []).includes(b.id) ? 'checked' : ''}><span>${esc(b.name)}</span></label>`).join('')}</fieldset></div>
    <div id="uf-mechwrap" ${u.role === 'mechanic' ? '' : 'hidden'}>${field('Linked mechanic', selHtml('uf-mech', mechs, u.mechanicId || ''), 'This person only sees work orders assigned to this mechanic.')}</div>
    <p class="small muted" id="uf-help"></p>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="uf-cancel">Cancel</button><button class="btn primary" type="submit" id="uf-save">${e ? 'Save changes' : 'Create user'}</button></div></form>`;
}
function showTempPassword(title: string, who: string, pw: string) {
  showDrawer(title, `<p>Temporary password for <b>${esc(who)}</b>:</p><div class="pwbox" id="tempPw">${esc(pw)}</div>
    <div class="warnbox" style="margin-top:12px"><b>This is the only time it is shown.</b> Give it to ${esc(who)} yourself, in person or by phone. The system does not send it by email or message. They will be asked to choose their own password at their first login.</div>
    <div class="dfoot"><button class="btn" type="button" data-act="copy-pw" id="copyPw">Copy</button><button class="btn primary" type="button" data-act="close-drawer" id="pwDone">I have given it to them</button></div>`, { focusClose: false });
}

export const userForms: Record<string, any> = {
  user: async (f: any) => {
    const name = val('uf-name'), role = val('uf-role');
    if (!name) { toast('Enter a name.', true); return; }
    const baseIds = scoped(role) ? $$('input[name=ufb]:checked', f).map((x: any) => x.value) : [];
    const mechanicId = role === 'mechanic' ? val('uf-mech') || null : null;
    if (role === 'base_supervisor' && !baseIds.length) { toast('Pick at least one base for a base supervisor.', true); return; }
    if (role === 'mechanic' && !mechanicId) { toast('Link this person to a mechanic.', true); return; }
    const id = f.dataset.id;
    if (id) { if (await run(() => updateUser(id, { name, role, baseIds, mechanicId }))) { toast('User saved'); closeDrawer(); await loadUsers(true); } return; }
    const email = val('uf-email');
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter a valid email address.', true); return; }
    let r: any;
    if (await run(async () => { r = await createUser({ email, name, role, baseIds, mechanicId }); })) {
      await loadUsers(true);
      showTempPassword('User created', name, r.temporaryPassword);
    }
  },
};
export const userActs: Record<string, any> = {
  'add-user': () => { showDrawer('Add user', userFormHtml(null)); syncUserForm(); },
  'edit-user': (el: any) => { const u = (usersCache || []).find((x) => x.id === el.dataset.id); if (u) { showDrawer('Edit user', userFormHtml(u)); syncUserForm(); } },
  'reset-user': async (el: any) => {
    const u = (usersCache || []).find((x) => x.id === el.dataset.id);
    if (!u) return;
    if (!(await confirmUI({ title: `Reset password for ${u.name}?`, message: 'Their current password stops working and they are logged out. You will be shown a new temporary password once.', label: 'Reset password', danger: true }))) return;
    let r: any;
    if (await run(async () => { r = await resetPassword(u.id); })) { await loadUsers(true); showTempPassword('Password reset', u.name, r.temporaryPassword); }
  },
  'deactivate-user': async (el: any) => {
    const u = (usersCache || []).find((x) => x.id === el.dataset.id);
    if (!u) return;
    if (!(await confirmUI({ title: `Deactivate ${u.name}?`, message: 'They are logged out and cannot log in until reactivated. Their history stays.', label: 'Deactivate', danger: true }))) return;
    if (await run(() => setUserActive(u.id, false))) { toast('User deactivated'); await loadUsers(true); }
  },
  'reactivate-user': async (el: any) => { if (await run(() => setUserActive(el.dataset.id, true))) { toast('User reactivated'); await loadUsers(true); } },
  'copy-pw': async () => { try { await navigator.clipboard.writeText($('#tempPw').textContent); toast('Copied'); } catch { toast('Select the password and copy it by hand.', true); } },
  'backup-now': async (el: any) => {
    el.disabled = true;
    try {
      for (let i = 0; i < 60; i++) {
        const r = await backupStep(i === 0);
        if (r.status === 'done' || r.status === 'idle') break;
      }
      toast('Backup finished');
      await loadBackups(true);
    } catch (e: any) { toast(e.message || 'The backup did not finish.', true); }
    el.disabled = false;
  },
};
export function syncUserForm() {
  const r = val('uf-role');
  const bw = $('#uf-basewrap'), mw = $('#uf-mechwrap'), h = $('#uf-help');
  if (!bw) return;
  bw.hidden = !scoped(r);
  mw.hidden = r !== 'mechanic';
  const help: Record<string, string> = {
    system_admin: 'Everything, including users and backups.', fleet_manager: 'Manages the whole fleet, setup, approvals and users.',
    base_supervisor: 'Manages the units of the bases ticked above.', mechanic: 'Works on the work orders assigned to them.',
    crew: 'Reports problems and logs hours for the bases ticked above.', dispatcher: 'Sees the Dispatch screen only.', viewer: 'Can look but not change anything.',
  };
  h.textContent = help[r] || '';
}
void api;
