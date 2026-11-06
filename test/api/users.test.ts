import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, row, rows, cookieOf, PASSWORD } from './helpers';

let fm: string, admin: string;
beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager', { email: 'fm@gema.test' })).cookie;
  admin = (await as('system_admin', { email: 'admin@gema.test' })).cookie;
});
const mk = (cookie: string, o: any = {}) => api('POST', '/api/users', { cookie, body: { email: 'pat@gema.test', name: 'Pat Crew', role: 'crew', ...o } });

describe('users screen API', () => {
  it('creates a user with a one-time temporary password they must change', async () => {
    const r = await mk(fm);
    expect(r.status).toBe(200);
    const pw = r.json.temporaryPassword;
    expect(pw).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
    const list = await api('GET', '/api/users', { cookie: fm });
    const pat = list.json.users.find((u: any) => u.email === 'pat@gema.test');
    expect(pat).toMatchObject({ role: 'crew', active: true, mustChangePassword: true });
    expect(JSON.stringify(list.json)).not.toContain('pbkdf2');
    expect(JSON.stringify(list.json)).not.toContain(pw);
    const login = await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: pw } });
    expect(login.status).toBe(200);
    expect(login.json.user.mustChangePassword).toBe(true);
    expect((await api('GET', '/api/sync', { cookie: cookieOf(login) })).status).toBe(403);
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
  it('only a system administrator can create or change a system administrator', async () => {
    expect((await mk(fm, { email: 'a2@gema.test', role: 'system_admin' })).status).toBe(403);
    expect((await mk(admin, { email: 'a2@gema.test', role: 'system_admin' })).status).toBe(200);
    const a2 = await row("SELECT id FROM users WHERE email = 'a2@gema.test'");
    expect((await api('POST', `/api/users/${a2.id}/reset-password`, { cookie: fm })).status).toBe(403);
    expect((await api('POST', `/api/users/${a2.id}/deactivate`, { cookie: fm })).status).toBe(403);
    expect((await api('PUT', `/api/users/${a2.id}`, { cookie: fm, body: { name: 'x', role: 'crew' } })).status).toBe(403);
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
  it('reset password gives a new temporary password, signs the person out and forces a change', async () => {
    const created = await mk(fm);
    const login = await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: created.json.temporaryPassword } });
    const patCookie = cookieOf(login);
    await api('POST', '/api/auth/change-password', { cookie: patCookie, body: { currentPassword: created.json.temporaryPassword, newPassword: 'pat-own-password-1' } });
    expect((await api('GET', '/api/sync', { cookie: patCookie })).status).toBe(200);
    const reset = await api('POST', `/api/users/${created.json.id}/reset-password`, { cookie: fm });
    expect(reset.status).toBe(200);
    expect((await api('GET', '/api/sync', { cookie: patCookie })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: 'pat-own-password-1' } })).status).toBe(401);
    const again = await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: reset.json.temporaryPassword } });
    expect(again.json.user.mustChangePassword).toBe(true);
  });
  it('deactivate signs the person out and blocks login; reactivate restores it; you cannot deactivate yourself', async () => {
    const created = await mk(fm);
    const login = await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: created.json.temporaryPassword } });
    await api('POST', `/api/users/${created.json.id}/deactivate`, { cookie: fm });
    expect((await api('GET', '/api/auth/me', { cookie: cookieOf(login) })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: created.json.temporaryPassword } })).status).toBe(401);
    await api('POST', `/api/users/${created.json.id}/reactivate`, { cookie: fm });
    expect((await api('POST', '/api/auth/login', { body: { email: 'pat@gema.test', password: created.json.temporaryPassword } })).status).toBe(200);
    const me = await row("SELECT id FROM users WHERE email = 'fm@gema.test'");
    expect((await api('POST', `/api/users/${me.id}/deactivate`, { cookie: fm })).status).toBe(400);
  });
  it('audits user admin without storing passwords', async () => {
    const c = await mk(fm);
    await api('POST', `/api/users/${c.json.id}/reset-password`, { cookie: fm });
    const a = await rows("SELECT * FROM audit_log WHERE action LIKE 'user.%'");
    expect(a.map((x: any) => x.action)).toEqual(['user.create', 'user.reset_password']);
    expect(JSON.stringify(a)).not.toContain('pbkdf2');
    expect(JSON.stringify(a)).not.toContain(c.json.temporaryPassword);
  });
});
void PASSWORD;
