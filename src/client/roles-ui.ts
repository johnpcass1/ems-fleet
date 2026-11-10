/**
 * Roles & permissions (super user and system administrators): what each ROLE can do by default.
 * A matrix with one row per permission (grouped like the Permissions drawer) and one column per role.
 * Edits are held in `draft` until Save; each role is saved on its own. People can still be adjusted one by one under Users > Permissions.
 */
import { ROLES, ROLE_LIST } from '../shared/constants';
import { PERM_GROUPS, SUPER_ONLY_KEYS, can as canActor, editableRoles, hasPerm, roleHas } from '../shared/perm';
import { D, S, scheduleRender } from './state';
import { esc, toast, run } from './util';
import { VIEWS } from './registry';
import { pageHead } from './bits';
import { confirmUI } from './dom';
import { saveRolePermissions, resetRolePermissions } from './actions';
import { usersCache, loadUsers } from './users-ui';

type Draft = Record<string, Record<string, boolean>>;
/** Unsaved changes: role -> key -> wanted value (effective, not just the difference). A role is present only while it differs from what is saved. */
const draft: Draft = {};
let pick = '';

const stored = (role: string): Record<string, boolean> => ((D.settings.main || {}).rolePerms || {})[role] || {};
const savedVal = (role: string, key: string) => roleHas(role, key, stored(role));
const val = (role: string, key: string) => (draft[role] && key in draft[role] ? draft[role][key] : savedVal(role, key));
const isDirty = (role: string) => !!draft[role] && Object.keys(draft[role]).length > 0;
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
    return `<td class="rc${ed ? '' : ' ro'}" data-role="${r}"><label class="rcell"><input type="checkbox" id="rp-${r}-${k}" data-rp="1" data-role="${r}" data-key="${k}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} aria-label="${esc(lbl)}" ${why ? `title="${esc(why)}"` : ''}><span class="rstate">${on ? 'Yes' : 'No'}</span></label>${on !== def ? `<span class="badge warn rchg" id="rchg-${r}-${k}" title="Changed from default">Changed<span class="sr"> from default</span></span>` : ''}</td>`;
  }).join('')}</tr>`).join('')).join('');
  const foot = `<tr class="rfoot"><th scope="row" class="pl">Save or reset a role</th>${ROLE_LIST.map((r) => {
    const ed = edit.includes(r as any);
    return `<td class="rc" data-role="${r}">${ed ? `<div class="rbtns"><button class="btn sm primary" type="button" data-act="role-save" data-role="${r}" id="rs-${r}" ${isDirty(r) ? '' : 'disabled'}>Save</button>
      <button class="btn sm ghost" type="button" data-act="role-reset" data-role="${r}" id="rr-${r}" ${differsFromDefault(r) ? '' : 'disabled'}>Reset to default</button></div>` : ''}</td>`;
  }).join('')}</tr>`;
  return `${pageHead('Roles & permissions')}
  <div class="warnbox info" id="rolesNote">These are the defaults for each role. You can still adjust one person under Users → Permissions.</div>
  <div class="panel"><div class="ph"><h2>What each role can do</h2><span class="badge">${S.me!.isSuperuser ? 'All roles' : 'Fleet manager and below'}</span></div>
  <div class="pn small muted">Tick what each role may do. <span class="badge warn">Changed</span> marks a setting that differs from the built-in default. Greyed columns are roles you cannot change. Backups are not listed: only the super user can use them.
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

export const roleActs: Record<string, any> = {
  'role-save': async (el: any) => {
    const r = el.dataset.role as string;
    if (!isDirty(r)) return;
    if (!usersCache) await loadUsers(true);
    if (!(await confirmUI({ title: `Save changes to ${ROLES[r as keyof typeof ROLES]}?`, message: `This changes ${impact(r)}. It takes effect within about 20 seconds, with no new login. Anyone with a personal change keeps it.`, label: 'Save changes' }))) return;
    if (await run(() => saveRolePermissions(r, overridesFor(r)))) { delete draft[r]; toast(`${ROLES[r as keyof typeof ROLES]} permissions saved`); scheduleRender(); }
  },
  'role-reset': async (el: any) => {
    const r = el.dataset.role as string;
    if (!usersCache) await loadUsers(true);
    if (!(await confirmUI({ title: `Reset ${ROLES[r as keyof typeof ROLES]} to the built-in defaults?`, message: `This changes ${impact(r)}, and discards any unsaved edits to this role.`, label: 'Reset to default', danger: true }))) return;
    if (await run(() => resetRolePermissions(r))) { delete draft[r]; toast(`${ROLES[r as keyof typeof ROLES]} reset to default`); scheduleRender(); }
  },
};
