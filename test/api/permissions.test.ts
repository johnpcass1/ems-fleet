import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, makeUser, seedDemo, syncAll, rows, row, E } from './helpers';

/** Calls an endpoint as every role and checks who gets through (anything but 401/403) and who is refused (403). */
type Who = 'system_admin' | 'fleet_manager' | 'sup_hq' | 'sup_lethem' | 'mechanic' | 'crew_any' | 'crew_hq' | 'crew_lethem' | 'viewer' | 'dispatcher';
const ALL: Who[] = ['system_admin', 'fleet_manager', 'sup_hq', 'sup_lethem', 'mechanic', 'crew_any', 'crew_hq', 'crew_lethem', 'viewer', 'dispatcher'];

let cookies: Record<Who, string>;
beforeEach(async () => {
  await seedDemo();
  const mk = async (role: string, o: any = {}) => (await as(role, o)).cookie;
  cookies = {
    system_admin: await mk('system_admin'), fleet_manager: await mk('fleet_manager'),
    sup_hq: await mk('base_supervisor', { baseIds: ['b-hq'] }), sup_lethem: await mk('base_supervisor', { baseIds: ['b-lethem'] }),
    mechanic: await mk('mechanic', { mechanicId: 'm-1' }), crew_any: await mk('crew'), crew_hq: await mk('crew', { baseIds: ['b-hq'] }), crew_lethem: await mk('crew', { baseIds: ['b-lethem'] }),
    viewer: await mk('viewer'), dispatcher: await mk('dispatcher'),
  };
});

async function matrix(method: string, path: string, body: any, allowed: Who[]) {
  for (const who of ALL) {
    const r = await api(method, path, { cookie: cookies[who], body });
    const ok = r.status !== 403 && r.status !== 401;
    expect(ok, `${who} ${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`).toBe(allowed.includes(who));
  }
}
const FM: Who[] = ['system_admin', 'fleet_manager'];

describe('role matrix (403 for everyone not allowed)', () => {
  it('change a unit status: managers and supervisors of that unit\'s base', () =>
    matrix('POST', '/api/vehicles/v-02/status', { to: 'limited', reason: 'test' }, [...FM, 'sup_hq']));
  it('log a meter reading: managers, supervisor of base, mechanics, crew of base', () =>
    matrix('POST', '/api/vehicles/v-02/readings', { hours: 5 }, [...FM, 'sup_hq', 'mechanic', 'crew_any', 'crew_hq']));
  it('report a problem: same people as readings', () =>
    matrix('POST', '/api/issues', { vehicleId: 'v-02', title: 'x', severity: 'minor' }, [...FM, 'sup_hq', 'mechanic', 'crew_any', 'crew_hq']));
  it('create a work order: managers and the base supervisor only', () =>
    matrix('POST', '/api/work-orders', { vehicleId: 'v-02', type: 'inspection' }, [...FM, 'sup_hq']));
  it('move units: managers and supervisor of the source base', () =>
    matrix('POST', '/api/moves', { vehicleIds: ['v-02'], toBaseId: 'b-hq' }, [...FM, 'sup_hq']));
  it('edit parts: managers and supervisors', () =>
    matrix('POST', '/api/parts', { number: 'P-X', description: 'x' }, [...FM, 'sup_hq', 'sup_lethem']));
  it('edit mechanics: managers and supervisors', () =>
    matrix('POST', '/api/mechanics', { name: 'x' }, [...FM, 'sup_hq', 'sup_lethem']));
  it('setup (bases, programs, settings, vehicles): managers only', async () => {
    await matrix('POST', '/api/bases', { name: 'Z' }, FM);
    await matrix('PUT', '/api/settings', { approvalThresholdGYD: 150000, dueSoonHours: 25, dueSoonDays: 14, comebackDays: 30 }, FM);
    await matrix('POST', '/api/vehicles', { unit: 'GEMA-90', make: 'a', model: 'b', baseId: 'b-hq' }, FM);
    await matrix('POST', '/api/pm-programs', { name: 'p', tasks: [{ name: 't', intervalHours: 10 }] }, FM);
  });
  it('remove sample data: managers only', async () => {
    for (const who of ALL.filter((w) => !FM.includes(w))) expect((await api('POST', '/api/admin/sample/remove', { cookie: cookies[who] })).status, who).toBe(403);
  });
  it('users screen: managers and system admin; backups: nobody in this matrix (super user only); audit log: system admin', async () => {
    await matrix('GET', '/api/users', undefined, FM);
    await matrix('GET', '/api/admin/backups', undefined, []);
    await matrix('GET', '/api/admin/audit', undefined, ['system_admin']);
    await matrix('PUT', '/api/roles/crew/permissions', { overrides: {} }, ['system_admin']);
    await matrix('POST', '/api/roles/crew/reset', undefined, ['system_admin']);
  });
  it('everyone logged in can sync (the dispatcher gets a reduced copy)', () => matrix('GET', '/api/sync', undefined, ALL));
});

describe('base scoping for supervisors and crew', () => {
  it('a supervisor cannot touch units at another base', async () => {
    // v-19 is at Lethem
    for (const [m, p, b] of [
      ['POST', '/api/vehicles/v-19/status', { to: 'limited', reason: 'x' }],
      ['POST', '/api/vehicles/v-19/readings', { hours: 10 }],
      ['POST', '/api/work-orders', { vehicleId: 'v-19', type: 'inspection' }],
      ['POST', '/api/moves', { vehicleIds: ['v-19'], toBaseId: 'b-hq' }],
    ] as const) {
      expect((await api(m, p, { cookie: cookies.sup_hq, body: b })).status, p).toBe(403);
      expect((await api(m, p, { cookie: cookies.sup_lethem, body: b })).status, p).not.toBe(403);
    }
  });
  it('a supervisor may move a unit out of their own base to any base, but not in from elsewhere', async () => {
    const r = await api('POST', '/api/moves', { cookie: cookies.sup_hq, body: { vehicleIds: ['v-02'], toBaseId: 'b-lethem' } });
    expect(r.status).toBe(200);
    expect((await row('SELECT base_id FROM vehicles WHERE id = ?', 'v-02')).base_id).toBe('b-lethem');
    expect((await api('POST', '/api/moves', { cookie: cookies.sup_hq, body: { vehicleIds: ['v-02'], toBaseId: 'b-hq' } })).status).toBe(403);
  });
  it('a supervisor with no bases cannot write anything on units', async () => {
    const { cookie } = await as('base_supervisor', { baseIds: [] });
    expect((await api('POST', '/api/vehicles/v-02/status', { cookie, body: { to: 'limited', reason: 'x' } })).status).toBe(403);
  });
  it('crew with no bases act on every unit; crew with bases only on theirs', async () => {
    expect((await api('POST', '/api/issues', { cookie: cookies.crew_any, body: { vehicleId: 'v-19', title: 'x', severity: 'minor' } })).status).toBe(200);
    expect((await api('POST', '/api/issues', { cookie: cookies.crew_hq, body: { vehicleId: 'v-19', title: 'x', severity: 'minor' } })).status).toBe(403);
    expect((await api('POST', '/api/vehicles/v-19/readings', { cookie: cookies.crew_hq, body: { hours: 1 } })).status).toBe(403);
  });
  it('crew cannot change status, create work orders or accept flagged readings', async () => {
    expect((await api('POST', '/api/readings/mr-flag/accept', { cookie: cookies.crew_any })).status).toBe(403);
    expect((await api('POST', '/api/issues/i-04/dismiss', { cookie: cookies.crew_any })).status).toBe(403);
  });
});

describe('mechanic scoping on work orders', () => {
  it('a mechanic can work only on work orders assigned to them', async () => {
    // wo-14 (scheduled) is assigned to m-1, wo-12 (in progress) to m-2
    const mech = cookies.mechanic; // linked to m-1
    const own = await api('POST', '/api/work-orders/wo-14/transition', { cookie: mech, body: { action: 'start' } });
    expect(own.status).toBe(200);
    const other = await api('POST', '/api/work-orders/wo-12/transition', { cookie: mech, body: { action: 'hold', reason: 'parts' } });
    expect(other.status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-12/lines', { cookie: mech, body: { kind: 'labor', description: 'x', qty: 1, unitCost: 100 } })).status).toBe(403);
    expect((await api('PATCH', '/api/work-orders/wo-12', { cookie: mech, body: { notes: 'hi' } })).status).toBe(403);
    expect((await api('PATCH', '/api/work-orders/wo-14', { cookie: mech, body: { notes: 'mine' } })).status).toBe(200);
  });
  it('a mechanic cannot reassign, reprioritise, approve, schedule, close or cancel', async () => {
    const mech = cookies.mechanic;
    expect((await api('PATCH', '/api/work-orders/wo-14', { cookie: mech, body: { priority: 'urgent' } })).status).toBe(403);
    expect((await api('PATCH', '/api/work-orders/wo-14', { cookie: mech, body: { mechanicId: 'm-2' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-15/transition', { cookie: mech, body: { action: 'approve' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-13/transition', { cookie: mech, body: { action: 'schedule', date: '2030-01-01' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-05/transition', { cookie: mech, body: { action: 'close' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-14/transition', { cookie: mech, body: { action: 'cancel' } })).status).toBe(403);
  });
  it('a mechanic with no mechanic link cannot work on any work order', async () => {
    const { cookie } = await as('mechanic', { mechanicId: null });
    expect((await api('POST', '/api/work-orders/wo-14/transition', { cookie, body: { action: 'start' } })).status).toBe(403);
  });
  it('a supervisor can only act on work orders for units at their base', async () => {
    // wo-14 is on v-03 (HQ)
    expect((await api('POST', '/api/work-orders/wo-14/transition', { cookie: cookies.sup_lethem, body: { action: 'start' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-14/transition', { cookie: cookies.sup_hq, body: { action: 'start' } })).status).toBe(200);
  });
  it('only managers approve', async () => {
    expect((await api('POST', '/api/work-orders/wo-15/transition', { cookie: cookies.sup_hq, body: { action: 'approve' } })).status).toBe(403);
    expect((await api('POST', '/api/work-orders/wo-15/transition', { cookie: cookies.fleet_manager, body: { action: 'approve' } })).status).toBe(200);
  });
});

describe('dispatcher sees a reduced, read-only copy', () => {
  it('has no costs, notes, parts, file lists or problem descriptions', async () => {
    const s = await syncAll(cookies.dispatcher);
    expect(s.data.parts).toBeUndefined();
    expect(s.data.vehicles.length).toBe(20);
    const wo = s.data.workOrders.find((w: any) => w.id === 'wo-09');
    expect(wo.lines).toEqual([]);
    expect(wo.notes).toBe('');
    expect(wo.number).toBe('WO-0009');
    expect(s.data.issues[0].description).toBe('');
    expect(Object.keys(s.data.settings[0])).not.toContain('approvalThresholdGYD');
    const full = await syncAll(cookies.fleet_manager);
    expect(full.data.parts.length).toBe(15);
    expect(full.data.workOrders.find((w: any) => w.id === 'wo-09').lines.length).toBe(3);
  });
  it('sync shows names only for people (no emails, roles or hashes)', async () => {
    const s = await syncAll(cookies.viewer);
    expect(Object.keys(s.data.people[0]).sort()).toEqual(['active', 'id', 'name']);
    expect(JSON.stringify(s)).not.toContain('pbkdf2');
  });
  it('viewers cannot write anything', async () => {
    for (const [m, p, b] of [['POST', '/api/issues', { vehicleId: 'v-02', title: 'x', severity: 'minor' }], ['POST', '/api/vehicles/v-02/status', { to: 'limited', reason: 'x' }]] as const)
      expect((await api(m, p, { cookie: cookies.viewer, body: b })).status).toBe(403);
    expect((await row('SELECT COUNT(*) n FROM issues WHERE title = ?', 'x')).n).toBe(0);
  });
});
void makeUser; void rows; void E;
