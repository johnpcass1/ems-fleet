import { z } from 'zod';
import type { Env } from './env';
import { Tx, SEQ, all, first, b2i } from './db';
import { bad, conflict, forbidden, notFound, parse, uid, zId, zText } from './http';
import { hashPassword, iterationsFor, tempPassword } from './auth';
import { ROLE_LIST } from '../shared/constants';
import { hasPerm, type Actor } from '../shared/perm';

const publicUser = (r: any) => ({
  id: r.id, email: r.email, name: r.name, role: r.role, baseIds: safeJson(r.base_ids), mechanicId: r.mechanic_id ?? null,
  active: !!r.active, mustChangePassword: !!r.must_change_password, lastLoginAt: r.last_login_at ?? null, createdAt: r.created_at,
});
function safeJson(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

function requireUsersPerm(actor: Actor) {
  if (!hasPerm(actor.role, 'users')) throw forbidden();
}
/** Only a system administrator may create, edit or reset a system administrator. */
function checkTargetRole(actor: Actor, targetRole: string) {
  if (targetRole === 'system_admin' && actor.role !== 'system_admin') throw forbidden('Only a system administrator can manage system administrator accounts.');
}

export async function listUsers(env: Env, actor: Actor) {
  requireUsersPerm(actor);
  const rows = await all(env.DB, 'SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE');
  return { users: rows.map(publicUser) };
}

const userBase = {
  name: zText(120).min(1, 'Enter a name.'),
  role: z.enum(ROLE_LIST),
  baseIds: z.array(zId).max(50).default([]),
  mechanicId: zId.nullish(),
};
const createIn = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200), ...userBase });
const updateIn = z.object(userBase);

async function validateLinks(env: Env, role: string, baseIds: string[], mechanicId: string | null | undefined) {
  for (const b of baseIds) if (!(await first(env.DB, 'SELECT 1 FROM bases WHERE id = ?', b))) throw bad('One of the bases does not exist.');
  if (mechanicId && !(await first(env.DB, 'SELECT 1 FROM mechanics WHERE id = ?', mechanicId))) throw bad('That mechanic does not exist.');
  if (role === 'base_supervisor' && !baseIds.length) throw bad('A base supervisor needs at least one base.');
  if (role === 'mechanic' && !mechanicId) throw bad('Link a mechanic so this person only sees their own work orders.');
}

export async function createUser(env: Env, actor: Actor, body: unknown) {
  requireUsersPerm(actor);
  const i = parse(createIn, body);
  checkTargetRole(actor, i.role);
  await validateLinks(env, i.role, i.baseIds, i.mechanicId);
  if (await first(env.DB, 'SELECT 1 FROM users WHERE email = ?', i.email)) throw conflict('Another user already has that email address.', 'duplicate_email');
  const pw = tempPassword();
  const id = uid('u');
  const tx = new Tx(env.DB, actor);
  tx.run(
    `INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,1,${SEQ},?,?)`,
    id, i.email, i.name, i.role, JSON.stringify(i.baseIds), i.mechanicId ?? null, await hashPassword(pw, iterationsFor(env)), tx.at, tx.at,
  );
  tx.audit('user.create', 'user', id, null, { email: i.email, name: i.name, role: i.role, baseIds: i.baseIds });
  await tx.commit();
  return { ok: true, id, temporaryPassword: pw };
}

export async function updateUser(env: Env, actor: Actor, id: string, body: unknown) {
  requireUsersPerm(actor);
  const i = parse(updateIn, body);
  const u = await first<any>(env.DB, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound();
  checkTargetRole(actor, u.role);
  checkTargetRole(actor, i.role);
  if (u.id === actor.id && i.role !== u.role) throw bad('You cannot change your own role.');
  await validateLinks(env, i.role, i.baseIds, i.mechanicId);
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET name=?, role=?, base_ids=?, mechanic_id=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.name, i.role, JSON.stringify(i.baseIds), i.mechanicId ?? null, tx.at, id);
  tx.audit('user.update', 'user', id, { name: u.name, role: u.role, baseIds: safeJson(u.base_ids), mechanicId: u.mechanic_id }, { name: i.name, role: i.role, baseIds: i.baseIds, mechanicId: i.mechanicId ?? null });
  await tx.commit();
  return { ok: true };
}

export async function resetPassword(env: Env, actor: Actor, id: string) {
  requireUsersPerm(actor);
  const u = await first<any>(env.DB, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound();
  checkTargetRole(actor, u.role);
  const pw = tempPassword();
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET password_hash=?, must_change_password=1, seq=${SEQ}, updated_at=? WHERE id=?`, await hashPassword(pw, iterationsFor(env)), tx.at, id);
  tx.run('DELETE FROM sessions WHERE user_id = ?', id);
  tx.run('DELETE FROM login_attempts WHERE email = ?', u.email);
  tx.audit('user.reset_password', 'user', id, null, { email: u.email });
  await tx.commit();
  return { ok: true, temporaryPassword: pw };
}

export async function setActive(env: Env, actor: Actor, id: string, active: boolean) {
  requireUsersPerm(actor);
  const u = await first<any>(env.DB, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound();
  checkTargetRole(actor, u.role);
  if (u.id === actor.id) throw bad('You cannot deactivate your own account.');
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE users SET active=?, seq=${SEQ}, updated_at=? WHERE id=?`, b2i(active), tx.at, id);
  if (!active) tx.run('DELETE FROM sessions WHERE user_id = ?', id);
  tx.audit(active ? 'user.reactivate' : 'user.deactivate', 'user', id, { active: !!u.active }, { active });
  await tx.commit();
  return { ok: true };
}
