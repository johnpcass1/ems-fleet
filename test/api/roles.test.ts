import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, syncAll, row, rows, superCookie, E } from './helpers';

let fm: string, admin: string, su: string, crew: string, crewId: string, crew2: string, crew2Id: string, mech: string;
const putRole = (cookie: string, role: string, overrides: any) => api('PUT', `/api/roles/${role}/permissions`, { cookie, body: { overrides } });
const resetRole = (cookie: string, role: string) => api('POST', `/api/roles/${role}/reset`, { cookie });
const perms = (cookie: string, id: string, overrides: Record<string, boolean>) => api('POST', `/api/users/${id}/permissions`, { cookie, body: { overrides } });
const stored = async () => JSON.parse((await row("SELECT data FROM settings WHERE id = 'GEMA'")).data);
const issue = (cookie: string) => api('POST', '/api/issues', { cookie, body: { vehicleId: 'v-01', title: 'Mirror loose', severity: 'minor' } });

beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager', { email: 'fm@gema.test' })).cookie;
  admin = (await as('system_admin', { email: 'admin@gema.test' })).cookie;
  su = await superCookie();
  const c = await as('crew', { email: 'crew@gema.test' }); crew = c.cookie; crewId = c.user.id;
  const c2 = await as('crew', { email: 'crew2@gema.test' }); crew2 = c2.cookie; crew2Id = c2.user.id;
  mech = (await as('mechanic', { email: 'mech@gema.test', mechanicId: 'm-1' })).cookie;
  // start each test from the built-in defaults
  for (const r of ['crew', 'mechanic', 'fleet_manager', 'system_admin', 'viewer']) await resetRole(su, r);
});

describe('role-level permissions', () => {
  it('a role change reaches everyone in that role within a sync, and nobody in other roles', async () => {
    const s0 = await syncAll(crew), m0 = await syncAll(mech);
    expect(s0.me.perms.report).toBe(true);
    expect((await putRole(su, 'crew', { report: false })).status).toBe(200);
    expect((await issue(crew)).status).toBe(403);
    expect((await issue(crew2)).status).toBe(403);
    const s1 = await syncAll(crew, s0.cursor), s2 = await syncAll(crew2);
    expect(s1.me.perms.report).toBe(false);
    expect(s2.me.perms.report).toBe(false);
    expect((await syncAll(mech, m0.cursor)).me.perms.report).toBe(true);
    expect((await issue(mech)).status).toBe(200);
    // the saved role change is in the synced settings so the Roles screen can show it
    expect(s1.data.settings.find((x: any) => x.id === 'GEMA').rolePerms).toEqual({ crew: { report: false } });
    expect((await api('GET', '/api/auth/me', { cookie: crew })).json.user.perms.report).toBe(false);
  });
  it('can grant things beyond the built-in default, and only stores differences from it', async () => {
    expect((await putRole(su, 'crew', { report: true, status: true, move: false })).status).toBe(200);
    expect((await stored()).rolePerms).toEqual({ crew: { status: true } });
    expect((await syncAll(crew)).me.perms.status).toBe(true);
  });
  it('a per-person override beats the role change, in both directions', async () => {
    await putRole(su, 'crew', { report: false, status: true });
    await perms(admin, crewId, { report: true, status: false });
    const me = (await api('GET', '/api/auth/me', { cookie: crew })).json.user.perms;
    expect(me.report).toBe(true);
    expect(me.status).toBe(false);
    expect((await issue(crew)).status).toBe(200);
    expect((await api('GET', '/api/auth/me', { cookie: crew2 })).json.user.perms).toMatchObject({ report: false, status: true });
    // per-person overrides are stored relative to the role's value: setting the same as the role clears them
    await perms(admin, crewId, { report: false, status: true });
    expect((await row('SELECT perm_overrides o FROM users WHERE id = ?', crewId)).o).toBe('{}');
  });
  it('reset clears the role back to the built-in defaults', async () => {
    await putRole(su, 'crew', { report: false });
    expect((await resetRole(admin, 'crew')).status).toBe(200);
    expect((await stored()).rolePerms ?? {}).toEqual({});
    expect((await syncAll(crew)).me.perms.report).toBe(true);
  });
  it('the super user edits any role; a system admin edits fleet manager and below but not system_admin; everyone else gets 403', async () => {
    expect((await putRole(su, 'system_admin', { cancelWO: false })).status).toBe(200);
    expect((await putRole(admin, 'system_admin', { cancelWO: true })).status).toBe(403);
    expect((await resetRole(admin, 'system_admin')).status).toBe(403);
    for (const r of ['fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer']) expect((await putRole(admin, r, { cancelWO: false })).status, r).toBe(200);
    expect((await putRole(su, 'dispatcher', { cancelWO: false })).status).toBe(200);
    for (const c of [fm, crew, mech]) {
      for (const r of ['crew', 'fleet_manager', 'viewer']) {
        expect((await putRole(c, r, { report: false })).status).toBe(403);
        expect((await resetRole(c, r)).status).toBe(403);
      }
    }
    expect((await putRole(su, 'nobody', {})).status).toBe(404);
    expect((await stored()).rolePerms.system_admin).toEqual({ cancelWO: false });
  });
  it('a system admin can edit the fleet manager role, and it takes effect', async () => {
    expect((await putRole(admin, 'fleet_manager', { cancelWO: false })).status).toBe(200);
    expect((await syncAll(fm)).me.perms.cancelWO).toBe(false);
  });
  it('the super user keeps every permission whatever any role says', async () => {
    await putRole(su, 'system_admin', { users: false, report: false });
    const me = (await api('GET', '/api/auth/me', { cookie: su })).json.user.perms;
    expect(me.users).toBe(true);
    expect(me.backups).toBe(true);
  });
  it('users and setup can be granted to a role only by the super user; backups by nobody', async () => {
    for (const k of ['users', 'setup']) expect((await putRole(admin, 'crew', { [k]: true })).status, k).toBe(403);
    expect((await putRole(su, 'crew', { users: true, setup: true })).status).toBe(200);
    expect((await api('GET', '/api/users', { cookie: crew })).status).toBe(200);
    // the system admin can still turn them off, and saving a form that leaves them on is not a grant
    expect((await putRole(admin, 'crew', { users: true, setup: true, report: false })).status).toBe(200);
    expect((await putRole(admin, 'crew', { setup: false })).status).toBe(200);
    expect((await stored()).rolePerms?.crew).toBeUndefined(); // the body replaces the role's changes: users went off too, setup:false equals the default
    for (const c of [su, admin, fm]) expect((await putRole(c, 'crew', { backups: true })).status, 'backups').toBe(c === fm ? 403 : 400);
    expect((await putRole(su, 'crew', { backups: false })).status).toBe(400);
    expect((await api('GET', '/api/admin/backups', { cookie: crew })).status).toBe(403);
    expect((await putRole(su, 'crew', { fly: true })).status).toBe(400);
    expect((await putRole(su, 'crew', { report: 'yes' })).status).toBe(400);
    expect((await api('PUT', '/api/roles/crew/permissions', { cookie: su, body: {} })).status).toBe(400);
  });
  it('a stored backups entry in rolePerms is ignored', async () => {
    const cur = await stored();
    await E.DB.prepare("UPDATE settings SET data = ? WHERE id = 'GEMA'").bind(JSON.stringify({ ...cur, rolePerms: { crew: { backups: true, report: false } } })).run();
    expect((await api('GET', '/api/admin/backups', { cookie: crew })).status).toBe(403);
    expect((await api('GET', '/api/auth/me', { cookie: crew })).json.user.perms).toMatchObject({ backups: false, report: false });
  });
  it('an editor can only turn on what they have themselves', async () => {
    await perms(su, (await row('SELECT id FROM users WHERE email = ?', 'admin@gema.test')).id, { approve: false });
    expect((await putRole(admin, 'crew', { approve: true })).status).toBe(403);
    expect((await putRole(admin, 'crew', { createWO: true })).status).toBe(200);
  });
  it('the general settings save cannot alter rolePerms or features (even when sent)', async () => {
    await putRole(su, 'crew', { report: false });
    await api('PUT', '/api/features', { cookie: su, body: { uploads: true } });
    const body = { approvalThresholdGYD: 1, dueSoonHours: 2, dueSoonDays: 3, comebackDays: 4, rolePerms: { crew: { report: true }, viewer: { move: true } }, features: { uploads: false } };
    expect((await api('PUT', '/api/settings', { cookie: fm, body })).status).toBe(200);
    expect((await api('PUT', '/api/settings', { cookie: admin, body })).status).toBe(200);
    const s = await stored();
    expect(s.rolePerms).toEqual({ crew: { report: false } });
    expect(s.features).toEqual({ uploads: true });
    expect(s.approvalThresholdGYD).toBe(1);
    expect((await api('PUT', '/api/features', { cookie: admin, body: { uploads: false } })).status).toBe(403);
  });
  it('is audited with before and after', async () => {
    await putRole(admin, 'crew', { report: false });
    await putRole(admin, 'crew', { report: false, status: true });
    await resetRole(su, 'crew');
    const log = await rows("SELECT user_email, action, entity_type, entity_id, before_json, after_json FROM audit_log WHERE action IN ('role.permissions','role.reset') AND entity_id = 'crew' ORDER BY id DESC LIMIT 3");
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ action: 'role.reset', user_email: expect.stringContaining('@'), entity_type: 'role' });
    expect(JSON.parse(log[0].before_json).overrides).toEqual({ report: false, status: true });
    expect(JSON.parse(log[0].after_json).overrides).toEqual({});
    expect(log[1]).toMatchObject({ action: 'role.permissions', user_email: 'admin@gema.test' });
    expect(JSON.parse(log[1].before_json)).toEqual({ role: 'crew', overrides: { report: false } });
    expect(JSON.parse(log[1].after_json)).toEqual({ role: 'crew', overrides: { report: false, status: true } });
  });
  it('the dispatcher feed does not carry role permissions', async () => {
    await putRole(su, 'crew', { report: false });
    const d = (await as('dispatcher')).cookie;
    const s = (await syncAll(d)).data.settings.find((x: any) => x.id === 'GEMA');
    expect(s.rolePerms).toBeUndefined();
  });
});

describe('who can do what (three admin levels)', () => {
  it('only the super user can use backups: list, run and download are 403 for system admin and fleet manager', async () => {
    for (const c of [admin, fm]) {
      expect((await api('GET', '/api/admin/backups', { cookie: c })).status).toBe(403);
      expect((await api('POST', '/api/admin/backups/step', { cookie: c, body: {} })).status).toBe(403);
      expect((await api('GET', '/api/admin/backups/2026-01-01', { cookie: c })).status).toBe(403);
    }
    expect((await api('GET', '/api/admin/backups', { cookie: su })).status).toBe(200);
    expect((await api('GET', '/api/auth/me', { cookie: admin })).json.user.perms.backups).toBe(false);
    expect((await api('GET', '/api/auth/me', { cookie: su })).json.user.perms.backups).toBe(true);
  });
  it('a fleet manager has no access to per-person or role permissions, but can still create accounts and change roles below', async () => {
    expect((await perms(fm, crewId, { report: false })).status).toBe(403);
    expect((await putRole(fm, 'crew', { report: false })).status).toBe(403);
    const mk = await api('POST', '/api/users', { cookie: fm, body: { email: 'new-crew@gema.test', name: 'New Crew', role: 'crew', password: 'long-enough-pass-1' } });
    expect(mk.status).toBe(200);
    expect((await api('PUT', `/api/users/${crew2Id}`, { cookie: fm, body: { name: 'Crew Two', role: 'base_supervisor', baseIds: ['b-hq'] } })).status).toBe(200);
    expect((await api('PUT', `/api/users/${crewId}`, { cookie: fm, body: { name: 'x', role: 'fleet_manager' } })).status).toBe(403);
  });
  it('system admin has no backups by default and cannot grant themselves anything', async () => {
    const me = (await api('GET', '/api/auth/me', { cookie: admin })).json.user.perms;
    expect(me).toMatchObject({ users: true, setup: true, backups: false });
  });
});

describe('saving several roles at once (the single Save changes button)', () => {
  const putAll = (cookie: string, roles: any) => api('PUT', '/api/roles/permissions', { cookie, body: { roles } });
  it('saves every listed role in one go, leaves the others alone, and writes one audit row per changed role', async () => {
    await putRole(su, 'viewer', { move: true });
    const before = (await row("SELECT COUNT(*) n FROM audit_log WHERE action IN ('role.permissions','role.reset')")).n;
    const r = await putAll(su, { crew: { report: false }, mechanic: { status: true, report: true } });
    expect(r.status).toBe(200);
    expect(r.json.saved.sort()).toEqual(['crew', 'mechanic']);
    expect((await stored()).rolePerms).toEqual({ crew: { report: false }, mechanic: { status: true }, viewer: { move: true } });
    expect((await syncAll(crew)).me.perms.report).toBe(false);
    expect((await syncAll(mech)).me.perms.status).toBe(true);
    const log = await rows("SELECT action, entity_id FROM audit_log WHERE action IN ('role.permissions','role.reset') ORDER BY id DESC LIMIT 2");
    expect((await row("SELECT COUNT(*) n FROM audit_log WHERE action IN ('role.permissions','role.reset')")).n).toBe(before + 2);
    expect(log.map((x: any) => x.entity_id).sort()).toEqual(['crew', 'mechanic']);
  });
  it('an empty role means back to the built-in defaults, recorded as a reset', async () => {
    await putRole(su, 'crew', { report: false });
    expect((await putAll(su, { crew: {} })).status).toBe(200);
    expect((await stored()).rolePerms ?? {}).toEqual({});
    expect((await row("SELECT action FROM audit_log WHERE entity_id = 'crew' ORDER BY id DESC LIMIT 1")).action).toBe('role.reset');
  });
  it('is all or nothing: one role the editor may not change stops the whole save', async () => {
    expect((await putAll(admin, { crew: { report: false }, system_admin: { report: false } })).status).toBe(403);
    expect((await putAll(admin, { crew: { report: false }, viewer: { users: true } })).status).toBe(403);
    expect((await putAll(su, { crew: { report: false }, viewer: { backups: true } })).status).toBe(400);
    expect((await putAll(su, { crew: { report: false }, nobody: {} })).status).toBe(404);
    expect((await stored()).rolePerms ?? {}).toEqual({});
    expect((await syncAll(crew)).me.perms.report).toBe(true);
  });
  it('fleet managers and below cannot use it; an empty save is refused; an unchanged role writes nothing', async () => {
    expect((await putAll(fm, { crew: { report: false } })).status).toBe(403);
    expect((await putAll(crew, { crew: { report: false } })).status).toBe(403);
    expect((await putAll(su, {})).status).toBe(400);
    const n = (await row('SELECT COUNT(*) n FROM audit_log')).n;
    expect((await putAll(su, { crew: {} })).json.saved).toEqual([]);
    expect((await row('SELECT COUNT(*) n FROM audit_log')).n).toBe(n);
  });
});
