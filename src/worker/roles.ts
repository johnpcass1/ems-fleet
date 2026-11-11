/**
 * Role-level permissions: what each ROLE can do by default. Stored in the settings record under `rolePerms`
 * ({ [role]: { [key]: boolean } }, only differences from the built-in defaults). Like `features`, it is written only
 * here; the ordinary settings save never touches it.
 *
 * Who: the super user edits any role; a system administrator edits fleet manager and every role below (not system administrator);
 * nobody else. Only the super user can grant Manage people or Change setup, and nobody can grant Backups (it is the super user's alone).
 */
import { z } from 'zod';
import type { Env } from './env';
import { Tx, SEQ, first } from './db';
import { bad, forbidden, notFound, parse } from './http';
import { ROLE_LIST } from '../shared/constants';
import { can, cleanRolePerms, editableRoles, hasPerm, NEVER_GRANTABLE, PERM_KEYS, roleHas, SUPER_ONLY_KEYS, type Actor } from '../shared/perm';

async function loadSettingsRaw(env: Env) {
  const old = await first<any>(env.DB, "SELECT data FROM settings WHERE id = 'main'");
  let cur: any = {};
  try { cur = old ? JSON.parse(old.data) : {}; } catch { /* ignore */ }
  return cur;
}
function target(actor: Actor, role: string) {
  if (!(ROLE_LIST as readonly string[]).includes(role)) throw notFound('There is no such role.');
  if (!editableRoles(actor).includes(role as any)) throw forbidden('You cannot change the permissions of that role.');
}

/** Check that `actor` may make every change in `next` (role -> wanted differences) against `all` (what is stored now). */
function checkGrants(actor: Actor, role: string, next: Record<string, boolean>, before: Record<string, boolean>) {
  for (const k of PERM_KEYS) {
    if (NEVER_GRANTABLE.includes(k)) continue;
    if (roleHas(role, k, next) && !roleHas(role, k, before)) {
      if (SUPER_ONLY_KEYS.includes(k) && !actor.isSuper) throw forbidden('Only the super user can grant that permission.');
      if (!can(actor, k)) throw forbidden('You can only grant permissions you have yourself.');
    }
  }
}

/** Write several roles at once (role -> its new differences from the built-in defaults), in one transaction with one audit row per role that changed. */
async function applyMany(env: Env, actor: Actor, changes: Record<string, Record<string, boolean>>, action: (role: string, next: Record<string, boolean>) => string) {
  const cur = await loadSettingsRaw(env);
  const all = cleanRolePerms(cur.rolePerms);
  const merged: Record<string, any> = { ...all };
  const changed: [string, Record<string, boolean>, Record<string, boolean>][] = [];
  for (const [role, next] of Object.entries(changes)) {
    const before = all[role] ?? {};
    checkGrants(actor, role, next, before);
    if (Object.keys(next).length) merged[role] = next; else delete merged[role];
    if (JSON.stringify(sortKeys(before)) !== JSON.stringify(sortKeys(next))) changed.push([role, before, next]);
  }
  if (changed.length) {
    const tx = new Tx(env.DB, actor);
    tx.run(
      `INSERT INTO settings (id, data, sample, seq, created_at, updated_at) VALUES ('main', ?, 0, ${SEQ}, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data=excluded.data, seq=excluded.seq, updated_at=excluded.updated_at`,
      JSON.stringify({ ...cur, rolePerms: merged }), tx.at, tx.at,
    );
    for (const [role, before, next] of changed) tx.audit(action(role, next), 'role', role, { role, overrides: before }, { role, overrides: next });
    await tx.commit();
  }
  return { ok: true, saved: changed.map(([r]) => r), roles: Object.fromEntries(Object.entries(changes)) };
}
const sortKeys = (o: Record<string, boolean>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** Keep only the keys that differ from the built-in default for `role`; reject unknown and never-grantable keys. */
function cleanFor(role: string, overrides: Record<string, boolean>) {
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (NEVER_GRANTABLE.includes(k)) throw bad('Backups are for the super user only and cannot be given to a role.');
    if (!PERM_KEYS.includes(k)) throw bad(`Unknown permission: ${k}.`);
    if (v !== hasPerm(role, k)) next[k] = v;
  }
  return next;
}

const rolePermsIn = z.object({ overrides: z.record(z.string(), z.boolean()) });
/** Replace one role's changes. The body lists the keys that differ from the built-in default; anything equal to it is dropped. */
export async function saveRolePermissions(env: Env, actor: Actor, role: string, body: unknown) {
  target(actor, role);
  const i = parse(rolePermsIn, body);
  const r = await applyMany(env, actor, { [role]: cleanFor(role, i.overrides) }, () => 'role.permissions');
  return { ok: true, role, overrides: r.roles[role] };
}
/** Clear all of one role's changes: back to the built-in defaults. */
export async function resetRolePermissions(env: Env, actor: Actor, role: string) {
  target(actor, role);
  await applyMany(env, actor, { [role]: {} }, () => 'role.reset');
  return { ok: true, role, overrides: {} };
}

const allRolesIn = z.object({ roles: z.record(z.string(), z.record(z.string(), z.boolean())) });
/**
 * Save several roles in one go (the single Save on the Roles & permissions page). Each listed role's changes are replaced by
 * what is sent (an empty object means "back to the built-in defaults"); roles not listed are left alone. Everything is
 * checked first, so either every role is saved or none is.
 */
export async function saveAllRolePermissions(env: Env, actor: Actor, body: unknown) {
  const i = parse(allRolesIn, body);
  const roles = Object.keys(i.roles);
  if (!roles.length) throw bad('Nothing to save.');
  const changes: Record<string, Record<string, boolean>> = {};
  for (const role of roles) { target(actor, role); changes[role] = cleanFor(role, i.roles[role]); }
  return applyMany(env, actor, changes, (_r, next) => (Object.keys(next).length ? 'role.permissions' : 'role.reset'));
}
