import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, as, makeUser, row, rows, cookieOf, E, PASSWORD } from './helpers';
import { FORGOT_MESSAGE } from '../../src/worker/accounts';

interface Sent { url: string; auth: string | null; body: any }
let sent: Sent[] = [];
let respond: () => Response;
const realFetch = globalThis.fetch;
const ok = () => new Response(JSON.stringify({ id: 'em_' + Math.random().toString(36).slice(2) }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  respond = ok;
  (E as any).RESEND_API_KEY = 're_test_not_a_real_key';
  (E as any).MAIL_FROM = 'GEMA Fleet <no-reply@gema.test>';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input, init);
    sent.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(init.body) });
    return respond();
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (E as any).RESEND_API_KEY;
  delete (E as any).MAIL_FROM;
});

const tokenFrom = (m: Sent) => {
  const mt = /\/set-password#t=([A-Za-z0-9_-]+)/.exec(m.body.text);
  if (!mt) throw new Error('no link in email');
  return mt[1];
};
const lastToken = () => tokenFrom(sent[sent.length - 1]);
const waitSent = (n: number) => vi.waitFor(() => expect(sent.length).toBe(n), { timeout: 3000 });
async function admin(role = 'fleet_manager') { return (await as(role, { email: `${role}@gema.test`, name: 'Fran Manager' })).cookie; }
const invite = (cookie: string, o: any = {}) => api('POST', '/api/users', { cookie, body: { email: 'pat@gema.test', name: 'Pat Crew', role: 'crew', invite: true, ...o } });

describe('invite by email', () => {
  it('create with invite:true sends one email through Resend with a working link', async () => {
    const fm = await admin();
    const r = await invite(fm);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, emailSent: true, email: 'pat@gema.test' });
    expect(r.json.temporaryPassword).toBeUndefined();
    expect(sent.length).toBe(1);
    const m = sent[0];
    expect(m.url).toBe('https://api.resend.com/emails');
    expect(m.auth).toBe('Bearer re_test_not_a_real_key');
    expect(m.body.from).toBe('GEMA Fleet <no-reply@gema.test>');
    expect(m.body.to).toEqual(['pat@gema.test']);
    expect(m.body.subject).toBe('Set up your GEMA Fleet account');
    expect(m.body.text).toContain('Fran Manager');
    expect(m.body.text).toContain('Crew');
    expect(m.body.html).toContain('Fran Manager');
    expect(m.body.text).toContain('https://gema-fleet.example.workers.dev/set-password#t=');
    const info = await api('POST', '/api/auth/token-info', { body: { token: tokenFrom(m) } });
    expect(info.json).toEqual({ valid: true, purpose: 'invite', email: 'pat@gema.test', name: 'Pat Crew', agencyId: 'GEMA', agencyName: 'GEMA' });
  });
  it('stores only a hash, and the invite expires in 7 days', async () => {
    await invite(await admin());
    const t = tokenFrom(sent[0]);
    const tk = await row('SELECT * FROM account_tokens');
    expect(JSON.stringify(tk)).not.toContain(t);
    expect(tk.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tk.purpose).toBe('invite');
    const days = (Date.parse(tk.expires_at) - Date.parse(tk.created_at)) / 864e5;
    expect(days).toBeCloseTo(7, 3);
  });
  it('an invited user cannot log in with any password, and is listed as invited', async () => {
    const fm = await admin();
    await invite(fm);
    for (const pw of ['', 'unusable$', PASSWORD, 'pat-start-pass-1', 'password123']) {
      expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: pw } })).status).toBe(401);
    }
    const list = await api('GET', '/api/users', { cookie: fm });
    expect(list.json.users.find((u: any) => u.email === 'pat@gema.test')).toMatchObject({ invited: true, mustChangePassword: true });
    expect(JSON.stringify(list.json)).not.toContain('unusable$');
  });
  it('set-password logs the person in, clears the flag, uses the link once', async () => {
    const fm = await admin();
    await invite(fm);
    const token = lastToken();
    const r = await api('POST', '/api/auth/set-password', { body: { token, newPassword: 'pat-chosen-pass-1' } });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ email: 'pat@gema.test', role: 'crew', mustChangePassword: false });
    const cookie = cookieOf(r);
    expect((await api('GET', '/api/sync', { cookie })).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: 'pat-chosen-pass-1' } })).status).toBe(200);
    const list = await api('GET', '/api/users', { cookie: fm });
    expect(list.json.users.find((u: any) => u.email === 'pat@gema.test')).toMatchObject({ invited: false, mustChangePassword: false });
    // second use is refused
    const again = await api('POST', '/api/auth/set-password', { body: { token, newPassword: 'another-pass-77' } });
    expect(again.status).toBe(400);
    expect(again.json.code).toBe('token_used');
    expect((await api('POST', '/api/auth/token-info', { body: { token } })).json).toMatchObject({ valid: false, reason: 'used', purpose: 'invite' });
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: 'another-pass-77' } })).status).toBe(401);
  });
  it('rejects weak passwords without using up the link', async () => {
    await invite(await admin());
    const token = lastToken();
    for (const pw of ['short', 'aaaaaaaaaaaa', 'pat@gema.test']) {
      expect((await api('POST', '/api/auth/set-password', { body: { token, newPassword: pw } })).status).toBe(400);
    }
    expect((await api('POST', '/api/auth/set-password', { body: { token, newPassword: 'good-enough-pass-1' } })).status).toBe(200);
  });
  it('rejects an expired link and unknown or malformed tokens', async () => {
    await invite(await admin());
    const token = lastToken();
    await E.DB.prepare('UPDATE account_tokens SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
    const r = await api('POST', '/api/auth/set-password', { body: { token, newPassword: 'good-enough-pass-1' } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('token_expired');
    expect((await api('POST', '/api/auth/token-info', { body: { token } })).json).toMatchObject({ valid: false, reason: 'expired' });
    for (const bad of ['', 'x', 'A'.repeat(43), '../../etc']) {
      expect((await api('POST', '/api/auth/set-password', { body: { token: bad, newPassword: 'good-enough-pass-1' } })).json.code).toBe('token_invalid');
    }
  });
  it('a deactivated user cannot use the link; Resend invite retires the old link', async () => {
    const fm = await admin();
    const id = (await invite(fm)).json.id;
    const first = lastToken();
    const re = await api('POST', `/api/users/${id}/invite`, { cookie: fm });
    expect(re.status).toBe(200);
    expect(sent.length).toBe(2);
    const second = lastToken();
    expect(second).not.toBe(first);
    expect((await api('POST', '/api/auth/token-info', { body: { token: first } })).json.valid).toBe(false);
    expect((await api('POST', '/api/auth/token-info', { body: { token: second } })).json.valid).toBe(true);
    await api('POST', `/api/users/${id}/deactivate`, { cookie: fm });
    expect((await api('POST', '/api/auth/token-info', { body: { token: second } })).json).toMatchObject({ valid: false });
    expect((await api('POST', '/api/auth/set-password', { body: { token: second, newPassword: 'good-enough-pass-1' } })).status).toBe(400);
    expect((await api('POST', `/api/users/${id}/invite`, { cookie: fm })).status).toBe(400); // deactivated
  });
  it('Resend invite is only for people who have not set a password', async () => {
    const fm = await admin();
    const u = await makeUser('crew');
    const r = await api('POST', `/api/users/${u.id}/invite`, { cookie: fm });
    expect(r.status).toBe(400);
    expect(sent.length).toBe(0);
  });
  it('a failed send is reported and leaves no live link; the person can be re-invited', async () => {
    const fm = await admin();
    respond = () => new Response(JSON.stringify({ name: 'validation_error', message: 'The gema.test domain is not verified.' }), { status: 403 });
    const r = await invite(fm);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, emailSent: false });
    expect(r.json.emailError).toContain('not verified');
    expect(await row('SELECT COUNT(*) AS n FROM account_tokens WHERE used_at IS NULL')).toMatchObject({ n: 0 });
    const id = r.json.id;
    const re = await api('POST', `/api/users/${id}/invite`, { cookie: fm });
    expect(re.status).toBe(502);
    expect(re.json.error).toContain("Couldn't send the email");
    respond = ok;
    expect((await api('POST', `/api/users/${id}/invite`, { cookie: fm })).status).toBe(200);
  });
  it('a network failure to Resend is reported, not thrown', async () => {
    const fm = await admin();
    globalThis.fetch = (async () => { throw new Error('boom'); }) as any;
    const r = await invite(fm);
    expect(r.status).toBe(200);
    expect(r.json.emailSent).toBe(false);
    expect(r.json.emailError).toMatch(/could not be reached/);
  });
  it('only fleet managers and system administrators can invite or resend', async () => {
    const crew = (await as('crew', { baseIds: ['b-hq'], email: 'c@gema.test' })).cookie;
    expect((await invite(crew)).status).toBe(403);
    const fm = await admin();
    const id = (await invite(fm)).json.id;
    const n = sent.length;
    expect((await api('POST', `/api/users/${id}/invite`, { cookie: crew })).status).toBe(403);
    expect((await api('POST', `/api/users/${id}/reset-link`, { cookie: crew })).status).toBe(403);
    expect(sent.length).toBe(n);
    // a fleet manager cannot invite a system administrator
    expect((await invite(fm, { email: 'sa@gema.test', role: 'system_admin' })).status).toBe(403);
  });
  it('writes audit rows without the link', async () => {
    const fm = await admin();
    const id = (await invite(fm)).json.id;
    await api('POST', `/api/users/${id}/invite`, { cookie: fm });
    await api('POST', '/api/auth/set-password', { body: { token: lastToken(), newPassword: 'good-enough-pass-1' } });
    const a = await rows("SELECT action, user_email FROM audit_log WHERE action <> 'auth.login' ORDER BY id");
    expect(a.map((x: any) => x.action)).toEqual(['user.create', 'user.invite_resend', 'auth.set_password']);
    expect(JSON.stringify(await rows('SELECT * FROM audit_log'))).not.toContain(lastToken());
  });
});

describe('reset links', () => {
  it('admin Send reset link emails a one-hour link and leaves the current password working', async () => {
    const fm = await admin();
    const u = await makeUser('crew', { email: 'rita@gema.test', name: 'Rita' });
    const r = await api('POST', `/api/users/${u.id}/reset-link`, { cookie: fm });
    expect(r.json).toMatchObject({ ok: true, emailSent: true });
    expect(sent[0].body.subject).toBe('Reset your GEMA Fleet password');
    expect(sent[0].body.to).toEqual(['rita@gema.test']);
    const tk = await row("SELECT * FROM account_tokens WHERE purpose = 'reset'");
    expect((Date.parse(tk.expires_at) - Date.parse(tk.created_at)) / 60000).toBeCloseTo(60, 1);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } })).status).toBe(200);
  });
  it('using a reset link signs out every other session, sets the new password and logs in', async () => {
    const u = await makeUser('crew', { email: 'rita@gema.test' });
    const old = cookieOf(await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } }));
    expect((await api('GET', '/api/sync', { cookie: old })).status).toBe(200);
    await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: u.email } });
    await waitSent(1);
    const r = await api('POST', '/api/auth/set-password', { body: { token: lastToken(), newPassword: 'rita-new-pass-123' } });
    expect(r.status).toBe(200);
    expect((await api('GET', '/api/sync', { cookie: old })).status).toBe(401);
    expect((await api('GET', '/api/sync', { cookie: cookieOf(r) })).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: PASSWORD } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: u.email, password: 'rita-new-pass-123' } })).status).toBe(200);
  });
  it('a newer reset link supersedes the older one', async () => {
    const u = await makeUser('crew', { email: 'rita@gema.test' });
    await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: u.email } });
    await waitSent(1);
    const t1 = lastToken();
    await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: u.email } });
    await waitSent(2);
    const t2 = lastToken();
    expect(t2).not.toBe(t1);
    expect((await api('POST', '/api/auth/set-password', { body: { token: t1, newPassword: 'good-enough-pass-1' } })).json.code).toBe('token_used');
    expect((await api('POST', '/api/auth/set-password', { body: { token: t2, newPassword: 'good-enough-pass-1' } })).status).toBe(200);
  });
  it('an expired reset link is refused (and says it is a reset link)', async () => {
    const u = await makeUser('crew', { email: 'rita@gema.test' });
    await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: u.email } });
    await waitSent(1);
    await E.DB.prepare('UPDATE account_tokens SET expires_at = ?').bind(new Date(Date.now() - 1).toISOString()).run();
    expect((await api('POST', '/api/auth/token-info', { body: { token: lastToken() } })).json).toEqual({ valid: false, reason: 'expired', purpose: 'reset' });
  });
});

describe('forgot password (public)', () => {
  it('answers the same for unknown and known addresses; only the known one is emailed', async () => {
    await makeUser('crew', { email: 'rita@gema.test' });
    const a = await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'nobody@gema.test' } });
    await vi.waitFor(async () => expect(await row('SELECT COUNT(*) AS n FROM auth_throttle WHERE kind = ?', 'forgot_email')).toMatchObject({ n: 1 }));
    expect(sent.length).toBe(0);
    const b = await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'RITA@gema.test' } });
    await waitSent(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(a.json.message).toBe(FORGOT_MESSAGE);
    expect(sent[0].body.to).toEqual(['rita@gema.test']);
    expect(await rows("SELECT * FROM audit_log WHERE action = 'auth.forgot_password'")).toHaveLength(1);
  });
  it('is CSRF protected like other POSTs', async () => {
    expect((await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'a@b.co' }, noCsrf: true })).status).toBe(403);
    expect((await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'not an email' } })).status).toBe(400);
  });
  it('sends nothing to deactivated accounts', async () => {
    await makeUser('crew', { email: 'gone@gema.test', active: false });
    expect((await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'gone@gema.test' } })).status).toBe(200);
    await vi.waitFor(async () => expect(await row('SELECT COUNT(*) AS n FROM auth_throttle WHERE kind = ?', 'forgot_email')).toMatchObject({ n: 1 }));
    expect(sent.length).toBe(0);
  });
  it('allows 3 emails per address per hour; extra requests still answer 200 but send nothing', async () => {
    await makeUser('crew', { email: 'rita@gema.test' });
    for (let i = 1; i <= 3; i++) { await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'rita@gema.test' } }); await waitSent(i); }
    const r = await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'rita@gema.test' } });
    expect(r.status).toBe(200);
    expect(r.json.message).toBe(FORGOT_MESSAGE);
    await vi.waitFor(async () => expect(await row('SELECT COUNT(*) AS n FROM auth_throttle WHERE kind = ?', 'forgot_email')).toMatchObject({ n: 4 }));
    expect(sent.length).toBe(3);
  });
  it('limits each network address to 10 requests per hour', async () => {
    for (let i = 0; i < 10; i++) expect((await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: `x${i}@gema.test` }, headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status).toBe(200);
    const r = await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'x11@gema.test' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    expect(r.status).toBe(429);
    expect((await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'x11@gema.test' }, headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status).toBe(200);
    const t = await rows('SELECT k FROM auth_throttle');
    expect(JSON.stringify(t)).not.toContain('203.0.113');
    expect(JSON.stringify(t)).not.toContain('gema.test');
  });
  it('does nothing when email is not set up, but still answers 200', async () => {
    delete (E as any).RESEND_API_KEY;
    await makeUser('crew', { email: 'rita@gema.test' });
    const r = await api('POST', '/api/auth/forgot', { body: { agencyId: 'GEMA', email: 'rita@gema.test' } });
    expect(r.json.message).toBe(FORGOT_MESSAGE);
    await vi.waitFor(async () => expect(await row('SELECT COUNT(*) AS n FROM auth_throttle WHERE kind = ?', 'forgot_email')).toMatchObject({ n: 1 }));
    expect(sent.length).toBe(0);
    expect((await api('GET', '/api/auth/config')).json).toEqual({ emailEnabled: false });
  });
});

describe('configuration', () => {
  it('reports emailEnabled only when both the key and the sender are set', async () => {
    expect((await api('GET', '/api/auth/config')).json).toEqual({ emailEnabled: true });
    expect((await api('GET', '/api/auth/session')).json.emailEnabled).toBe(true);
    delete (E as any).MAIL_FROM;
    expect((await api('GET', '/api/auth/config')).json).toEqual({ emailEnabled: false });
  });
  it('the development mail sink endpoint does not exist unless MAIL_SINK=1 on localhost', async () => {
    expect((await api('GET', '/api/dev/last-mail')).status).toBe(404);
    (E as any).MAIL_SINK = '1'; // APP_URL is not localhost here, so it must still refuse
    expect((await api('GET', '/api/dev/last-mail')).status).toBe(404);
    delete (E as any).MAIL_SINK;
  });
});
