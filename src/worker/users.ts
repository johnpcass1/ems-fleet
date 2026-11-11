import { z } from 'zod';
import type { Env } from './env';
import { Tx, SEQ, all, first, b2i, agencyRow, inAgency } from './db';
import { bad, conflict, forbidden, notFound, parse, uid, zId, zText } from './http';
import { b64url, hashPassword, iterationsFor, passwordProblem } from './auth';
import { emailEnabled, getMailer, inviteMessage, resetMessage, setPasswordLink } from './mail';
import { newToken, retireUnused } from './tokens';
import { HttpError } from './http';
import { ROLE_LIST } from '../shared/constants';
import { can, canManageUser, cleanOverrides, effectivePerms, manageableRoles, NEVER_GRANTABLE, PERM_KEYS, roleHas, SUPER_ONLY_KEYS, type Actor } from '../shared/perm';
import { loadRolePerms } from './auth';
import { isSuperuserAccount } from './env';
import { checkSuperEmailAllowed, getAgency } from './agencies';

const publicUser = (r: any, env?: Env) => ({
  isSuperuser: env ? isSuperuserAccount(env, r.email, r.agency_id) : false, permOverrides: parseOverrides(r.perm_overrides),
  id: r.id, email: r.email, name: r.name, role: r.role, baseIds: safeJson(r.base_ids), mechanicId: r.mechanic_id ?? null,
  active: !!r.active, mustChangePassword: !!r.must_change_password, invited: isInvited(r), lastLoginAt: r.last_login_at ?? null, createdAt: r.created_at,
});
/** An invited person has no usable password until they use the link in their email. */
const UNUSABLE = 'unusable$';
const isInvited = (r: any) => String(r.password_hash || '').startsWith(UNUSABLE);
export const unusableHash = () => UNUSABLE + b64url(crypto.getRandomValues(new Uint8Array(16)));
function safeJson(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

const parseOverrides = (s: unknown) => { try { return cleanOverrides(JSON.parse(String(s || '{}'))); } catch { return {}; } };

function requireUsersPerm(actor: Actor) {
  if (!can(actor, 'users')) throw forbidden();
}
/**
 * Who may manage whom. The super user: everyone but themselves. Anyone else: only roles below their own (a system administrator
 * manages fleet managers and below, a fleet manager manages base supervisors and below). Nobody but the super user touches a super user's account.
 * Looking after your own account (name, bases) is allowed so long as the role does not change.
 */
function checkTarget(env: Env, actor: Actor, target: { id?: string; email: string; role: string; agency_id: string }, opts: { self?: boolean; allowReserved?: boolean } = {}) {
  // An account with the owner's email in any agency but the home one can never be changed (it may only be deactivated, see setActive).
  if (!opts.allowReserved) checkSuperEmailAllowed(env, target.agency_id, target.email);
  if (opts.self && target.id === actor.id) return;
  const isSuper = isSuperuserAccount(env, target.email, target.agency_id);
  if (isSuper && !actor.isSuper) throw forbidden('Only the super user can change the super user account.');
  if (!canManageUser(actor, { id: target.id ?? '', role: target.role, isSuper })) throw forbidden('You cannot manage that person.');
}
/** The role being given must be one this actor may hand out. */
function checkAssignRole(actor: Actor, role: string) {
  if (!manageableRoles(actor).includes(role as any)) throw forbidden('You cannot give people that role.');
}

export async function listUsers(env: Env, actor: Actor) {
  requireUsersPerm(actor);
  const rows = await all(env.DB, 'SELECT * FROM users WHERE agency_id = ? ORDER BY active DESC, name COLLATE NOCASE', actor.agencyId);
  return { users: rows.map((r) => publicUser(r, env)) };
}

const userBase = {
  name: zText(120).min(1, 'Enter a name.'),
  role: z.enum(ROLE_LIST),
  baseIds: z.array(zId).max(50).default([]),
  mechanicId: zId.nullish(),
};
const createIn = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200), ...userBase,
  password: z.string().max(200).optional(),
  invite: z.boolean().optional(),
});
const updateIn = z.object(userBase);
const passwordIn = z.object({ password: z.string().max(200) });

async function validateLinks(env: Env, agency: string, role: string, baseIds: string[], mechanicId: string | null | undefined) {
  for (const b of baseIds) if (!(await inAgency(env.DB, 'bases', agency, b))) throw bad('One of the bases does not exist.');
  if (mechanicId && !(await inAgency(env.DB, 'mechanics', agency, mechanicId))) throw bad('That mechanic does not exist.');
  if (role === 'base_supervisor' && !baseIds.length) throw bad('A base supervisor needs at least one base.');
  if (role === 'mechanic' && !mechanicId) throw bad('Link a mechanic so this person only sees their own work orders.');
}

const sendFailed = (reason: string) => new HttpError(502, `Couldn't send the email: ${reason}.`, 'email_failed');

/** Emails an invite or reset link. The link is already stored; if the send fails it is retired so no unseen live link is left. */
async function deliver(env: Env, token: string, purpose: 'invite' | 'reset', u: { id: string; email: string; name: string; role: string }, inviter: string, agency: { id: string; name: string }) {
  const mailer = getMailer(env);
  if (!mailer) return { ok: false as const, reason: 'email is not set up' };
  const link = setPasswordLink(env, token);
  const msg = purpose === 'invite' ? inviteMessage({ to: u.email, name: u.name, inviter, role: u.role, link, agency }) : resetMessage({ to: u.email, name: u.name, link, agency });
  const r = await mailer.send(msg);
  if (!r.ok) await retireUnused(env.DB, agency.id, u.id, purpose);
  return r;
}

export async function createUser(env: Env, actor: Actor, body: unknown) {
  requireUsersPerm(actor);
  const i = parse(createIn, body);
  const invite = i.invite === true;
  if (invite === (i.password !== undefined)) throw bad('Choose a password for this person, or send them an invite link.');
  if (invite && !emailEnabled(env)) throw bad('Email is not set up, so invite links cannot be sent. Choose a password instead.', 'email_disabled');
  if (i.password !== undefined) { const p = passwordProblem(i.password, i.email); if (p) throw bad(p); }
  checkAssignRole(actor, i.role);
  checkSuperEmailAllowed(env, actor.agencyId, i.email); // the owner's email only exists in the home agency
  await validateLinks(env, actor.agencyId, i.role, i.baseIds, i.mechanicId);
  if (await first(env.DB, 'SELECT 1 FROM users WHERE agency_id = ? AND email = ?', actor.agencyId, i.email)) throw conflict('Another user already has that email address.', 'duplicate_email');
  const id = uid('u');
  const tx = new Tx(env.DB, actor);
  const hash = invite ? unusableHash() : await hashPassword(i.password!, iterationsFor(env));
  tx.run(
    `INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at, agency_id) VALUES (?,?,?,?,?,?,?,1,?,${SEQ},?,?,?)`,
    id, i.email, i.name, i.role, JSON.stringify(i.baseIds), i.mechanicId ?? null, hash, invite ? 1 : 0, tx.at, tx.at, tx.agency,
  );
  let token = '';
  if (invite) { const t = await newToken(env.DB, tx.agency, id, 'invite', actor.id); token = t.token; tx.stmts.push(...t.stmts); }
  tx.audit('user.create', 'user', id, null, { email: i.email, name: i.name, role: i.role, baseIds: i.baseIds, how: invite ? 'invite' : 'password_set_by_admin' });
  await tx.commit();
  if (!invite) return { ok: true, id };
  const r = await deliver(env, token, 'invite', { id, email: i.email, name: i.name, role: i.role }, actor.name, (await getAgency(env.DB, actor.agencyId))!);
  return r.ok ? { ok: true, id, emailSent: true, email: i.email } : { ok: true, id, emailSent: false, email: i.email, emailError: r.reason };
}

async function targetFor(env: Env, actor: Actor, id: string) {
  requireUsersPerm(actor);
  const u = await agencyRow<any>(env.DB, 'users', actor.agencyId, id); // another agency's person is "not found"
  if (!u) throw notFound();
  checkTarget(env, actor, u, { self: true });
  if (!u.active) throw bad('This account is deactivated. Reactivate it first.');
  return u;
}
/** Issue a fresh link for this person, email it, and report whether the email went. */
async function issueAndSend(env: Env, actor: Actor, u: any, purpose: 'invite' | 'reset', audit: string) {
  if (!emailEnabled(env)) throw bad('Email is not set up. Use Set password instead.', 'email_disabled');
  const tx = new Tx(env.DB, actor);
  const t = await newToken(env.DB, tx.agency, u.id, purpose, actor.id);
  tx.stmts.push(...t.stmts);
  tx.audit(audit, 'user', u.id, null, { email: u.email });
  await tx.commit();
  const r = await deliver(env, t.token, purpose, u, actor.name, (await getAgency(env.DB, actor.agencyId))!);
  if (!r.ok) throw sendFailed(r.reason);
  return { ok: true, emailSent: true, email: u.email };
}

/** Send a new invite to someone who has not set a password yet. */
export async function resendInvite(env: Env, actor: Actor, id: string) {
  const u = await targetFor(env, actor, id);
  if (!isInvited(u)) throw bad(`${u.name} has already set a password. Use Send reset link instead.`);
  return issueAndSend(env, actor, u, 'invite', 'user.invite_resend');
}
/** Email a reset link. Their current password keeps working until they use the link. */
export async function sendResetLink(env: Env, actor: Actor, id: string) {
  const u = await targetFor(env, actor, id);
  return isInvited(u) ? issueAndSend(env, actor, u, 'invite', 'user.invite_resend') : issueAndSend(env, actor, u, 'reset', 'user.reset_link');
}

/** An administrator chooses a password for someone. They are not forced to change it. Never logged or returned. */
export async function setPassword(env: Env, actor: Actor, id: string, body: unknown) {
  requireUsersPerm(actor);
  const i = parse(passwordIn, body);
  const u = await agencyRow<any>(env.DB, 'users', actor.agencyId, id);
  if (!u) throw notFound();
  if (u.id !== actor.id) checkTarget(env, actor, u);
  if (u.id === actor.id) throw bad('Use Change password for your own account.');
  const p = passwordProblem(i.password, u.email);
  if (p) throw bad(p);
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET password_hash=?, must_change_password=0, seq=${SEQ}, updated_at=? WHERE id=? AND agency_id=?`, await hashPassword(i.password, iterationsFor(env)), tx.at, id, tx.agency);
  tx.run('DELETE FROM sessions WHERE user_id = ? AND agency_id = ?', id, tx.agency);
  tx.run('DELETE FROM login_attempts WHERE agency_id = ? AND email = ?', tx.agency, u.email);
  tx.run('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND agency_id = ? AND used_at IS NULL', tx.at, id, tx.agency);
  tx.audit('user.set_password', 'user', id, null, { email: u.email });
  await tx.commit();
  return { ok: true };
}

export async function updateUser(env: Env, actor: Actor, id: string, body: unknown) {
  requireUsersPerm(actor);
  const i = parse(updateIn, body);
  const u = await agencyRow<any>(env.DB, 'users', actor.agencyId, id);
  if (!u) throw notFound();
  checkTarget(env, actor, u, { self: true });
  if (u.id === actor.id && i.role !== u.role) throw bad('You cannot change your own role.');
  if (u.id === actor.id && !actor.isSuper) {
    // Bases and the linked mechanic decide what someone can see and work on, so nobody widens their own reach.
    const sameBases = JSON.stringify([...safeJson(u.base_ids)].sort()) === JSON.stringify([...i.baseIds].sort());
    if (!sameBases || (i.mechanicId ?? null) !== (u.mechanic_id ?? null)) throw forbidden('You cannot change your own bases or linked mechanic. Ask the person above you.');
  }
  if (u.id !== actor.id || i.role !== u.role) checkAssignRole(actor, i.role);
  await validateLinks(env, actor.agencyId, i.role, i.baseIds, i.mechanicId);
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET name=?, role=?, base_ids=?, mechanic_id=?, seq=${SEQ}, updated_at=? WHERE id=? AND agency_id=?`, i.name, i.role, JSON.stringify(i.baseIds), i.mechanicId ?? null, tx.at, id, tx.agency);
  tx.audit('user.update', 'user', id, { name: u.name, role: u.role, baseIds: safeJson(u.base_ids), mechanicId: u.mechanic_id }, { name: i.name, role: i.role, baseIds: i.baseIds, mechanicId: i.mechanicId ?? null });
  await tx.commit();
  return { ok: true };
}

export async function setActive(env: Env, actor: Actor, id: string, active: boolean) {
  requireUsersPerm(actor);
  const u = await agencyRow<any>(env.DB, 'users', actor.agencyId, id);
  if (!u) throw notFound();
  if (u.id !== actor.id) checkTarget(env, actor, u, { allowReserved: !active }); // a stray account with the owner's email may be switched off, never on
  if (u.id === actor.id) throw bad('You cannot deactivate your own account.');
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET active=?, seq=${SEQ}, updated_at=? WHERE id=? AND agency_id=?`, b2i(active), tx.at, id, tx.agency);
  if (!active) tx.run('DELETE FROM sessions WHERE user_id = ? AND agency_id = ?', id, tx.agency);
  tx.audit(active ? 'user.reactivate' : 'user.deactivate', 'user', id, { active: !!u.active }, { active });
  await tx.commit();
  return { ok: true };
}

/**
 * Replace one person's permission changes. The body lists only the keys to change from the role default; anything equal to the default is dropped.
 * "Role default" here means the role's built-in default with any change made on the Roles & permissions screen.
 * Rules: only the super user and system administrators may do this (a system administrator: fleet managers and below; fleet managers may not);
 * you cannot edit yourself; you can only turn ON what you effectively have yourself; users and setup can only be granted by the super user;
 * backups can never be granted. Turning things off is always allowed.
 */
const permsIn = z.object({ overrides: z.record(z.string(), z.boolean()) });
export async function setPermissions(env: Env, actor: Actor, id: string, body: unknown) {
  requireUsersPerm(actor);
  if (!actor.isSuper && actor.role !== 'system_admin') throw forbidden('Only the super user and system administrators can change a person\'s permissions.');
  const i = parse(permsIn, body);
  const u = await agencyRow<any>(env.DB, 'users', actor.agencyId, id);
  if (!u) throw notFound();
  if (u.id === actor.id) throw forbidden('You cannot change your own permissions.');
  checkTarget(env, actor, u);
  for (const k of Object.keys(i.overrides)) {
    if (NEVER_GRANTABLE.includes(k)) throw bad('Backups are for the super user only and cannot be given to a person.');
    if (!PERM_KEYS.includes(k)) throw bad(`Unknown permission: ${k}.`);
  }
  const before = parseOverrides(u.perm_overrides);
  const ro = (await loadRolePerms(env.DB, actor.agencyId))[u.role] ?? {};
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(i.overrides)) if (v !== roleHas(u.role, k, ro)) next[k] = v;
  const was = effectivePerms({ role: u.role, permOverrides: before, roleOverrides: ro }), will = effectivePerms({ role: u.role, permOverrides: next, roleOverrides: ro });
  for (const k of PERM_KEYS) {
    if (will[k] && !was[k]) {
      if (SUPER_ONLY_KEYS.includes(k) && !actor.isSuper) throw forbidden('Only the super user can grant that permission.');
      if (!can(actor, k)) throw forbidden('You can only grant permissions you have yourself.');
    }
  }
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET perm_overrides=?, seq=${SEQ}, updated_at=? WHERE id=? AND agency_id=?`, JSON.stringify(next), tx.at, id, tx.agency);
  tx.audit('user.permissions', 'user', id, { email: u.email, overrides: before }, { email: u.email, overrides: next });
  await tx.commit();
  return { ok: true, overrides: next };
}
