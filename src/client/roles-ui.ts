/**
 * Roles & permissions (super user and system administrators): what each ROLE can do by default.
 * A matrix with one row per permission (grouped like the Permissions drawer) and one column per role.
 * Edits (including Reset to default) are held in `draft` until the one Save changes button at the top right, which saves every
 * changed role together. People can still be adjusted one by one under Users > Permissions.
 */
import { ROLES, ROLE_LIST } from '../shared/constants';
import { PERM_GROUPS, SUPER_ONLY_KEYS, can as canActor, editableRoles, hasPerm, roleHas } from '../shared/perm';
import { agencySettings, S, scheduleRender } from './state';
import { esc, toast, run } from './util';
import { VIEWS } from './registry';
import { pageHead, actBtn } from './bits';
import { confirmUI } from './dom';
import { saveAllRolePermissions } from './actions';
import { usersCache, loadUsers } from './users-ui';

type Draft = Record<string, Record<string, boolean>>;
/** Unsaved changes: role -> key -> wanted value (effective, not just the difference). A role is present only while it differs from what is saved. */
const draft: Draft = {};
let pick = '';

const stored = (role: string): Record<string, boolean> => (agencySettings().rolePerms || {})[role] || {};
const savedVal = (role: string, key: string) => roleHas(role, key, stored(role));
const val = (role: string, key: string) => (draft[role] && key in draft[role] ? draft[role][key] : savedVal(role, key));
const isDirty = (role: string) => !!draft[role] && Object.keys(draft[role]).length > 0;
const dirtyRoles = () => ROLE_LIST.filter((r) => isDirty(r));
/** True while the Roles & permissions page has edits that are not saved (used to warn before leaving). */
export const rolesUnsaved = () => dirtyRoles().length > 0;
/** Does this role differ from the built-in defaults anywhere (as saved, or as drafted)? */
const differsFromDefault = (role: string) => PERM_GROUPS.some((g) => g.items.some(([k]) => val(role, k) !== hasPerm(role, k)));
const mine = () => (S.me ? editableRoles({ role: S.me.role, isSuper: !!S.me.isSuperuser }) : []);
const noun = (role: string, n: number) => (role === 'crew' ? (n === 1 ? 'crew member' : 'crew members') : `${ROLES[role as keyof typeof ROLES].toLowerCase()}${n === 1 ? '' : 's'}`);
const peopleIn = (role: string) => (usersCache ? usersCache.filter((u) => u.role === role && u.active).length : null);
const impact = (role: string) => { const n = peopleIn(role); return n === null ? `what people with the ${ROLES[role as keyof typeof ROLES]} role can do` : `what ${n} ${noun(role, n)} can do`; };

/** Why a cell can't be switched on by this person (or '' when it can). Switching something off is always allowed. */
function blockedOn(key: string): string {
  const me = S.me as any;
  if (SUPER_ONLY_KEYS.includes(key) && !me.isSuperuser) return 'Only the super user can grant this.';
  if (!canActor(me, key)) return 'You can only grant permissions you have yourself.';
  return '';
}

VIEWS.roles = function () {
  const edit = mine();
  if (!edit.length) return '<div class="warnbox bad">You do not have access to this page.</div>';
  loadUsers();
  if (!pick || !ROLE_LIST.includes(pick as any)) pick = edit[0];
  const th = (r: string) => `<th scope="col" class="rc" data-role="${r}"><span class="rname">${esc(ROLES[r as keyof typeof ROLES])}</span>${edit.includes(r as any) ? '' : '<span class="rro">View only</span>'}</th>`;
  const rows = PERM_GROUPS.map((g) => `<tr class="grp"><th scope="colgroup" colspan="${ROLE_LIST.length + 1}">${esc(g.title)}</th></tr>` + g.items.map(([k, label]) => `<tr id="rrow-${k}"><th scope="row" class="pl">${esc(label)}</th>${ROLE_LIST.map((r) => {
    const on = val(r, k), def = hasPerm(r, k), ed = edit.includes(r as any);
    const why = ed && !on ? blockedOn(k) : '';
    const dis = !ed || !!why;
    const lbl = `${ROLES[r]}: ${label}`;
    const uns = !!draft[r] && k in draft[r];
    return `<td class="rc${ed ? '' : ' ro'}${uns ? ' unsaved' : ''}" data-role="${r}"><label class="rcell"><input type="checkbox" id="rp-${r}-${k}" data-rp="1" data-role="${r}" data-key="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} aria-label="${esc(lbl)}" ${why ? `title="${esc(why)}"` : ''}></label>${on !== def ? `<span class="badge warn rchg" id="rchg-${r}-${k}" title="Changed from default">Changed<span class="sr"> from default</span></span>` : ''}</td>`;
  }).join('')}</tr>`).join('')).join('');
  const foot = `<tr class="rfoot"><th scope="row" class="pl">Back to the built-in defaults<span class="tiny muted rfhint">Fills in the defaults; press Save changes to keep them.</span></th>${ROLE_LIST.map((r) => {
    const ed = edit.includes(r as any);
    return `<td class="rc" data-role="${r}">${ed ? `<div class="rbtns"><button class="btn sm ghost" type="button" data-act="role-reset" data-role="${r}" id="rr-${r}" ${differsFromDefault(r) ? '' : 'disabled'}>Reset to default</button></div>` : ''}</td>`;
  }).join('')}</tr>`;
  const dirty = dirtyRoles();
  const nChg = dirty.reduce((n, r) => n + Object.keys(draft[r]).length, 0);
  const acts = `${dirty.length ? `<span class="small muted rdirty" id="rolesDirty" role="status">${nChg} unsaved ${nChg === 1 ? 'change' : 'changes'}</span>` : '<span class="sr" role="status"></span>'}
    <button class="btn" type="button" data-act="roles-discard" id="rolesDiscard" ${dirty.length ? '' : 'disabled'}>Discard changes</button>
    ${actBtn('Save changes', { id: 'rolesSave', act: 'roles-save', primary: true, icon: 'check', cls: 'keeplbl', disabled: !dirty.length })}`;
  return `${pageHead('Roles & permissions', { acts })}
  <div class="warnbox info" id="rolesNote">These are the defaults for each role. You can still adjust one person under Users → Permissions.</div>
  <div class="panel"><div class="ph"><h2>What each role can do</h2><span class="badge">${S.me!.isSuperuser ? 'All roles' : 'Fleet manager and below'}</span></div>
  <div class="pn small muted">Tick what each role may do, then press <b>Save changes</b> at the top right; nothing changes for anyone until you do. <span class="badge warn">Changed</span> marks a setting that differs from the built-in default. A highlighted box is not saved yet. Greyed columns are roles you cannot change. Backups are not listed: only the super user can use them.
    ${S.me!.isSuperuser ? '' : 'Manage people and Change setup can only be granted by the super user.'}</div>
  <div class="rpick"><label class="f"><span class="l">Role</span><select id="rp-pick" data-rolepick="1">${ROLE_LIST.map((r) => `<option value="${r}" ${r === pick ? 'selected' : ''}>${esc(ROLES[r])}${edit.includes(r as any) ? '' : ' (view only)'}</option>`).join('')}</select></label></div>
  <div class="tscroll" id="roleScroll" tabindex="0" role="region" aria-label="Role permissions table"><table class="t rolemx" id="roleMatrix" data-pick="${esc(pick)}"><thead><tr><th scope="col" class="pl">Permission</th>${ROLE_LIST.map(th).join('')}</tr></thead><tbody>${rows}${foot}</tbody></table></div></div>`;
};

export function roleCellChanged(el: HTMLInputElement) {
  const r = el.dataset.role as string, k = el.dataset.key as string;
  const d = (draft[r] = draft[r] || {});
  if (el.checked === savedVal(r, k)) delete d[k]; else d[k] = el.checked;
  if (!Object.keys(d).length) delete draft[r];
  scheduleRender();
}
export function rolePick(v: string) { pick = v; scheduleRender(); }
/** The saved difference from the built-in defaults for `role`, after the draft is applied. */
function overridesFor(role: string): Record<string, boolean> {
  const o: Record<string, boolean> = {};
  PERM_GROUPS.forEach((g) => g.items.forEach(([k]) => { const v = val(role, k); if (v !== hasPerm(role, k)) o[k] = v; }));
  return o;
}

/** Set every switch of `role` in the draft to the built-in default (saved with the others on Save changes). */
function draftDefaults(role: string) {
  const d: Record<string, boolean> = {};
  PERM_GROUPS.forEach((g) => g.items.forEach(([k]) => { const def = hasPerm(role, k); if (def !== savedVal(role, k)) d[k] = def; }));
  if (Object.keys(d).length) draft[role] = d; else delete draft[role];
}
const names = (rs: string[]) => { const n = rs.map((r) => ROLES[r as keyof typeof ROLES]); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

export const roleActs: Record<string, any> = {
  'roles-save': async () => {
    const rs = dirtyRoles();
    if (!rs.length) return;
    if (!usersCache) await loadUsers(true);
    const people = rs.map((r) => peopleIn(r));
    const total = people.every((n) => n !== null) ? people.reduce((a, b) => a + (b as number), 0) : null;
    const who = rs.length === 1 ? impact(rs[0]) : total === null ? `what people with these roles can do` : `what ${total} ${total === 1 ? 'person' : 'people'} can do`;
    if (!(await confirmUI({ title: rs.length === 1 ? `Save changes to ${names(rs)}?` : `Save changes to ${rs.length} roles?`, message: `${rs.length === 1 ? '' : `Roles: ${names(rs)}. `}This changes ${who}. It takes effect within about 20 seconds, with no new login. Anyone with a personal change keeps it.`, label: 'Save changes' }))) return;
    const body: Record<string, Record<string, boolean>> = {};
    rs.forEach((r) => { body[r] = overridesFor(r); });
    if (await run(() => saveAllRolePermissions(body))) { rs.forEach((r) => delete draft[r]); toast(rs.length === 1 ? `${names(rs)} permissions saved` : `Permissions saved for ${rs.length} roles`); scheduleRender(); }
  },
  'roles-discard': async () => {
    if (!rolesUnsaved()) return;
    if (!(await confirmUI({ title: 'Discard unsaved changes?', message: 'The boxes go back to what is saved now. Nothing is changed for anyone.', label: 'Discard changes', danger: true }))) return;
    Object.keys(draft).forEach((r) => delete draft[r]);
    scheduleRender();
  },
  'role-reset': (el: any) => {
    const r = el.dataset.role as string;
    draftDefaults(r);
    toast(`${ROLES[r as keyof typeof ROLES]}: defaults filled in. Press Save changes to keep them.`);
    scheduleRender();
  },
};

// Warn before the tab is closed or reloaded with unsaved role edits.
window.addEventListener('beforeunload', (e) => { if (rolesUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
