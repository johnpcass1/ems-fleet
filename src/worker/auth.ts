import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Env } from './env';
import { isSuperuserEmail } from './env';
import { cleanOverrides, effectivePerms } from '../shared/perm';
import { all, first } from './db';
import { HttpError, nowISO } from './http';
import type { Role } from '../shared/constants';

export const COOKIE = 'gf_session';
export const SESSION_DAYS = 30;
const SLIDE_AFTER_MS = 6 * 3600e3; // only touch the session row every few hours (saves D1 writes)
export const LOCK_FAILS = 10;
export const LOCK_MS = 15 * 60e3;

/* ---------- base64 / hex helpers ---------- */
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- passwords: PBKDF2-SHA256 ---------- */
export const DEFAULT_ITERATIONS = 20000;
export function iterationsFor(env: Pick<Env, 'PBKDF2_ITERATIONS'>) {
  const n = Number(env.PBKDF2_ITERATIONS);
  // Workers' WebCrypto allows at most 100,000 iterations.
  return Number.isFinite(n) && n >= 1000 && n <= 100000 ? Math.floor(n) : DEFAULT_ITERATIONS;
}
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(h)}`;
}
/** Constant-time comparison of two byte arrays of equal length. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; iterations: number }> {
  const [alg, it, salt, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2-sha256') return { ok: false, iterations: 0 };
  const iterations = Number(it);
  const h = await derive(password, unb64(salt), iterations);
  return { ok: safeEqual(h, unb64(hash)), iterations };
}
/** A hash of a random password, used so unknown emails cost the same time as known ones. */
let dummy: string | null = null;
export async function dummyVerify(password: string, env: Env) {
  dummy ??= await hashPassword(b64url(crypto.getRandomValues(new Uint8Array(12))), iterationsFor(env));
  await verifyPassword(password, dummy);
}

export const MIN_PASSWORD = 10;
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  if (email && pw.toLowerCase() === email.toLowerCase()) return 'The password cannot be your email address.';
  if (/^(.)\1+$/.test(pw)) return 'Choose a password that is not one repeated character.';
  return null;
}
/** Readable temporary password (no 0/O/1/l/I). Shown once to the admin. */
export function tempPassword(): string {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => A[x % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/* ---------- sessions ---------- */
export async function sha256Hex(s: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
export async function createSession(c: Context<AppEnv>, userId: string) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = await sha256Hex(token);
  const now = nowISO();
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(id, userId, exp, now, now, now).run();
  setSessionCookie(c, token);
  return id;
}
function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}
export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, COOKIE, { path: '/', secure: true });
}

/** Looks up the logged-in user. Sets c.var.user or throws 401. */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, COOKIE);
  if (!token) throw new HttpError(401, 'Please log in.', 'unauthenticated');
  const id = await sha256Hex(token);
  const row = await first<any>(
    c.env.DB,
    `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.role, u.base_ids, u.mechanic_id, u.active, u.must_change_password, u.perm_overrides
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  );
  if (!row || !row.active || Date.parse(row.expires_at) < Date.now()) {
    clearSessionCookie(c);
    throw new HttpError(401, 'Please log in.', 'unauthenticated');
  }
  if (Date.now() - Date.parse(row.last_seen_at) > SLIDE_AFTER_MS) {
    const now = nowISO();
    const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE sessions SET last_seen_at=?, expires_at=?, updated_at=? WHERE id=?').bind(now, exp, now, id).run());
    setSessionCookie(c, token); // 30-day sliding expiry
  }
  let baseIds: string[] = [];
  try { baseIds = JSON.parse(row.base_ids || '[]'); } catch { /* ignore */ }
  // Permissions are read from the users table on every request, so a change by an administrator applies at once.
  c.set('user', { ...actorFrom(c.env, { ...row, base_ids: JSON.stringify(baseIds) }), mustChangePassword: !!row.must_change_password, sessionId: id });
  await next();
}

/** After an admin reset, the user may only change their password until they do. */
export async function blockUntilPasswordChanged(c: Context<AppEnv>, next: Next) {
  if (c.var.user.mustChangePassword) throw new HttpError(403, 'Choose a new password first.', 'must_change_password');
  await next();
}

/* ---------- login throttling ---------- */
export async function lockedUntil(db: D1Database, email: string): Promise<number | null> {
  const since = Date.now() - LOCK_MS;
  const rows = await all<{ at_ms: number }>(db, 'SELECT at_ms FROM login_attempts WHERE email = ? AND ok = 0 AND at_ms > ? ORDER BY at_ms DESC LIMIT ?', email, since, LOCK_FAILS);
  if (rows.length >= LOCK_FAILS) return rows[0].at_ms + LOCK_MS;
  return null;
}
export async function recordAttempt(db: D1Database, email: string, ok: boolean) {
  const now = nowISO();
  if (ok) await db.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
  else await db.prepare('INSERT INTO login_attempts (email, at_ms, ok, created_at, updated_at) VALUES (?,?,0,?,?)').bind(email, Date.now(), now, now).run();
}

/** Build the acting person from a users row: role, bases, super user flag, own permission changes and the finished permission map. */
export function actorFrom(env: Pick<Env, 'SUPERUSER_EMAILS'>, row: any) {
  let baseIds: string[] = [];
  try { const v = JSON.parse(row.base_ids || '[]'); if (Array.isArray(v)) baseIds = v; } catch { /* ignore */ }
  let raw: unknown = {};
  try { raw = JSON.parse(row.perm_overrides || '{}'); } catch { /* ignore */ }
  const base = { role: row.role as Role, isSuper: isSuperuserEmail(env, row.email), permOverrides: cleanOverrides(raw) };
  return {
    id: row.id as string, email: row.email as string, name: row.name as string, role: base.role, baseIds, mechanicId: (row.mechanic_id ?? null) as string | null,
    isSuper: base.isSuper, permOverrides: base.permOverrides, perms: effectivePerms(base),
  };
}
