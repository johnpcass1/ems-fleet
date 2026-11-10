/** Public (no login) endpoints for choosing a password from an emailed link, and for asking for a reset link. */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from './env';
import { HttpError, bad, parse, nowISO } from './http';
import { Tx, SEQ, first } from './db';
import { COOKIE, actorFrom, createSession, hashPassword, iterationsFor, passwordProblem, sha256Hex } from './auth';
import { emailEnabled, getMailer, resetMessage, setPasswordLink } from './mail';
import { lookupToken, newToken, retireUnused } from './tokens';

export const FORGOT_MESSAGE = "If that email has an account, we've sent a link to reset the password.";
export const FORGOT_PER_EMAIL = 3;
export const FORGOT_PER_IP = 10;
const WINDOW_MS = 3600e3;

export const publicMe = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role, baseIds: u.baseIds, mechanicId: u.mechanicId, mustChangePassword: !!u.mustChangePassword, isSuperuser: !!u.isSuper, perms: u.perms ?? {} });

const forgotIn = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200) });
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
  const ip = await sha256Hex(c.req.header('cf-connecting-ip') || 'unknown');
  if ((await countSince(c.env.DB, 'forgot_ip', ip)) >= FORGOT_PER_IP) throw new HttpError(429, 'Too many requests. Please try again in an hour.', 'rate_limited');
  await note(c.env.DB, 'forgot_ip', ip);
  const env = c.env;
  c.executionCtx.waitUntil((async () => {
    try {
      const eh = await sha256Hex(i.email);
      const n = await countSince(env.DB, 'forgot_email', eh);
      await note(env.DB, 'forgot_email', eh); // counted for unknown addresses too
      if (n >= FORGOT_PER_EMAIL || !emailEnabled(env)) return;
      const u = await first<any>(env.DB, 'SELECT id, email, name, active FROM users WHERE email = ?', i.email);
      if (!u || !u.active) return;
      const t = await newToken(env.DB, u.id, 'reset', null);
      const at = nowISO();
      await env.DB.batch([...t.stmts, env.DB.prepare('INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(at, u.id, u.email, 'auth.forgot_password', 'user', u.id, at, at)]);
      const r = await getMailer(env)!.send(resetMessage({ to: u.email, name: u.name, link: setPasswordLink(env, t.token) }));
      if (!r.ok) { await retireUnused(env.DB, u.id, 'reset'); console.error('Reset email failed:', r.reason); }
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
  return c.json({ valid: true, purpose: t.purpose, email: t.user.email, name: t.user.name });
}

export async function setPasswordFromLink(c: Context<AppEnv>) {
  const i = parse(setIn, await c.req.json().catch(() => ({})));
  const t = await lookupToken(c.env, i.token);
  if (t.state !== 'valid') throw new HttpError(400, STATE_TEXT[t.state], 'token_' + t.state);
  const u = t.user;
  const problem = passwordProblem(i.newPassword, u.email);
  if (problem) throw bad(problem);
  const actor = actorFrom(c.env, u);
  const tx = new Tx(c.env.DB, actor);
  // Claim the link first; the guard fails the whole batch if someone used it a moment ago.
  tx.run('UPDATE account_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', tx.at, t.id);
  tx.guard('(SELECT used_at FROM account_tokens WHERE id = ?) = ?', t.id, tx.at);
  tx.run(`UPDATE users SET password_hash = ?, must_change_password = 0, seq = ${SEQ}, updated_at = ?, last_login_at = ? WHERE id = ?`, await hashPassword(i.newPassword, iterationsFor(c.env)), tx.at, tx.at, u.id);
  tx.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  tx.run('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', tx.at, u.id);
  tx.run('DELETE FROM login_attempts WHERE email = ?', u.email);
  const old = getCookie(c, COOKIE);
  if (old) tx.run('DELETE FROM sessions WHERE id = ?', await sha256Hex(old)); // whoever was logged in on this browser
  tx.audit('auth.set_password', 'user', u.id, null, { how: t.purpose });
  await tx.commit();
  await createSession(c, u.id);
  return c.json({ user: publicMe({ ...actor, mustChangePassword: false }), emailEnabled: emailEnabled(c.env) });
}
