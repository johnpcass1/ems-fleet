/** Users screen (fleet manager and system administrator) and the Backups panel (system administrator). */
import { ROLES, ROLE_LIST } from '../shared/constants';
import { PERM_GROUPS, SUPER_ONLY_KEYS, canManageUser, can as canActor, hasPerm, manageableRoles } from '../shared/perm';
import { D, LST, S, can, basesSorted, featureUploads } from './state';
import { $, $$, esc, fmtDT, fmtDate, toast, field, inp, selHtml, val, run } from './util';
import { VIEWS } from './registry';
import { pageHead, actBtn } from './bits';
import { icon } from './icons';
import { showDrawer, closeDrawer, confirmUI } from './dom';
import { listUsers, createUser, updateUser, setUserPassword, resendInvite, sendResetLink, setUserActive, saveUserPermissions, listBackups, backupStep } from './actions';
import { pwFieldsHtml, passwordProblem } from './accounts-ui';
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

/** Roles this person may hand out (the super user: all; others: only roles below their own). Editing yourself keeps your own role. */
const roleChoices = (current?: string) => ROLE_LIST.filter((r) => (S.me ? manageableRoles(S.me).includes(r) : false) || r === current);
const mayManage = (u: any) => !!S.me && canManageUser({ id: S.me.id, role: S.me.role, isSuper: !!S.me.isSuperuser }, { id: u.id, role: u.role, isSuper: !!u.isSuperuser });
const scoped = (r: string) => r === 'base_supervisor' || r === 'crew';

VIEWS.users = function () {
  if (!can('users')) return '<div class="warnbox bad">You do not have access to this page.</div>';
  loadUsers();
  const list = usersCache;
  const bn = (id: string) => D.bases[id]?.name || id;
  return `${pageHead('Users',{acts:actBtn('Add user',{id:'addUser',act:'add-user',primary:true,icon:'plus'})})}
  <div class="warnbox info" id="usersNote">${S.emailEnabled ? 'Add a person by choosing their password, or by emailing them a link so they choose their own. You can also set a new password or send a reset link at any time.' : 'Email isn’t set up, so you choose people’s passwords here. See docs/EMAIL.md to let people reset their own.'}</div>
  ${usersErr ? `<div class="warnbox bad" role="alert">${esc(usersErr)}</div>` : ''}
  <div class="panel"><div class="tscroll"><table class="t" id="usersTable"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Bases / mechanic</th><th>Last login</th><th>State</th><th></th></tr></thead><tbody>
  ${list === null ? '<tr><td colspan="7" class="muted">Loading...</td></tr>' : list.map((u) => `<tr class="${u.active ? '' : 'muted'}"><td><b>${esc(u.name)}</b>${u.isSuperuser?' <span class="badge acc" title="Set in code. Has every permission.">Super user</span>':''}${Object.keys(u.permOverrides||{}).length?' <span class="badge" title="Has permission changes from the role defaults">Custom permissions</span>':''}</td><td>${esc(u.email)}</td><td>${esc(ROLES[u.role] || u.role)}</td>
    <td>${scoped(u.role) ? esc((u.baseIds || []).map(bn).join(', ') || 'No base') : u.role === 'mechanic' ? esc(D.mechanics[u.mechanicId]?.name || 'No mechanic linked') : 'All'}</td>
    <td>${u.lastLoginAt ? fmtDT(u.lastLoginAt) : 'Never'}</td><td>${u.active ? (u.invited ? '<span class="badge warn">Invited — not yet set up</span>' : u.mustChangePassword ? '<span class="badge warn">Password not set yet</span>' : '<span class="badge ok">Active</span>') : '<span class="badge off">Deactivated</span>'}</td>
    <td class="c-act"><div class="row tight">${!mayManage(u) && u.id !== S.me.id ? '' : `<button class="btn sm ghost" data-act="edit-user" data-id="${esc(u.id)}" id="eu-${esc(u.id)}">Edit</button>
      ${mayManage(u) ? `<button class="btn sm ghost" data-act="perm-user" data-id="${esc(u.id)}" id="pm-${esc(u.id)}">Permissions</button>` : ''}
      ${u.id === S.me.id ? '' : `<button class="btn sm ghost" data-act="setpw-user" data-id="${esc(u.id)}" id="sp-${esc(u.id)}">Set password</button>`}
      ${S.emailEnabled && u.active ? `<button class="btn sm ghost" data-act="${u.invited ? 'invite-user' : 'reset-user'}" data-id="${esc(u.id)}" id="${u.invited ? 'ri' : 'ru'}-${esc(u.id)}">${u.invited ? 'Resend invite' : 'Send reset link'}</button>` : ''}
      ${u.id === S.me.id ? '' : `<button class="btn sm ghost ${u.active ? 'danger' : ''}" data-act="${u.active ? 'deactivate-user' : 'reactivate-user'}" data-id="${esc(u.id)}" id="du-${esc(u.id)}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}`}</div></td></tr>`).join('')}
  </tbody></table></div></div>
  ${can('backups') ? backupsPanel() : ''}`;
};

function backupsPanel() {
  loadBackups();
  const b = backupsCache;
  return `<div class="panel" id="backupsPanel"><div class="ph"><h2>Backups</h2><button class="btn sm" data-act="backup-now" id="backupNow">Back up now</button></div>
  <div class="pn small muted">A full copy of all fleet records is saved every night (about 03:00 Guyana time) and the last 30 are kept. Download one to keep it somewhere safe. See docs/RESTORE.md for how to restore.</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Date</th><th class="n">Size</th><th></th></tr></thead><tbody>
  ${b === null ? '<tr><td colspan="3" class="muted">Loading...</td></tr>' : b.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="n">${(x.size / 1024).toFixed(0)} KB</td><td><a class="btn sm" href="/api/admin/backups/${esc(x.date)}" download id="bk-${esc(x.date)}">${icon('download')}Download</a></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No backups yet. The first one is made tonight, or press Back up now.</td></tr>'}
  </tbody></table></div></div>`;
}

function userFormHtml(u: any) {
  const e = !!u;
  u = u || { role: 'viewer', baseIds: [] };
  const mechs = [['', 'Choose a mechanic'], ...LST.mechanics.map((m) => [m.id, m.name])];
  return `<form data-form="user" data-id="${e ? esc(u.id) : ''}" id="userForm" novalidate>
    ${field('Full name', inp('uf-name', u.name, 'text', 'required maxlength="120" autocomplete="off"'))}
    ${e ? field('Email', `<input id="uf-email" type="email" value="${esc(u.email)}" disabled>`, 'The email address cannot be changed.') : field('Email', inp('uf-email', '', 'email', 'required maxlength="200" autocomplete="off"'))}
    ${field('Role', selHtml('uf-role', roleChoices(e ? u.role : undefined).map((r) => [r, ROLES[r]]), u.role))}
    <div id="uf-basewrap" ${scoped(u.role) ? '' : 'hidden'}><fieldset class="f"><legend class="l">Bases this person can see</legend>
      ${basesSorted().map((b) => `<label class="chk"><input type="checkbox" name="ufb" id="ufb-${esc(b.id)}" value="${esc(b.id)}" ${(u.baseIds || []).includes(b.id) ? 'checked' : ''}><span>${esc(b.name)}</span></label>`).join('')}</fieldset></div>
    <div id="uf-mechwrap" ${u.role === 'mechanic' ? '' : 'hidden'}>${field('Linked mechanic', selHtml('uf-mech', mechs, u.mechanicId || ''), 'This person only sees work orders assigned to this mechanic.')}</div>
    <p class="small muted" id="uf-help"></p>
    ${e ? '' : `<fieldset class="f"><legend class="l">Password</legend>
      <label class="chk"><input type="radio" name="uf-how" id="uf-how-pw" value="password" checked><span>Set a password now</span></label>
      ${S.emailEnabled ? '<label class="chk"><input type="radio" name="uf-how" id="uf-how-invite" value="invite"><span>Email an invite link</span></label>' : ''}</fieldset>
    <div id="uf-pwwrap">${pwFieldsHtml('uf')}</div>
    ${S.emailEnabled ? '<p class="small muted" id="uf-invitehelp" hidden>They get an email with a link, valid for 7 days, to choose their own password.</p>' : ''}`}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="uf-cancel">Cancel</button><button class="btn primary" type="submit" id="uf-save">${e ? 'Save changes' : 'Create user'}</button></div></form>`;
}
/** The Permissions drawer: every permission as a switch showing what this person can do now. */
function permsFormHtml(u: any) {
  const ov = u.permOverrides || {};
  const me = S.me as any;
  const eff = (k: string) => (typeof ov[k] === 'boolean' ? ov[k] : hasPerm(u.role, k));
  const group = (g: { title: string; items: [string, string][] }) => `<fieldset class="f permgrp"><legend class="l">${esc(g.title)}</legend>${g.items.map(([k, label]) => {
    const on = eff(k), def = hasPerm(u.role, k);
    const blocked = !on && (SUPER_ONLY_KEYS.includes(k) ? !me.isSuperuser : !canActor(me, k));
    const why = blocked ? (SUPER_ONLY_KEYS.includes(k) ? 'Only the super user can grant this.' : 'You can only grant permissions you have yourself.') : k === 'upload' && !featureUploads() ? 'Uploads are also off for everyone until the super user turns them on.' : '';
    return `<div class="permrow" id="prow-${k}"><label class="chk" for="perm-${k}"><input type="checkbox" id="perm-${k}" data-perm="${k}" data-def="${def ? 1 : 0}" ${on ? 'checked' : ''} ${blocked ? 'disabled' : ''} ${why ? `aria-describedby="why-${k}"` : ''}>
      <span>${esc(label)} <span class="badge warn" id="chg-${k}" ${on === def ? 'hidden' : ''}>Changed</span>${why ? `<br><span class="hint" id="why-${k}">${esc(why)}</span>` : ''}</span></label>
      ${blocked ? '' : `<button type="button" class="btn link sm" data-act="perm-reset" data-key="${k}" id="rst-${k}" ${on === def ? 'hidden' : ''}>Reset to role default</button>`}</div>`;
  }).join('')}</fieldset>`;
  return `<form data-form="perms" data-id="${esc(u.id)}" id="permsForm" novalidate>
    <p style="margin-top:0"><b>${esc(u.name)}</b> <span class="muted">· ${esc(ROLES[u.role] || u.role)}</span></p>
    <p class="small muted">Switches show what this person can do now. “Changed” marks anything different from what their role allows. If you change their role later, these changes stay and are compared with the new role’s defaults. Where a unit’s base matters, the person’s bases still apply.</p>
    ${PERM_GROUPS.map(group).join('')}
    <div class="dfoot"><button class="btn ghost" type="button" data-act="perm-reset-all" id="perm-resetall">Reset all to role default</button><button class="btn" type="button" data-act="close-drawer" id="perm-cancel">Cancel</button><button class="btn primary" type="submit" id="perm-save">Save permissions</button></div></form>`;
}
export function syncPermsForm() {
  document.querySelectorAll<HTMLInputElement>('#permsForm input[data-perm]').forEach((c) => {
    const k = c.dataset.perm, changed = c.checked !== (c.dataset.def === '1');
    const b = document.getElementById('chg-' + k), r = document.getElementById('rst-' + k);
    if (b) b.hidden = !changed;
    if (r) r.hidden = !changed;
  });
}
function setPwFormHtml(u: any) {
  return `<form data-form="setpw" data-id="${esc(u.id)}" id="setPwForm" novalidate>
    <p>Choose a new password for <b>${esc(u.name)}</b>. Their current password stops working and they are logged out everywhere. They will not be asked to change it, but they can at any time with the Password button.</p>
    ${pwFieldsHtml('sp')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="sp-cancel">Cancel</button><button class="btn primary" type="submit" id="sp-save">Set password</button></div></form>`;
}
const pwVal = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

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
    const invite = (document.querySelector('input[name=uf-how]:checked') as HTMLInputElement | null)?.value === 'invite' && S.emailEnabled;
    let payload: any = { email, name, role, baseIds, mechanicId };
    if (invite) payload.invite = true;
    else {
      const problem = passwordProblem(pwVal('uf-pw'), pwVal('uf-pw2'), email);
      if (problem) { toast(problem, true); return; }
      payload.password = pwVal('uf-pw');
    }
    let r: any;
    if (await run(async () => { r = await createUser(payload); })) {
      await loadUsers(true);
      closeDrawer();
      if (!invite) toast(`Account created. Give ${name} their password.`);
      else if (r.emailSent) toast(`Email sent to ${r.email}`);
      else toast(`Account created, but we couldn't send the email: ${r.emailError}. Use Resend invite to try again.`, true);
    }
  },
  perms: async (f: any) => {
    const u = (usersCache || []).find((x) => x.id === f.dataset.id);
    if (!u) return;
    const overrides: Record<string, boolean> = {};
    f.querySelectorAll('input[data-perm]').forEach((c: HTMLInputElement) => { if (c.checked !== (c.dataset.def === '1')) overrides[c.dataset.perm as string] = c.checked; });
    if (await run(() => saveUserPermissions(u.id, overrides))) { toast(`Permissions saved for ${u.name}`); closeDrawer(); await loadUsers(true); }
  },
  setpw: async (f: any) => {
    const u = (usersCache || []).find((x) => x.id === f.dataset.id);
    if (!u) return;
    const problem = passwordProblem(pwVal('sp-pw'), pwVal('sp-pw2'), u.email);
    if (problem) { toast(problem, true); return; }
    if (await run(() => setUserPassword(u.id, pwVal('sp-pw')))) { closeDrawer(); toast(`Password set. Give ${u.name} their new password.`); await loadUsers(true); }
  },
};
export const userActs: Record<string, any> = {
  'add-user': () => { showDrawer('Add user', userFormHtml(null)); syncUserForm(); },
  'edit-user': (el: any) => { const u = (usersCache || []).find((x) => x.id === el.dataset.id); if (u) { showDrawer('Edit user', userFormHtml(u)); syncUserForm(); } },
  'perm-user': (el: any) => { const u = (usersCache || []).find((x) => x.id === el.dataset.id); if (u && mayManage(u)) showDrawer(`Permissions for ${u.name}`, permsFormHtml(u)); },
  'perm-reset': (el: any) => { const c = document.getElementById('perm-' + el.dataset.key) as HTMLInputElement | null; if (c && !c.disabled) { c.checked = c.dataset.def === '1'; syncPermsForm(); } },
  'perm-reset-all': () => { document.querySelectorAll<HTMLInputElement>('#permsForm input[data-perm]').forEach((c) => { if (!c.disabled) c.checked = c.dataset.def === '1'; }); syncPermsForm(); },
  'setpw-user': (el: any) => { const u = (usersCache || []).find((x) => x.id === el.dataset.id); if (u) showDrawer(`Set password for ${u.name}`, setPwFormHtml(u)); },
  'reset-user': async (el: any) => {
    const u = (usersCache || []).find((x) => x.id === el.dataset.id);
    if (!u) return;
    let r: any;
    if (await run(async () => { r = await sendResetLink(u.id); })) toast(`Email sent to ${r.email}`);
  },
  'invite-user': async (el: any) => {
    const u = (usersCache || []).find((x) => x.id === el.dataset.id);
    if (!u) return;
    let r: any;
    if (await run(async () => { r = await resendInvite(u.id); })) toast(`Email sent to ${r.email}`);
  },
  'deactivate-user': async (el: any) => {
    const u = (usersCache || []).find((x) => x.id === el.dataset.id);
    if (!u) return;
    if (!(await confirmUI({ title: `Deactivate ${u.name}?`, message: 'They are logged out and cannot log in until reactivated. Their history stays.', label: 'Deactivate', danger: true }))) return;
    if (await run(() => setUserActive(u.id, false))) { toast('User deactivated'); await loadUsers(true); }
  },
  'reactivate-user': async (el: any) => { if (await run(() => setUserActive(el.dataset.id, true))) { toast('User reactivated'); await loadUsers(true); } },
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
  const how = (document.querySelector('input[name=uf-how]:checked') as HTMLInputElement | null)?.value;
  const pw = $('#uf-pwwrap'), ih = $('#uf-invitehelp');
  if (pw) pw.hidden = how === 'invite';
  if (ih) ih.hidden = how !== 'invite';
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
