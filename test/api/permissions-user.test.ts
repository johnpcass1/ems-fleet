import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, syncAll, row, rows, superCookie, setUploads, SUPER_EMAIL, PASSWORD, E } from './helpers';

let fm: string, admin: string, su: string, crew: string, crewId: string, hqCrew: string, hqCrewId: string, fmId: string, adminId: string, suId: string;
const perms = (cookie: string, id: string, overrides: Record<string, boolean>) => api('POST', `/api/users/${id}/permissions`, { cookie, body: { overrides } });
const idOf = async (email: string) => (await row('SELECT id FROM users WHERE email = ?', email)).id as string;
beforeEach(async () => {
  await seedDemo();
  const f = await as('fleet_manager', { email: 'fm@gema.test' }); fm = f.cookie; fmId = f.user.id;
  const a = await as('system_admin', { email: 'admin@gema.test' }); admin = a.cookie; adminId = a.user.id;
  su = await superCookie(); suId = await idOf(SUPER_EMAIL);
  const c = await as('crew', { email: 'crew@gema.test' }); crew = c.cookie; crewId = c.user.id;
  const h = await as('crew', { email: 'hq@gema.test', baseIds: ['b-hq'] }); hqCrew = h.cookie; hqCrewId = h.user.id;
});

describe('super user', () => {
  it('is flagged in the session and login responses, and only for the listed address', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: SUPER_EMAIL, password: PASSWORD } });
    expect(r.json.user.isSuperuser).toBe(true);
    expect(r.json.user.perms.backups).toBe(true);
    expect((await api('GET', '/api/auth/session', { cookie: su })).json.user.isSuperuser).toBe(true);
    expect((await api('GET', '/api/auth/session', { cookie: fm })).json.user.isSuperuser).toBe(false);
  });
  it('has every permission whatever the role, including backups and features', async () => {
    expect((await api('GET', '/api/admin/backups', { cookie: su })).status).toBe(200);
    expect((await api('GET', '/api/admin/backups', { cookie: fm })).status).toBe(403);
    expect((await api('GET', '/api/users', { cookie: su })).status).toBe(200);
    const list = (await api('GET', '/api/users', { cookie: su })).json.users;
    expect(list.find((x: any) => x.email === SUPER_EMAIL).isSuperuser).toBe(true);
  });
  it('nobody else can edit, deactivate, change the role or permissions of, set the password of or send links to the super user (403)', async () => {
    for (const c of [fm, admin]) {
      expect((await api('PUT', `/api/users/${suId}`, { cookie: c, body: { name: 'x', role: 'viewer' } })).status).toBe(403);
      expect((await api('POST', `/api/users/${suId}/deactivate`, { cookie: c })).status).toBe(403);
      expect((await api('POST', `/api/users/${suId}/password`, { cookie: c, body: { password: 'another-long-pass-1' } })).status).toBe(403);
      expect((await api('POST', `/api/users/${suId}/reset-link`, { cookie: c })).status).toBe(403);
      expect((await api('POST', `/api/users/${suId}/invite`, { cookie: c })).status).toBe(403);
      expect((await perms(c, suId, { upload: false })).status).toBe(403);
    }
    expect((await row('SELECT role, active FROM users WHERE id = ?', suId))).toMatchObject({ role: 'system_admin', active: 1 });
    expect((await perms(su, suId, { upload: false })).status).toBe(403); // not even themselves
  });
  it('is unaffected by overrides stored on its own row', async () => {
    await E.DB.prepare("UPDATE users SET perm_overrides = '{\"report\":false,\"users\":false}' WHERE id = ?").bind(suId).run();
    expect((await api('GET', '/api/users', { cookie: su })).status).toBe(200);
    expect((await api('GET', '/api/auth/me', { cookie: su })).json.user.perms.report).toBe(true);
  });
});

describe('per-person permissions', () => {
  it('role defaults are unchanged until an override is set', async () => {
    const me = (await api('GET', '/api/auth/me', { cookie: crew })).json.user;
    expect(me.perms).toMatchObject({ report: true, reading: true, upload: true, move: false, users: false, viewReports: true });
    expect((await api('GET', '/api/auth/me', { cookie: fm })).json.user.perms).toMatchObject({ users: true, setup: true, backups: false, approve: true });
  });
  it('revoking `report` makes their report 403, and it shows in their next sync without logging in again', async () => {
    const body = { vehicleId: 'v-01', title: 'Mirror loose', severity: 'minor' };
    expect((await api('POST', '/api/issues', { cookie: crew, body })).status).toBe(200);
    const s0 = await syncAll(crew);
    expect(s0.me.perms.report).toBe(true);
    expect((await perms(fm, crewId, { report: false })).status).toBe(200);
    expect((await api('POST', '/api/issues', { cookie: crew, body })).status).toBe(403);
    const s1 = await syncAll(crew, s0.cursor);
    expect(s1.me.perms.report).toBe(false); // even though nothing else changed
    expect(s1.me.role).toBe('crew');
    expect(JSON.parse((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o)).toEqual({ report: false });
  });
  it('granting `move` works only within the person\'s bases', async () => {
    expect((await api('POST', '/api/moves', { cookie: hqCrew, body: { vehicleIds: ['v-01'], toBaseId: 'b-diamond', reason: 'x' } })).status).toBe(403);
    expect((await perms(fm, hqCrewId, { move: true })).status).toBe(200);
    const vs = (await syncAll(fm)).data.vehicles;
    const mine = vs.find((v: any) => v.baseId === 'b-hq'), other = vs.find((v: any) => v.baseId !== 'b-hq');
    const to = 'b-diamond' === mine.baseId ? 'b-hq' : 'b-diamond';
    expect((await api('POST', '/api/moves', { cookie: hqCrew, body: { vehicleIds: [other.id], toBaseId: to, reason: 'x' } })).status).toBe(403);
    expect((await api('POST', '/api/moves', { cookie: hqCrew, body: { vehicleIds: [mine.id], toBaseId: to, reason: 'x' } })).status).toBe(200);
  });
  it('only stores differences from the role default, and a reset clears them', async () => {
    expect((await perms(fm, crewId, { report: true, move: false, upload: false, status: true })).status).toBe(200);
    expect(JSON.parse((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o)).toEqual({ upload: false, status: true });
    expect((await perms(fm, crewId, {})).status).toBe(200);
    expect((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o).toBe('{}');
  });
  it('is audited with before and after', async () => {
    await perms(fm, crewId, { upload: false });
    await perms(fm, crewId, { upload: false, move: true });
    const log = await rows("SELECT user_email, entity_id, before_json, after_json FROM audit_log WHERE action = 'user.permissions' ORDER BY id");
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ user_email: 'fm@gema.test', entity_id: crewId });
    expect(JSON.parse(log[1].before_json).overrides).toEqual({ upload: false });
    expect(JSON.parse(log[1].after_json).overrides).toEqual({ upload: false, move: true });
  });
  it('rejects unknown keys and non-boolean values', async () => {
    expect((await perms(fm, crewId, { fly: true })).status).toBe(400);
    expect((await api('POST', `/api/users/${crewId}/permissions`, { cookie: fm, body: { overrides: { move: 'yes' } } })).status).toBe(400);
    expect((await api('POST', `/api/users/${crewId}/permissions`, { cookie: fm, body: {} })).status).toBe(400);
  });
  it('people without the users permission cannot use it; an override can give or take it away', async () => {
    expect((await perms(crew, hqCrewId, { upload: false })).status).toBe(403);
    expect((await api('GET', '/api/users', { cookie: crew })).status).toBe(403);
    expect((await perms(su, fmId, { users: false })).status).toBe(200);
    expect((await api('GET', '/api/users', { cookie: fm })).status).toBe(403);
  });
});

describe('who can edit whose permissions and roles', () => {
  it('a fleet manager cannot edit fleet managers, system admins or the super user, and nobody edits themselves', async () => {
    const fm2 = (await as('fleet_manager', { email: 'fm2@gema.test' })).user.id;
    expect((await perms(fm, fm2, { upload: false })).status).toBe(403);
    expect((await perms(fm, adminId, { upload: false })).status).toBe(403);
    expect((await perms(fm, suId, { upload: false })).status).toBe(403);
    expect((await perms(fm, fmId, { upload: false })).status).toBe(403);
    expect((await perms(admin, adminId, { upload: false })).status).toBe(403);
    expect((await api('PUT', `/api/users/${fmId}`, { cookie: fm, body: { name: 'Me', role: 'crew' } })).status).toBe(400); // own role
    expect((await api('PUT', `/api/users/${fm2}`, { cookie: fm, body: { name: 'x', role: 'crew' } })).status).toBe(403);
  });
  it('a system admin can edit fleet managers and below, but not other system admins', async () => {
    const admin2 = (await as('system_admin', { email: 'admin2@gema.test' })).user.id;
    expect((await perms(admin, fmId, { cancelWO: false })).status).toBe(200);
    expect((await perms(admin, admin2, { cancelWO: false })).status).toBe(403);
    expect((await perms(su, admin2, { cancelWO: false })).status).toBe(200);
    expect((await perms(su, fmId, { cancelWO: false })).status).toBe(200);
  });
  it('an editor can only turn ON what they have themselves, and only the super user can grant users, setup or backups', async () => {
    // a fleet manager who lost `approve` cannot hand it to a crew member
    await perms(su, fmId, { approve: false });
    expect((await perms(fm, crewId, { approve: true })).status).toBe(403);
    expect((await perms(fm, crewId, { createWO: true })).status).toBe(200);
    // admin keys: fleet manager and system admin cannot grant them, super user can
    for (const k of ['users', 'setup', 'backups']) {
      expect((await perms(fm, crewId, { [k]: true })).status, 'fm ' + k).toBe(403);
      expect((await perms(admin, hqCrewId, { [k]: true })).status, 'admin ' + k).toBe(403);
    }
    expect((await perms(su, hqCrewId, { users: true, setup: true, backups: true })).status).toBe(200);
    expect((await api('GET', '/api/users', { cookie: hqCrew })).status).toBe(200);
    expect((await api('GET', '/api/admin/backups', { cookie: hqCrew })).status).toBe(200);
    // untouched values do not count as grants: a fleet manager can save a form where someone else's admin override is already on
    expect((await perms(fm, hqCrewId, { users: true, setup: true, backups: true, upload: false })).status).toBe(200);
    expect(JSON.parse((await row('SELECT perm_overrides o FROM users WHERE id = ?', hqCrewId)).o)).toMatchObject({ users: true, upload: false });
  });
  it('turning things off is always allowed to a manager of that person', async () => {
    await perms(su, crewId, { users: true });
    expect((await perms(fm, crewId, { users: true, report: false })).status).toBe(200); // users stays as it was, report goes off
    expect((await perms(fm, crewId, { users: false })).status).toBe(200);
  });
  it('role assignment follows the same hierarchy for create and edit', async () => {
    const mk = (c: string, role: string, email: string) => api('POST', '/api/users', { cookie: c, body: { email, name: 'N', role, password: 'long-enough-pass-1' } });
    expect((await mk(fm, 'fleet_manager', 'n1@gema.test')).status).toBe(403);
    expect((await mk(fm, 'system_admin', 'n2@gema.test')).status).toBe(403);
    expect((await mk(fm, 'base_supervisor', 'n3@gema.test')).status).toBe(400); // allowed role, but needs a base
    expect((await mk(fm, 'mechanic', 'n4@gema.test')).status).toBe(400);
    expect((await mk(fm, 'viewer', 'n5@gema.test')).status).toBe(200);
    expect((await mk(admin, 'fleet_manager', 'n6@gema.test')).status).toBe(200);
    expect((await mk(admin, 'system_admin', 'n7@gema.test')).status).toBe(403);
    expect((await mk(su, 'system_admin', 'n8@gema.test')).status).toBe(200);
    // promoting
    expect((await api('PUT', `/api/users/${crewId}`, { cookie: fm, body: { name: 'x', role: 'fleet_manager' } })).status).toBe(403);
    expect((await api('PUT', `/api/users/${crewId}`, { cookie: admin, body: { name: 'x', role: 'fleet_manager' } })).status).toBe(200);
  });
  it('a role change keeps the overrides', async () => {
    await perms(fm, crewId, { upload: false });
    await api('PUT', `/api/users/${crewId}`, { cookie: fm, body: { name: 'x', role: 'viewer' } });
    expect(JSON.parse((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o)).toEqual({ upload: false });
  });
  it('the other account actions follow the hierarchy too', async () => {
    const fm2 = (await as('fleet_manager', { email: 'fm3@gema.test' })).user.id;
    expect((await api('POST', `/api/users/${fm2}/deactivate`, { cookie: fm })).status).toBe(403);
    expect((await api('POST', `/api/users/${fm2}/password`, { cookie: fm, body: { password: 'another-long-pass-1' } })).status).toBe(403);
    expect((await api('POST', `/api/users/${fm2}/deactivate`, { cookie: admin })).status).toBe(200);
    expect((await api('POST', `/api/users/${crewId}/deactivate`, { cookie: fm })).status).toBe(200);
  });
});

describe('migration 0003', () => {
  it('adds perm_overrides with a default of {} to rows that already exist', async () => {
    const cols = await rows("SELECT name, dflt_value, \"notnull\" nn FROM pragma_table_info('users') WHERE name = 'perm_overrides'");
    expect(cols).toHaveLength(1);
    expect(cols[0].nn).toBe(1);
    expect(cols[0].dflt_value).toBe("'{}'");
    expect((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o).toBe('{}');
    await setUploads(null, true);
  });
  it('applies cleanly to a users table that already holds rows (the real 0003 statements, run on a copy of the table)', async () => {
    const m = ((E as any).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((x) => x.name.startsWith('0003'))!;
    expect(m).toBeTruthy();
    await E.DB.prepare('CREATE TABLE users_before (id TEXT PRIMARY KEY, email TEXT, role TEXT)').run();
    await E.DB.prepare("INSERT INTO users_before VALUES ('u1','a@x.org','crew'),('u2','b@x.org','fleet_manager')").run();
    for (const q of m.queries) await E.DB.prepare(q.replace(/\busers\b/g, 'users_before')).run();
    expect((await rows('SELECT id, perm_overrides o FROM users_before ORDER BY id')).map((r: any) => r.o)).toEqual(['{}', '{}']);
    await E.DB.prepare('DROP TABLE users_before').run();
  });
});
