/**
 * Agencies: the organisations that share this site. Everything here is for the super user only (`actor.isSuper`: an email in SUPERUSER_EMAILS
 * on an account in the home agency, see env.ts); every other account gets 403. The rules for keeping agencies apart are in auth.ts
 * (`requireAuth` decides the agency of each request) and in the `agency_id` filter on every query.
 */
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv, Env } from './env';
import { homeAgency, isSuperuserEmail } from './env';
import { Tx, SEQ, all, first, auditStmt } from './db';
import { bad, conflict, forbidden, notFound, nowISO, parse, uid, zText } from './http';
import { hashPassword, iterationsFor, passwordProblem } from './auth';
import type { Actor } from '../shared/perm';
import { DEFAULT_SETTINGS } from './rules';

export const CODE_RE = /^[A-Z0-9-]{2,20}$/;
/** The code as people type it: trimmed and upper case. Not yet checked against CODE_RE. */
export const normCode = (s: unknown) => String(s ?? '').trim().toUpperCase();

export interface AgencyRow { id: string; name: string; active: number }
export const getAgency = (db: D1Database, code: string) => first<AgencyRow>(db, 'SELECT id, name, active FROM agencies WHERE id = ?', code);

const needSuper = (actor: Actor) => { if (!actor.isSuper) throw forbidden('Only the super user can manage agencies.'); };

const shape = (r: any, env: Env) => ({
  id: r.id as string, name: r.name as string, active: !!r.active, isHome: r.id === homeAgency(env),
  users: Number(r.users) || 0, vehicles: Number(r.vehicles) || 0, createdAt: r.created_at as string,
});

/** Every agency, with how many active users and (not decommissioned) vehicles each has. */
export async function listAgencies(env: Env, actor: Actor) {
  needSuper(actor);
  const rows = await all(env.DB, `SELECT a.id, a.name, a.active, a.created_at,
    (SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id AND u.active = 1) AS users,
    (SELECT COUNT(*) FROM vehicles v WHERE v.agency_id = a.id AND v.status <> 'decommissioned') AS vehicles
    FROM agencies a ORDER BY (a.id = ?) DESC, a.name COLLATE NOCASE, a.id`, homeAgency(env));
  return { agencies: rows.map((r) => shape(r, env)), homeAgency: homeAgency(env) };
}

/** Only the home agency may hold an account with a super user's email (see users.ts). */
export function checkSuperEmailAllowed(env: Env, agencyId: string, email: string) {
  if (isSuperuserEmail(env, email) && agencyId.toUpperCase() !== homeAgency(env)) {
    throw bad('That email address is reserved for the site owner and can only be used in the home agency.', 'reserved_email');
  }
}

const createIn = z.object({
  code: z.string().trim().toUpperCase().regex(CODE_RE, 'The Agency ID must be 2 to 20 characters: letters, numbers or hyphens.'),
  name: zText(100).min(1, 'Enter the agency name.'),
  admin: z.object({
    name: zText(120).min(1, 'Enter the administrator\'s name.'),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
    password: z.string().max(200),
  }),
});

/**
 * Add an agency with its first system administrator, in ONE transaction: the agency, its (empty) settings record with default values, the
 * administrator's account and the audit rows. The new agency has no bases, vehicles or other records; its administrator sets those up.
 */
export async function createAgency(env: Env, actor: Actor, body: unknown) {
  needSuper(actor);
  const i = parse(createIn, body);
  checkSuperEmailAllowed(env, i.code, i.admin.email);
  const problem = passwordProblem(i.admin.password, i.admin.email);
  if (problem) throw bad(problem);
  if (await getAgency(env.DB, i.code)) throw conflict('That Agency ID is already in use.', 'duplicate_agency');
  const adminId = uid('u');
  const tx = new Tx(env.DB, actor, i.code);
  tx.run('INSERT INTO agencies (id, name, active, created_by, created_at, updated_at) VALUES (?,?,1,?,?,?)', i.code, i.name, actor.email, tx.at, tx.at);
  const { rolePerms: _rp, ...defaults } = DEFAULT_SETTINGS;
  tx.run(`INSERT INTO settings (id, data, sample, seq, created_at, updated_at, agency_id) VALUES (?,?,0,${SEQ},?,?,?)`, i.code, JSON.stringify(defaults), tx.at, tx.at, i.code);
  tx.run(
    `INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at, agency_id) VALUES (?,?,?,'system_admin','[]',NULL,?,1,0,${SEQ},?,?,?)`,
    adminId, i.admin.email, i.admin.name, await hashPassword(i.admin.password, iterationsFor(env)), tx.at, tx.at, i.code,
  );
  tx.audit('agency.create', 'agency', i.code, null, { name: i.name, adminEmail: i.admin.email });
  tx.audit('user.create', 'user', adminId, null, { email: i.admin.email, name: i.admin.name, role: 'system_admin', baseIds: [], how: 'password_set_by_admin' });
  await tx.commit();
  return { ok: true, id: i.code, adminId };
}

const renameIn = z.object({ name: zText(100).min(1, 'Enter the agency name.') });
export async function renameAgency(env: Env, actor: Actor, code: string, body: unknown) {
  needSuper(actor);
  const i = parse(renameIn, body);
  const a = await getAgency(env.DB, normCode(code));
  if (!a) throw notFound('That agency does not exist.');
  const tx = new Tx(env.DB, actor, a.id);
  tx.run('UPDATE agencies SET name = ?, updated_at = ? WHERE id = ?', i.name, tx.at, a.id);
  tx.audit('agency.rename', 'agency', a.id, { name: a.name }, { name: i.name });
  await tx.commit();
  return { ok: true };
}

/**
 * Deactivate: nobody in the agency can sign in, every session of its people ends at once, and a super user who was viewing it is sent back
 * to their own agency. The home agency cannot be deactivated. Reactivate undoes it (people then sign in again). Nothing is deleted.
 */
export async function setAgencyActive(env: Env, actor: Actor, code: string, active: boolean) {
  needSuper(actor);
  const a = await getAgency(env.DB, normCode(code));
  if (!a) throw notFound('That agency does not exist.');
  if (!active && a.id === homeAgency(env)) throw bad('The home agency cannot be deactivated.', 'home_agency');
  if (!!a.active === active) return { ok: true };
  const tx = new Tx(env.DB, actor, a.id);
  tx.run('UPDATE agencies SET active = ?, updated_at = ? WHERE id = ?', active ? 1 : 0, tx.at, a.id);
  if (!active) {
    tx.run('DELETE FROM sessions WHERE agency_id = ?', a.id);
    tx.run('UPDATE sessions SET acting_agency_id = NULL, updated_at = ? WHERE acting_agency_id = ?', tx.at, a.id);
  }
  tx.audit(active ? 'agency.reactivate' : 'agency.deactivate', 'agency', a.id, { active: !!a.active }, { active });
  await tx.commit();
  return { ok: true };
}

/** The super user starts viewing another agency (to support it). Only this session changes; the account stays in its own agency. */
export async function openAgency(c: Context<AppEnv>, code: string) {
  const u = c.var.user;
  needSuper(u);
  const a = await getAgency(c.env.DB, normCode(code));
  if (!a) throw notFound('That agency does not exist.');
  if (!a.active) throw bad('That agency is deactivated. Reactivate it first.', 'agency_inactive');
  const home = a.id === u.homeAgencyId;
  const now = nowISO();
  const stmts = [c.env.DB.prepare('UPDATE sessions SET acting_agency_id = ?, updated_at = ? WHERE id = ?').bind(home ? null : a.id, now, u.sessionId)];
  if (!home && u.agencyId !== a.id) stmts.push(auditStmt(c.env.DB, { agencyId: a.id, at: now, userId: u.id, email: u.email, action: 'agency.open', entityType: 'agency', entityId: a.id }));
  await c.env.DB.batch(stmts);
  return { ok: true, agency: { id: a.id, name: a.name } };
}

/** Back to the super user's own agency. */
export async function backToHome(c: Context<AppEnv>) {
  const u = c.var.user;
  needSuper(u);
  const now = nowISO();
  const stmts = [c.env.DB.prepare('UPDATE sessions SET acting_agency_id = NULL, updated_at = ? WHERE id = ?').bind(now, u.sessionId)];
  if (u.agencyId !== u.homeAgencyId) stmts.push(auditStmt(c.env.DB, { agencyId: u.agencyId, at: now, userId: u.id, email: u.email, action: 'agency.close', entityType: 'agency', entityId: u.agencyId }));
  await c.env.DB.batch(stmts);
  return { ok: true, agency: { id: u.homeAgencyId, name: u.homeAgencyName } };
}
