/** Invite and reset links. Only a hash of each link's secret is stored. See docs/SECURITY.md. */
import type { Env } from './env';
import { b64url, sha256Hex } from './auth';
import { first } from './db';
import { uid } from './http';

export const INVITE_MS = 7 * 864e5;
export const RESET_MS = 3600e3;
export type Purpose = 'invite' | 'reset';

/** Statements that retire the person's older unused links of this purpose and store a new one. Returns the secret to put in the link. */
export async function newToken(db: D1Database, userId: string, purpose: Purpose, createdBy: string | null, nowMs = Date.now()) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  const at = new Date(nowMs).toISOString();
  const exp = new Date(nowMs + (purpose === 'invite' ? INVITE_MS : RESET_MS)).toISOString();
  const stmts = [
    db.prepare('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(at, userId, purpose),
    db.prepare('INSERT INTO account_tokens (id, user_id, purpose, token_hash, expires_at, used_at, created_at, created_by) VALUES (?,?,?,?,?,NULL,?,?)').bind(uid('tk'), userId, purpose, hash, exp, at, createdBy),
  ];
  return { token, stmts };
}
/** Retire a link that could not be emailed, so no unseen live link is left behind. */
export const retireUnused = (db: D1Database, userId: string, purpose: Purpose) =>
  db.prepare('UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(new Date().toISOString(), userId, purpose).run();

export type TokenState =
  | { state: 'valid'; id: string; purpose: Purpose; user: any }
  | { state: 'expired' | 'used'; purpose: Purpose }
  | { state: 'invalid' };

export async function lookupToken(env: Env, token: string): Promise<TokenState> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { state: 'invalid' };
  const r = await first<any>(
    env.DB,
    `SELECT t.id, t.purpose, t.expires_at, t.used_at, u.id AS uid, u.email, u.name, u.role, u.base_ids, u.mechanic_id, u.active, u.perm_overrides
     FROM account_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    await sha256Hex(token),
  );
  if (!r || !r.active) return { state: 'invalid' };
  if (r.used_at) return { state: 'used', purpose: r.purpose };
  if (Date.parse(r.expires_at) < Date.now()) return { state: 'expired', purpose: r.purpose };
  return { state: 'valid', id: r.id, purpose: r.purpose, user: { id: r.uid, email: r.email, name: r.name, role: r.role, base_ids: r.base_ids, mechanic_id: r.mechanic_id, perm_overrides: r.perm_overrides } };
}
