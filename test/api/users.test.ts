import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, row, rows, cookieOf, loginAs, PASSWORD, superCookie } from './helpers';

const PW = 'pat-start-pass-1';
let fm: string, admin: string;
beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager', { email: 'fm@gema.test' })).cookie;
  admin = (await as('system_admin', { email: 'admin@gema.test' })).cookie;
});
const mk = (cookie: string, o: any = {}) => api('POST', '/api/users', { cookie, body: { email: 'pat@gema.test', name: 'Pat Crew', role: 'crew', password: PW, ...o } });

describe('users screen API', () => {
  it('creates a user with a password the admin chose; they are not forced to change it', async () => {
    const r = await mk(fm);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain(PW);
    const list = await api('GET', '/api/users', { cookie: fm });
    const pat = list.json.users.find((u: any) => u.email === 'pat@gema.test');
    expect(pat).toMatchObject({ role: 'crew', active: true, mustChangePassword: false, invited: false });
    expect(JSON.stringify(list.json)).not.toContain('pbkdf2');
    expect(JSON.stringify(list.json)).not.toContain(PW);
    const login = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } });
    expect(login.status).toBe(200);
    expect(login.json.user.mustChangePassword).toBe(false);
    expect((await api('GET', '/api/sync', { cookie: cookieOf(login) })).status).toBe(200);
    // no invite token, no email
    expect((await rows('SELECT * FROM account_tokens')).length).toBe(0);
  });
  it('needs exactly one of password or invite, and rejects weak passwords', async () => {
    expect((await mk(fm, { password: undefined })).status).toBe(400);
    expect((await mk(fm, { password: 'short' })).status).toBe(400);
    expect((await mk(fm, { password: 'aaaaaaaaaaaa' })).status).toBe(400);
    expect((await mk(fm, { password: 'pat@gema.test' })).status).toBe(400);
    expect((await mk(fm, { password: PW, invite: true })).status).toBe(400);
    expect((await row("SELECT 1 AS x FROM users WHERE email = 'pat@gema.test'"))).toBeNull();
  });
  it('invite:true is rejected while email is not set up', async () => {
    const r = await mk(fm, { password: undefined, invite: true });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('email_disabled');
    expect((await row("SELECT 1 AS x FROM users WHERE email = 'pat@gema.test'"))).toBeNull();
    const id = (await mk(fm)).json.id;
    expect((await api('POST', `/api/users/${id}/invite`, { cookie: fm })).status).toBe(400);
    expect((await api('POST', `/api/users/${id}/reset-link`, { cookie: fm })).status).toBe(400);
  });
  it('validates role, bases, mechanic link and duplicates', async () => {
    expect((await mk(fm, { role: 'boss' })).status).toBe(400);
    expect((await mk(fm, { email: 'not-an-email' })).status).toBe(400);
    expect((await mk(fm, { role: 'base_supervisor' })).status).toBe(400); // needs a base
    expect((await mk(fm, { role: 'base_supervisor', baseIds: ['b-nope'] })).status).toBe(400);
    expect((await mk(fm, { role: 'base_supervisor', baseIds: ['b-hq'] })).status).toBe(200);
    expect((await mk(fm, { email: 'm@gema.test', role: 'mechanic' })).status).toBe(400); // needs a mechanic
    expect((await mk(fm, { email: 'm@gema.test', role: 'mechanic', mechanicId: 'm-1' })).status).toBe(200);
    expect((await mk(fm, { email: 'PAT@gema.test' })).status).toBe(409);
  });
  it('only the super user can create or change a system administrator', async () => {
    const su = await superCookie();
    expect((await mk(fm, { email: 'a2@gema.test', role: 'system_admin' })).status).toBe(403);
    expect((await mk(admin, { email: 'a2@gema.test', role: 'system_admin' })).status).toBe(403);
    expect((await mk(su, { email: 'a2@gema.test', role: 'system_admin' })).status).toBe(200);
    const a2 = await row("SELECT id FROM users WHERE email = 'a2@gema.test'");
    for (const c of [fm, admin]) {
      expect((await api('POST', `/api/users/${a2.id}/password`, { cookie: c, body: { password: 'brand-new-pass-1' } })).status).toBe(403);
      expect((await api('POST', `/api/users/${a2.id}/deactivate`, { cookie: c })).status).toBe(403);
      expect((await api('PUT', `/api/users/${a2.id}`, { cookie: c, body: { name: 'x', role: 'crew' } })).status).toBe(403);
    }
    expect((await api('POST', `/api/users/${a2.id}/password`, { cookie: su, body: { password: 'brand-new-pass-1' } })).status).toBe(200);
  });
  it('edits role and bases', async () => {
    const id = (await mk(fm)).json.id;
    const r = await api('PUT', `/api/users/${id}`, { cookie: fm, body: { name: 'Pat Super', role: 'base_supervisor', baseIds: ['b-hq', 'b-diamond'] } });
    expect(r.status).toBe(200);
    expect(await row('SELECT name, role, base_ids FROM users WHERE id = ?', id)).toMatchObject({ name: 'Pat Super', role: 'base_supervisor', base_ids: '["b-hq","b-diamond"]' });
    // nobody can change their own role
    const me = await row("SELECT id FROM users WHERE email = 'fm@gema.test'");
    expect((await api('PUT', `/api/users/${me.id}`, { cookie: fm, body: { name: 'Me', role: 'viewer' } })).status).toBe(400);
  });
  it('Set password ends the person\'s sessions, works for login, and does not force a change', async () => {
    const created = await mk(fm);
    const patCookie = await loginAs({ email: 'pat@gema.test', password: PW });
    expect((await api('GET', '/api/sync', { cookie: patCookie })).status).toBe(200);
    const set = await api('POST', `/api/users/${created.json.id}/password`, { cookie: fm, body: { password: 'new-chosen-pass-2' } });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.json)).not.toContain('new-chosen-pass-2');
    expect((await api('GET', '/api/sync', { cookie: patCookie })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } })).status).toBe(401);
    const again = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: 'new-chosen-pass-2' } });
    expect(again.status).toBe(200);
    expect(again.json.user.mustChangePassword).toBe(false);
    // people can still change their own password
    const ch = await api('POST', '/api/auth/change-password', { cookie: cookieOf(again), body: { currentPassword: 'new-chosen-pass-2', newPassword: 'my-own-password-3' } });
    expect(ch.status).toBe(200);
  });
  it('Set password: weak password rejected, not for yourself, not for crew callers, unknown user 404', async () => {
    const created = await mk(fm);
    const url = `/api/users/${created.json.id}/password`;
    expect((await api('POST', url, { cookie: fm, body: { password: 'short' } })).status).toBe(400);
    expect((await api('POST', url, { cookie: fm, body: { password: 'zzzzzzzzzzzz' } })).status).toBe(400);
    expect((await api('POST', url, { cookie: fm, body: {} })).status).toBe(400);
    const me = await row("SELECT id FROM users WHERE email = 'fm@gema.test'");
    expect((await api('POST', `/api/users/${me.id}/password`, { cookie: fm, body: { password: 'brand-new-pass-1' } })).status).toBe(400);
    const crew = (await as('crew', { baseIds: ['b-hq'] })).cookie;
    expect((await api('POST', url, { cookie: crew, body: { password: 'brand-new-pass-1' } })).status).toBe(403);
    expect((await api('POST', '/api/users/u-nope/password', { cookie: fm, body: { password: 'brand-new-pass-1' } })).status).toBe(404);
    expect((await api('POST', url, { body: { password: 'brand-new-pass-1' } })).status).toBe(401);
    // the old password still works after all those refusals
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } })).status).toBe(200);
  });
  it('deactivate signs the person out and blocks login; reactivate restores it; you cannot deactivate yourself', async () => {
    const created = await mk(fm);
    const login = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } });
    await api('POST', `/api/users/${created.json.id}/deactivate`, { cookie: fm });
    expect((await api('GET', '/api/auth/me', { cookie: cookieOf(login) })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } })).status).toBe(401);
    await api('POST', `/api/users/${created.json.id}/reactivate`, { cookie: fm });
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@gema.test', password: PW } })).status).toBe(200);
    const me = await row("SELECT id FROM users WHERE email = 'fm@gema.test'");
    expect((await api('POST', `/api/users/${me.id}/deactivate`, { cookie: fm })).status).toBe(400);
  });
  it('audits user admin without storing passwords', async () => {
    const c = await mk(fm);
    await api('POST', `/api/users/${c.json.id}/password`, { cookie: fm, body: { password: 'new-chosen-pass-2' } });
    const a = await rows("SELECT * FROM audit_log WHERE action LIKE 'user.%'");
    expect(a.map((x: any) => x.action)).toEqual(['user.create', 'user.set_password']);
    expect(JSON.stringify(a)).not.toContain('pbkdf2');
    expect(JSON.stringify(a)).not.toContain(PW);
    expect(JSON.stringify(a)).not.toContain('new-chosen-pass-2');
  });
});
void PASSWORD;
