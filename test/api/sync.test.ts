import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, syncAll, byId, row, setUploads } from './helpers';

let fm: string;
beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager')).cookie;
});

describe('sync cursor', () => {
  it('the first call returns everything; the next with the cursor returns nothing when nothing changed', async () => {
    const a = await syncAll(fm);
    expect(a.full).toBe(true);
    expect(Object.keys(a.data).sort()).toEqual(['bases', 'busCheckLists', 'issues', 'mechanics', 'meterReadings', 'moves', 'people', 'parts', 'pmPrograms', 'settings', 'statusEvents', 'vehicles', 'workOrders'].sort());
    expect(a.cursor).toBeGreaterThan(0);
    const b = await syncAll(fm, a.cursor);
    expect(b).toMatchObject({ full: false, data: {}, deleted: {}, cursor: a.cursor });
  });
  it('returns only the rows that changed', async () => {
    const a = await syncAll(fm);
    await api('POST', '/api/vehicles/v-02/status', { cookie: fm, body: { to: 'oos_repair', reason: 'Leaking' } });
    const b = await syncAll(fm, a.cursor);
    expect(b.cursor).toBeGreaterThan(a.cursor);
    expect(Object.keys(b.data).sort()).toEqual(['statusEvents', 'vehicles']);
    expect(b.data.vehicles).toHaveLength(1);
    expect(b.data.vehicles[0]).toMatchObject({ id: 'v-02', status: 'oos_repair' });
    expect(b.data.statusEvents).toHaveLength(1);
    // and nothing more on the next poll
    expect((await syncAll(fm, b.cursor)).data).toEqual({});
  });
  it('a work order change refreshes the work order with its lines and links, plus the side-effect rows', async () => {
    const a = await syncAll(fm);
    await api('POST', '/api/work-orders/wo-15/transition', { cookie: fm, body: { action: 'approve' } });
    const b = await syncAll(fm, a.cursor);
    expect(Object.keys(b.data)).toEqual(['workOrders']);
    expect(b.data.workOrders[0]).toMatchObject({ id: 'wo-15', status: 'approved', issueIds: ['i-03'] });
    expect(b.data.workOrders[0].lines.length).toBe(2);
  });
  it('a vehicle PM reset comes through on the vehicle document', async () => {
    const a = await syncAll(fm);
    const v0 = byId(a.data.vehicles, 'v-12');
    const r = await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-12', type: 'preventive', pmTaskIds: ['t-oil'] } });
    await api('POST', `/api/work-orders/${r.json.id}/transition`, { cookie: fm, body: { action: 'schedule', date: '2030-01-01' } });
    await api('POST', `/api/work-orders/${r.json.id}/transition`, { cookie: fm, body: { action: 'start' } });
    await api('POST', `/api/work-orders/${r.json.id}/transition`, { cookie: fm, body: { action: 'complete', hours: v0.engineHours + 3 } });
    const b = await syncAll(fm, a.cursor);
    expect(byId(b.data.vehicles, 'v-12').pm['t-oil'].lastHours).toBe(v0.engineHours + 3);
  });
  it('deletes propagate as tombstones', async () => {
    const a = await syncAll(fm);
    const r = await api('POST', '/api/admin/sample/remove', { cookie: fm });
    expect(r.status).toBe(200);
    expect(r.json.removed).toBeGreaterThan(100);
    const b = await syncAll(fm, a.cursor);
    expect(b.deleted.vehicles).toHaveLength(20);
    expect(b.deleted.workOrders).toHaveLength(15);
    expect(b.deleted.bases).toHaveLength(5);
    expect(b.deleted.vehicles).toContain('v-01');
    const full = await syncAll(fm);
    expect(full.data.vehicles).toEqual([]);
    expect((await row('SELECT COUNT(*) n FROM work_order_lines')).n).toBe(0); // children gone with their parent
    expect((await row('SELECT COUNT(*) n FROM vehicle_pm')).n).toBe(0);
  });
  it('sample removal keeps real records and removes things that hang off sample units', async () => {
    await api('POST', '/api/bases', { cookie: fm, body: { name: 'Real base', minUnits: 1 } });
    const v = await api('POST', '/api/vehicles', { cookie: fm, body: { unit: 'REAL-1', make: 'a', model: 'b', baseId: (await row("SELECT id FROM bases WHERE name = 'Real base'")).id } });
    await api('POST', '/api/issues', { cookie: fm, body: { vehicleId: 'v-01', title: 'user issue on sample unit', severity: 'minor' } });
    await api('POST', '/api/admin/sample/remove', { cookie: fm });
    const s = await syncAll(fm);
    expect(s.data.vehicles.map((x: any) => x.id)).toEqual([v.json.id]);
    expect(s.data.bases).toHaveLength(1);
    expect(s.data.issues).toHaveLength(0);
    expect(s.data.settings).toHaveLength(0);
  });
  it('a browser whose cursor is ahead of the database (after a restore) gets everything again', async () => {
    const a = await syncAll(fm);
    const b = await syncAll(fm, a.cursor + 1000);
    expect(b.full).toBe(true);
    expect(b.data.vehicles.length).toBe(20);
  });
  it('new people appear for name lookups', async () => {
    const a = await syncAll(fm);
    const c = await api('POST', '/api/users', { cookie: fm, body: { email: 'new@x.gy', name: 'Nia New', role: 'crew', password: 'nia-start-pass-1' } });
    const b = await syncAll(fm, a.cursor);
    expect(b.data.people).toEqual([{ id: c.json.id, name: 'Nia New', active: true }]);
  });
});

describe('mechanic scoping in sync and downloads', () => {
  it('a mechanic receives only work orders assigned to them, and loses one that is reassigned', async () => {
    const mech = (await as('mechanic', { mechanicId: 'm-1' })).cookie;
    const a = await syncAll(mech);
    expect(a.data.workOrders.length).toBeGreaterThan(0);
    expect(a.data.workOrders.every((w: any) => w.mechanicId === 'm-1')).toBe(true);
    expect(byId(a.data.workOrders, 'wo-14')).toBeTruthy();
    const r = await api('PATCH', '/api/work-orders/wo-14', { cookie: fm, body: { mechanicId: 'm-2' } });
    expect(r.status).toBe(200);
    const b = await syncAll(mech, a.cursor);
    expect(b.deleted.workOrders).toContain('wo-14');
    expect(b.data.workOrders ?? []).toHaveLength(0);
    // the fleet manager still sees it, now assigned to m-2
    expect(byId((await syncAll(fm)).data.workOrders, 'wo-14').mechanicId).toBe('m-2');
  });
  it('a mechanic cannot download files on another mechanic\'s work order', async () => {
    const own = (await as('mechanic', { mechanicId: 'm-1' })).cookie;
    const other = (await as('mechanic', { mechanicId: 'm-2' })).cookie;
    await setUploads(fm, true);
    const fd = new FormData();
    fd.set('entity_type', 'work_order'); fd.set('entity_id', 'wo-14');
    fd.set('file', new File([new TextEncoder().encode('%PDF-1.4\n%%EOF')], 'q.pdf', { type: 'application/pdf' }));
    const up = await api('POST', '/api/attachments', { cookie: own, form: fd });
    expect(up.status).toBe(200);
    expect((await api('GET', `/api/attachments/${up.json.id}/file`, { cookie: own })).status).toBe(200);
    expect((await api('GET', `/api/attachments/${up.json.id}/file`, { cookie: other })).status).toBe(404);
    expect((await api('GET', `/api/attachments/${up.json.id}/file`, { cookie: fm })).status).toBe(200);
  });
});
