import { describe, it, expect } from 'vitest';
import { hashPassword } from '../../src/worker/auth';
import { api, as, cookieOf, loginAs, makeUser, row, rows, E, PASSWORD } from './helpers';

describe('login, logout, sessions', () => {
  it('logs in with the right password and sets a hardened cookie', async () => {
    const u = await makeUser('fleet_manager');
    const r = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email.toUpperCase(), password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ email: u.email, role: 'fleet_manager', mustChangePassword: false });
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/gf_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Max-Age=2592000/);
    const me = await api('GET', '/api/auth/me', { cookie: cookieOf(r) });
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe(u.email);
  });

  it('session endpoint answers 200 with null when logged out (no console error on the login page)', async () => {
    const out = await api('GET', '/api/auth/session');
    expect(out.status).toBe(200);
    expect(out.json.user).toBeNull();
    const { cookie, user } = await as('viewer');
    const inn = await api('GET', '/api/auth/session', { cookie });
    expect(inn.json.user.email).toBe(user.email);
  });

  it('stores only a hash of the session token', async () => {
    const { cookie } = await as('viewer');
    const token = cookie.split('=')[1];
    const s = await rows('SELECT id FROM sessions');
    expect(s.length).toBe(1);
    expect(s[0].id).not.toBe(token);
    expect(s[0].id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects wrong passwords and unknown emails with the same message', async () => {
    const u = await makeUser('crew');
    const a = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: 'nope-nope-nope' } });
    const b = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'nobody@gema.test', password: 'nope-nope-nope' } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error).toBe(b.json.error);
  });

  it('refuses requests with no cookie, a bad cookie, and after logout', async () => {
    expect((await api('GET', '/api/sync')).status).toBe(401);
    expect((await api('GET', '/api/sync', { cookie: 'gf_session=garbage' })).status).toBe(401);
    const { cookie } = await as('viewer');
    expect((await api('GET', '/api/sync', { cookie })).status).toBe(200);
    const out = await api('POST', '/api/auth/logout', { cookie });
    expect(out.status).toBe(200);
    expect((await api('GET', '/api/sync', { cookie })).status).toBe(401);
    expect((await row('SELECT COUNT(*) n FROM sessions')).n).toBe(0);
  });

  it('locks an email for 15 minutes after 10 wrong passwords', async () => {
    const u = await makeUser('crew');
    for (let i = 0; i < 10; i++) {
      const r = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: 'wrong-wrong-' + i } });
      expect(r.status).toBe(401);
    }
    // even the right password is refused while locked
    const locked = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('locked');
    expect(locked.json.error).toMatch(/minute/);
    // 16 minutes later it works again
    await E.DB.prepare('UPDATE login_attempts SET at_ms = at_ms - ?').bind(16 * 60e3).run();
    const ok = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    // a successful login clears the failure count
    expect((await row('SELECT COUNT(*) n FROM login_attempts')).n).toBe(0);
  });

  it('9 failures do not lock', async () => {
    const u = await makeUser('crew');
    for (let i = 0; i < 9; i++) await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: 'wrong-wrong-' + i } });
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } })).status).toBe(200);
  });

  it('inactive users cannot log in and existing sessions stop working', async () => {
    const { user, cookie } = await as('crew');
    await E.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(user.id).run();
    expect((await api('GET', '/api/sync', { cookie })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: user.email, password: PASSWORD } })).status).toBe(401);
  });

  it('expired sessions are refused; sessions slide forward when used after a while', async () => {
    const { cookie } = await as('viewer');
    await E.DB.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await api('GET', '/api/auth/me', { cookie })).status).toBe(401);
    const { cookie: c2 } = await as('viewer');
    const old = new Date(Date.now() - 7 * 3600e3).toISOString();
    const soon = new Date(Date.now() + 2 * 864e5).toISOString();
    await E.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE expires_at > ?').bind(old, soon, new Date().toISOString()).run();
    const r = await api('GET', '/api/auth/me', { cookie: c2 });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
    await new Promise((res) => setTimeout(res, 50));
    const s = await row('SELECT expires_at FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC', new Date().toISOString());
    expect(Date.parse(s.expires_at)).toBeGreaterThan(Date.now() + 29 * 864e5);
  });
});

describe('CSRF and headers', () => {
  it('blocks writes without the custom header or from another origin', async () => {
    const { cookie } = await as('fleet_manager');
    const noHeader = await api('POST', '/api/mechanics', { cookie, body: { name: 'X' }, noCsrf: true });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json.code).toBe('csrf');
    const evil = await api('POST', '/api/mechanics', { cookie, body: { name: 'X' }, headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const same = await api('POST', '/api/mechanics', { cookie, body: { name: 'X' }, headers: { Origin: 'https://gema.test' } });
    expect(same.status).toBe(200);
  });
  it('adds security headers and never caches API answers', async () => {
    const r = await api('GET', '/api/health');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBeTruthy();
    expect(r.headers.get('permissions-policy')).toBeTruthy();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('login attempts also need the CSRF header', async () => {
    const u = await makeUser('crew');
    const r = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD }, noCsrf: true });
    expect(r.status).toBe(403);
  });
});

describe('passwords', () => {
  it('forces a new password after an admin reset, and nothing else works until then', async () => {
    const { cookie } = await as('crew', { mustChange: true });
    const me = await api('GET', '/api/auth/me', { cookie });
    expect(me.json.user.mustChangePassword).toBe(true);
    const blocked = await api('GET', '/api/sync', { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('must_change_password');
    const weak = await api('POST', '/api/auth/change-password', { cookie, body: { currentPassword: PASSWORD, newPassword: 'short' } });
    expect(weak.status).toBe(400);
    const wrong = await api('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'not-it-at-all', newPassword: 'a-brand-new-pass-1' } });
    expect(wrong.status).toBe(400);
    const ok = await api('POST', '/api/auth/change-password', { cookie, body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-pass-1' } });
    expect(ok.status).toBe(200);
    expect((await api('GET', '/api/sync', { cookie })).status).toBe(200);
    // old password no longer works, new one does
    const u = await row('SELECT email FROM users');
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: 'a-brand-new-pass-1' } })).status).toBe(200);
  });
  it('hashes with PBKDF2-SHA256, per-user salt, iterations recorded in the hash', async () => {
    const a = await makeUser('crew'); const b = await makeUser('crew');
    const ha = (await row('SELECT password_hash h FROM users WHERE id = ?', a.id)).h as string;
    const hb = (await row('SELECT password_hash h FROM users WHERE id = ?', b.id)).h as string;
    expect(ha).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(ha.split('$')[2]).not.toBe(hb.split('$')[2]);
    expect(ha).not.toContain(PASSWORD);
  });
  it('upgrades an older hash to the configured iterations at login', async () => {
    const u = await makeUser('crew');
    await E.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(PASSWORD, 500), u.id).run();
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } })).status).toBe(200);
    expect(((await row('SELECT password_hash h FROM users WHERE id = ?', u.id)).h as string)).toMatch(/^pbkdf2-sha256\$1000\$/);
  });
  it('writes login and logout to the audit log', async () => {
    const { cookie } = await as('viewer');
    await api('POST', '/api/auth/logout', { cookie });
    const a = await rows("SELECT action FROM audit_log ORDER BY id");
    expect(a.map((x: any) => x.action)).toEqual(['auth.login', 'auth.logout']);
  });
});
void loginAs;

describe('failed sign-ins per network address', () => {
  const login = (ip: string, email: string, password: string) =>
    api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email, password }, headers: { 'cf-connecting-ip': ip } });

  it('stops one address guessing across many accounts, without affecting other addresses', async () => {
    const u = await makeUser('crew');
    // 30 wrong passwords spread over 30 different addresses: no single account reaches its own lock
    for (let i = 0; i < 30; i++) expect((await login('203.0.113.7', `spray${i}@gema.test`, 'wrong-password-1')).status).toBe(401);
    const blocked = await login('203.0.113.7', u.email, PASSWORD); // even the right password is refused from that address for now
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('rate_limited');
    expect((await login('198.51.100.9', u.email, PASSWORD)).status).toBe(200); // the person can still sign in from anywhere else
    expect(await rows("SELECT k FROM auth_throttle WHERE kind = 'login_ip' AND k LIKE '%203.0.113.7%'")).toHaveLength(0); // only a hash of the address is stored
  });

  it('does not count successful sign-ins', async () => {
    const u = await makeUser('viewer');
    for (let i = 0; i < 35; i++) expect((await login('192.0.2.44', u.email, PASSWORD)).status).toBe(200);
  });
});
