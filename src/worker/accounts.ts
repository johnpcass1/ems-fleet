/** Public (no login) endpoints for choosing a password from an emailed link, and for asking for a reset link. */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from './env';
import { HttpError, bad, parse, nowISO } from './http';
import { Tx, SEQ, first, auditStmt } from './db';
import { COOKIE, actorFrom, createSession, hashPassword, iterationsFor, passwordProblem, sha256Hex } from './auth';
import { emailEnabled, getMailer, resetMessage, setPasswordLink } from './mail';
import { lookupToken, newToken, retireUnused } from './tokens';
import { CODE_RE, getAgency, normCode } from './agencies';

export const FORGOT_MESSAGE = "If that email has an account, we've sent a link to reset the password.";
export const FORGOT_PER_EMAIL = 3;
export const FORGOT_PER_IP = 10;
const WINDOW_MS = 3600e3;

/**
 * The person as the browser sees them. `agency` is the agency the screens show (the one the request works in); `homeAgency` is the account's own.
 * They differ only while the super user is viewing another agency.
 */
export const publicMe = (u: any) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, baseIds: u.baseIds, mechanicId: u.mechanicId, mustChangePassword: !!u.mustChangePassword, isSuperuser: !!u.isSuper, perms: u.perms ?? {},
  agency: { id: u.agencyId, name: u.agencyName }, homeAgency: { id: u.homeAgencyId, name: u.homeAgencyName },
});

const forgotIn = z.object({ agencyId: z.string().max(100), email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200) });
const tokenIn = z.object({ token: z.string().max(200) });
const setIn = z.object({ token: z.string().max(200), newPassword: z.string().max(200) });

async function countSince(db: D1Database, kind: string, k: string) {
  const r = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM auth_throttle WHERE kind = ? AND k = ? AND at_ms > ?', kind, k, Date.now() - WINDOW_MS);
  return r?.n ?? 0;
}
const note = (db: D1Database, kind: string, k: string) => db.prepare('INSERT INTO auth_throttle (kind, k, at_ms) VALUES (?,?,?)').bind(kind, k, Date.now()).run();

/**
 * Always answers 200 with the same text, whether or not the address has an account.
 * Everything that depends on the account happens after the response (waitUntil), so timing does not reveal it either.
 */
export async function forgotPassword(c: Context<AppEnv>) {
  const i = parse(forgotIn, await c.req.json().catch(() => ({})));
  const agency = normCode(i.agencyId);
  const ip = await sha256Hex(c.req.header('cf-connecting-ip') || 'unknown');
  if ((await countSince(c.env.DB, 'forgot_ip', ip)) >= FORGOT_PER_IP) throw new HttpError(429, 'Too many requests. Please try again in an hour.', 'rate_limited');
  await note(c.env.DB, 'forgot_ip', ip);
  const env = c.env;
  c.executionCtx.waitUntil((async () => {
    try {
      // Requests are counted per (agency, email), also for agencies and addresses that do not exist, so the count says nothing about accounts.
      const eh = await sha256Hex(agency + '\n' + i.email);
      const n = await countSince(env.DB, 'forgot_email', eh);
      await note(env.DB, 'forgot_email', eh);
      if (n >= FORGOT_PER_EMAIL || !emailEnabled(env)) return;
      const ag = CODE_RE.test(agency) ? await getAgency(env.DB, agency) : null;
      if (!ag || !ag.active) return;
      const u = await first<any>(env.DB, 'SELECT id, email, name, active FROM users WHERE agency_id = ? AND email = ?', ag.id, i.email);
      if (!u || !u.active) return;
      const t = await newToken(env.DB, ag.id, u.id, 'reset', null);
      const at = nowISO();
      await env.DB.batch([...t.stmts, auditStmt(env.DB, { agencyId: ag.id, at, userId: u.id, email: u.email, action: 'auth.forgot_password', entityType: 'user', entityId: u.id })]);
      const r = await getMailer(env)!.send(resetMessage({ to: u.email, name: u.name, link: setPasswordLink(env, t.token), agency: { id: ag.id, name: ag.name } }));
      if (!r.ok) { await retireUnused(env.DB, ag.id, u.id, 'reset'); console.error('Reset email failed:', r.reason); }
    } catch (e) { console.error('forgot-password job failed', e); }
  })());
  return c.json({ ok: true, message: FORGOT_MESSAGE });
}

const STATE_TEXT = {
  invalid: 'This link is not valid. Check that you opened the whole link from the email.',
  used: 'This link has already been used.',
  expired: 'This link has expired.',
};
export async function tokenInfo(c: Context<AppEnv>) {
  const i = parse(tokenIn, await c.req.json().catch(() => ({})));
  const t = await lookupToken(c.env, i.token);
  if (t.state !== 'valid') return c.json({ valid: false, reason: t.state, purpose: 'purpose' in t ? t.purpose : null });
  return c.json({ valid: true, purpose: t.purpose, email: t.user.email, name: t.user.name, agencyId: t.agency.id, agencyName: t.agency.name });
}

export async function setPasswordFromLink(c: Context<AppEnv>) {
  const i = parse(setIn, await c.req.json().catch(() => ({})));
  const t = await lookupToken(c.env, i.token);
  if (t.state !== 'valid') throw new HttpError(400, STATE_TEXT[t.state], 'token_' + t.state);
  const u = t.user;
  const problem = passwordProblem(i.newPassword, u.email);
  if (problem) throw bad(problem);
  const actor = { ...actorFrom(c.env, u, {}, u.agency_id), agencyName: t.agency.name, homeAgencyName: t.agency.name };
  const tx = new Tx(c.env.DB, actor);
  // Claim the link first; the guard fails the whole batch if someone used it a moment ago.
  tx.run('UPDATE account_tokens SET used_at = ? WHERE id = ? AND agency_id = ? AND used_at IS NULL', tx.at, t.id, tx.agency);
  tx.guard('(SELECT used_at FROM account_tokens WHERE id = ?) = ?', t.id, tx.at);
  tx.run(`UPDATE users SET password_hash = ?, must_change_password = 0, seq = ${SEQ}, updated_at = ?, last_login_at = ? WHERE id = ? AND agency_id = ?`, await hashPassword(i.newPassword, iterationsFor(c.env)), tx.at, tx.at, u.id, tx.agency);
  tx.run('DELETE FROM sessions WHERE user_id = ? AND agency_id = ?', u.id, tx.agency);
  tx.run('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND agency_id = ? AND used_at IS NULL', tx.at, u.id, tx.agency);
  tx.run('DELETE FROM login_attempts WHERE agency_id = ? AND email = ?', tx.agency, u.email);
  const old = getCookie(c, COOKIE);
  if (old) tx.run('DELETE FROM sessions WHERE id = ?', await sha256Hex(old)); // whoever was logged in on this browser (a session id is a hash of a secret, so it is unique across agencies)
  tx.audit('auth.set_password', 'user', u.id, null, { how: t.purpose });
  await tx.commit();
  await createSession(c, u.id, u.agency_id);
  return c.json({ user: publicMe({ ...actor, mustChangePassword: false }), emailEnabled: emailEnabled(c.env) });
}
