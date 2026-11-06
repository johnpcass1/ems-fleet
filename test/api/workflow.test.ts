import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, syncAll, row, rows, byId, E } from './helpers';

let fm: string, sup: string, mech: string, crew: string;
beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager')).cookie;
  sup = (await as('base_supervisor', { baseIds: ['b-hq'] })).cookie;
  mech = (await as('mechanic', { mechanicId: 'm-1' })).cookie;
  crew = (await as('crew')).cookie;
});
const T = (cookie: string, id: string, body: any) => api('POST', `/api/work-orders/${id}/transition`, { cookie, body });
const veh = (id: string) => row('SELECT * FROM vehicles WHERE id = ?', id);
const wo = async (id: string) => byId((await syncAll(fm)).data.workOrders, id);

describe('issues', () => {
  it('a critical problem takes an available unit out of service and writes a status event', async () => {
    const r = await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: 'Brakes failing', severity: 'critical', description: 'no pedal' } });
    expect(r.status).toBe(200);
    const v = await veh('v-02');
    expect(v.status).toBe('oos_repair');
    expect(v.status_reason).toBe('Critical problem: Brakes failing');
    const ev = await row("SELECT * FROM status_events WHERE vehicle_id = 'v-02' AND to_status = 'oos_repair' AND reason LIKE '%Brakes failing%'");
    expect(ev.from_status).toBe('in_service');
    const is = await row('SELECT * FROM issues WHERE id = ?', r.json.id);
    expect(is).toMatchObject({ status: 'open', severity: 'critical', vehicle_id: 'v-02' });
  });
  it('a critical problem on a unit already out of service does not add a second event', async () => {
    const before = (await row("SELECT COUNT(*) n FROM status_events WHERE vehicle_id = 'v-12'")).n;
    await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-12', title: 'Another', severity: 'critical' } });
    expect((await row("SELECT COUNT(*) n FROM status_events WHERE vehicle_id = 'v-12'")).n).toBe(before);
  });
  it('major and minor problems leave the status alone', async () => {
    await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: 'Rattle', severity: 'major' } });
    expect((await veh('v-02')).status).toBe('in_service');
  });
  it('validates input', async () => {
    expect((await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: '', severity: 'major' } })).status).toBe(400);
    expect((await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: 'x', severity: 'huge' } })).status).toBe(400);
    expect((await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'nope', title: 'x', severity: 'minor' } })).status).toBe(404);
  });
  it('hours typed with a report are logged as an inspection reading', async () => {
    const h = (await veh('v-02')).engine_hours;
    await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: 'x', severity: 'minor', hours: h + 2 } });
    expect((await veh('v-02')).engine_hours).toBe(h + 2);
    expect((await row("SELECT source FROM meter_readings WHERE vehicle_id = 'v-02' ORDER BY created_at DESC LIMIT 1")).source).toBe('inspection');
  });
  it('a supervisor can dismiss an open problem once', async () => {
    expect((await api('POST', '/api/issues/i-04/dismiss', { cookie: sup })).status).toBe(200);
    expect((await row("SELECT status FROM issues WHERE id = 'i-04'")).status).toBe('dismissed');
    expect((await api('POST', '/api/issues/i-04/dismiss', { cookie: sup })).status).toBe(409);
  });
  it('calls the no-op email hook only through waitUntil (nothing is sent)', async () => {
    const r = await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-02', title: 'x', severity: 'minor' } });
    expect(r.status).toBe(200);
  });
});

describe('meter readings', () => {
  it('a normal reading updates the unit and logs a reading', async () => {
    const v0 = await veh('v-02');
    const r = await api('POST', '/api/vehicles/v-02/readings', { cookie: crew, body: { hours: v0.engine_hours + 3, km: v0.odometer_km + 50 } });
    expect(r.json).toMatchObject({ ok: true, flagged: false });
    const v1 = await veh('v-02');
    expect(v1.engine_hours).toBe(v0.engine_hours + 3);
    expect(v1.odometer_km).toBe(v0.odometer_km + 50);
  });
  it('a reading lower than the current one is flagged and does not change the unit', async () => {
    const v0 = await veh('v-02');
    const r = await api('POST', '/api/vehicles/v-02/readings', { cookie: crew, body: { hours: v0.engine_hours - 10 } });
    expect(r.json.flagged).toBe(true);
    expect(r.json.warnings[0]).toMatch(/Lower/);
    expect((await veh('v-02')).engine_hours).toBe(v0.engine_hours);
    expect((await row("SELECT flagged FROM meter_readings WHERE vehicle_id = 'v-02' ORDER BY created_at DESC LIMIT 1")).flagged).toBe(1);
  });
  it('more than 24 hours of running a day is flagged', async () => {
    const v0 = await veh('v-02');
    const r = await api('POST', '/api/vehicles/v-02/readings', { cookie: crew, body: { hours: v0.engine_hours + 400 } });
    expect(r.json.flagged).toBe(true);
    expect(r.json.warnings[0]).toMatch(/24 hours/);
  });
  it('crew cannot force a flagged reading through; a supervisor can confirm it', async () => {
    const v0 = await veh('v-02');
    const c = await api('POST', '/api/vehicles/v-02/readings', { cookie: crew, body: { hours: v0.engine_hours + 400, accept: true } });
    expect(c.json.flagged).toBe(true);
    const s = await api('POST', '/api/vehicles/v-02/readings', { cookie: sup, body: { hours: v0.engine_hours + 400, accept: true } });
    expect(s.json.flagged).toBe(false);
    expect((await veh('v-02')).engine_hours).toBe(v0.engine_hours + 400);
  });
  it('a supervisor can accept an existing flagged reading, and it then updates the unit', async () => {
    const f = await row("SELECT * FROM meter_readings WHERE id = 'mr-flag'"); // flagged, on v-09 (Diamond)
    expect((await api('POST', '/api/readings/mr-flag/accept', { cookie: sup })).status).toBe(403); // supervisor of HQ only
    const boss = await api('POST', '/api/readings/mr-flag/accept', { cookie: fm });
    expect(boss.status).toBe(200);
    expect((await row("SELECT flagged FROM meter_readings WHERE id = 'mr-flag'")).flagged).toBe(0);
    expect((await veh('v-09')).engine_hours).toBe(f.hours);
    expect((await api('POST', '/api/readings/mr-flag/accept', { cookie: fm })).status).toBe(409);
  });
});

describe('status changes', () => {
  it('records an event and the new status; reason is needed to take a unit out', async () => {
    expect((await api('POST', '/api/vehicles/v-02/status', { cookie: sup, body: { to: 'oos_repair' } })).status).toBe(400);
    const r = await api('POST', '/api/vehicles/v-02/status', { cookie: sup, body: { to: 'oos_repair', reason: 'Leaking', expectedReturn: '2030-01-01' } });
    expect(r.status).toBe(200);
    expect(await veh('v-02')).toMatchObject({ status: 'oos_repair', status_reason: 'Leaking', expected_return: '2030-01-01' });
    const back = await api('POST', '/api/vehicles/v-02/status', { cookie: sup, body: { to: 'in_service' } });
    expect(back.status).toBe(200);
    expect(await veh('v-02')).toMatchObject({ status: 'in_service', status_reason: '', expected_return: null });
    expect((await row("SELECT COUNT(*) n FROM status_events WHERE vehicle_id = 'v-02' AND reason IN ('Leaking','')")).n).toBeGreaterThanOrEqual(2);
    expect((await api('POST', '/api/vehicles/v-02/status', { cookie: sup, body: { to: 'in_service' } })).status).toBe(400);
  });
});

describe('work order lifecycle: create, approve, schedule, start, hold, resume, complete, close', () => {
  it('runs the whole path with all the side effects', async () => {
    // v-03: engine oil overdue by 30 h (demo data). A PM work order for it.
    const v0 = await veh('v-03');
    const stock0 = (await row("SELECT on_hand FROM parts WHERE id = 'p-oilf'")).on_hand;
    const created = await api('POST', '/api/work-orders', { cookie: sup, body: { vehicleId: 'v-03', type: 'preventive', pmTaskIds: ['t-oil'], mechanicId: 'm-1' } });
    expect(created.status).toBe(200);
    expect(created.json.number).toBe('WO-0016');
    const id = created.json.id;
    expect((await wo(id)).overdueAtOpen).toBe(1);
    expect((await wo(id)).hoursAtOpen).toBe(v0.engine_hours);

    // lines: a part and expensive labour -> over the G$150,000 threshold -> needs approval
    expect((await api('POST', `/api/work-orders/${id}/lines`, { cookie: sup, body: { kind: 'part', description: 'Engine oil filter', repairCode: 'Engine', qty: 1, unitCost: 4500, partId: 'p-oilf' } })).status).toBe(200);
    expect((await wo(id)).approvalNeeded).toBe(false);
    expect((await api('POST', `/api/work-orders/${id}/lines`, { cookie: sup, body: { kind: 'labor', description: 'Labour', repairCode: 'Engine', qty: 30, unitCost: 6000 } })).status).toBe(200);
    expect((await wo(id)).approvalNeeded).toBe(true);

    // cannot schedule before approval; supervisor cannot approve
    const early = await T(sup, id, { action: 'schedule', date: '2030-01-02' });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('needs_approval');
    expect((await T(sup, id, { action: 'approve' })).status).toBe(403);
    expect((await T(fm, id, { action: 'approve' })).status).toBe(200);
    expect((await wo(id)).status).toBe('approved');
    expect((await row('SELECT approved_by FROM work_orders WHERE id = ?', id)).approved_by).toBeTruthy();

    expect((await T(sup, id, { action: 'schedule' })).status).toBe(400); // date missing
    expect((await T(sup, id, { action: 'schedule', date: '2030-01-02' })).status).toBe(200);

    // start: the unit goes out of service for scheduled service (preventive)
    expect((await T(mech, id, { action: 'start', expectedReturn: '2030-01-03' })).status).toBe(200);
    expect(await veh('v-03')).toMatchObject({ status: 'oos_pm', expected_return: '2030-01-03' });
    expect((await row("SELECT reason FROM status_events WHERE wo_id = ? AND to_status = 'oos_pm'", id)).reason).toBe('WO-0016: work started');

    // hold for parts -> unit shows waiting for parts; hold reason is required
    expect((await T(mech, id, { action: 'hold' })).status).toBe(400);
    expect((await T(mech, id, { action: 'hold', reason: 'parts' })).status).toBe(200);
    expect((await veh('v-03')).status).toBe('oos_parts');
    expect((await wo(id)).holdLog).toHaveLength(1);
    expect((await wo(id)).holdLog[0]).toMatchObject({ reason: 'parts', to: null });
    // cannot complete while on hold
    expect((await T(mech, id, { action: 'complete', hours: v0.engine_hours + 5 })).status).toBe(409);
    // resume
    expect((await T(mech, id, { action: 'resume' })).status).toBe(200);
    expect((await veh('v-03')).status).toBe('oos_pm');
    expect((await wo(id)).holdLog[0].to).toBeTruthy();

    // completion requirements
    expect((await T(mech, id, { action: 'complete' })).status).toBe(400);
    const low = await T(mech, id, { action: 'complete', hours: v0.engine_hours - 1 });
    expect(low.status).toBe(400);
    expect(low.json.error).toMatch(/cannot be lower/);
    expect((await T(mech, id, { action: 'complete', hours: v0.engine_hours + 6, km: v0.odometer_km - 1 })).status).toBe(400);
    const hrs = v0.engine_hours + 6, km = v0.odometer_km + 150;
    const done = await T(mech, id, { action: 'complete', hours: hrs, km });
    expect(done.status).toBe(200);

    // side effects
    const v1 = await veh('v-03');
    expect(v1).toMatchObject({ status: 'in_service', engine_hours: hrs, odometer_km: km });
    expect((await row("SELECT reason FROM status_events WHERE wo_id = ? AND to_status = 'in_service'", id)).reason).toBe('WO-0016 completed');
    const pm = await row("SELECT * FROM vehicle_pm WHERE vehicle_id = 'v-03' AND task_id = 't-oil'");
    expect(pm).toMatchObject({ last_hours: hrs, last_km: km });
    expect(pm.last_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await row("SELECT on_hand FROM parts WHERE id = 'p-oilf'")).on_hand).toBe(stock0 - 1);
    const mr = await row("SELECT * FROM meter_readings WHERE vehicle_id = 'v-03' AND source = 'work_order' ORDER BY created_at DESC LIMIT 1");
    expect(mr).toMatchObject({ hours: hrs, km, flagged: 0 });
    const w = await wo(id);
    expect(w).toMatchObject({ status: 'completed', hoursAtComplete: hrs, kmAtComplete: km });

    // close locks the lines
    expect((await T(mech, id, { action: 'close' })).status).toBe(403);
    expect((await T(sup, id, { action: 'close' })).status).toBe(200);
    expect((await wo(id)).status).toBe('closed');
    expect((await api('POST', `/api/work-orders/${id}/lines`, { cookie: sup, body: { kind: 'labor', description: 'late', qty: 1, unitCost: 1 } })).status).toBe(409);
    expect((await api('DELETE', `/api/work-orders/${id}/lines/${(await wo(id)).lines[0].id}`, { cookie: sup })).status).toBe(409);
    expect((await T(fm, id, { action: 'cancel' })).status).toBe(409);
  });

  it('completing a corrective job resolves its problems; stock never goes below zero', async () => {
    // wo-09: transmission repair on v-12 (critical issue i-01, 12 litres of fluid, only 4 in stock)
    const v0 = await veh('v-12');
    expect(v0.status).toBe('oos_repair');
    const r = await T(fm, 'wo-09', { action: 'complete', hours: v0.engine_hours + 1 });
    expect(r.status).toBe(200);
    expect((await row("SELECT status FROM issues WHERE id = 'i-01'")).status).toBe('resolved');
    expect((await row("SELECT on_hand FROM parts WHERE id = 'p-atf'")).on_hand).toBe(0);
    expect((await veh('v-12')).status).toBe('in_service');
  });

  it('does not return the unit to service while another job on it is still going', async () => {
    const created = await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-14', type: 'corrective', mechanicId: 'm-2' } });
    const id = created.json.id;
    await T(fm, id, { action: 'schedule', date: '2030-02-02' });
    await T(fm, id, { action: 'start' }); // v-14 is already oos_pm (wo-12 running)
    const v0 = await veh('v-14');
    expect((await T(fm, 'wo-12', { action: 'complete', hours: v0.engine_hours + 1 })).status).toBe(200);
    expect((await veh('v-14')).status).toBe('oos_pm');
    expect((await T(fm, id, { action: 'complete', hours: v0.engine_hours + 2 })).status).toBe(200);
    expect((await veh('v-14')).status).toBe('in_service');
  });

  it('starting work on an available unit takes it out for repair (corrective)', async () => {
    const r = await T(sup, 'wo-14', { action: 'start' }); // preventive on v-03
    expect(r.status).toBe(200);
    expect((await veh('v-03')).status).toBe('oos_pm');
    const c = await api('POST', '/api/work-orders', { cookie: sup, body: { vehicleId: 'v-02', type: 'corrective' } });
    await T(sup, c.json.id, { action: 'schedule', date: '2030-03-03' });
    await T(sup, c.json.id, { action: 'start' });
    expect((await veh('v-02')).status).toBe('oos_repair');
  });

  it('wrong-state transitions are refused with 409', async () => {
    expect((await T(fm, 'wo-11', { action: 'start' })).status).toBe(409); // open, not scheduled
    expect((await T(fm, 'wo-11', { action: 'resume' })).status).toBe(409);
    expect((await T(fm, 'wo-01', { action: 'close' })).status).toBe(409); // already closed
    expect((await T(fm, 'wo-11', { action: 'approve' })).status).toBe(400); // no approval needed
    expect((await T(fm, 'wo-11', { action: 'bogus' })).status).toBe(400);
  });

  it('cancelling reopens linked problems but leaves the unit status alone', async () => {
    const st = (await veh('v-09')).status;
    expect((await T(fm, 'wo-13', { action: 'cancel' })).status).toBe(200); // linked to i-05
    expect(await row("SELECT status, wo_id FROM issues WHERE id = 'i-05'")).toMatchObject({ status: 'open', wo_id: null });
    expect((await wo('wo-13')).status).toBe('cancelled');
    expect((await veh('v-09')).status).toBe(st);
    expect((await T(fm, 'wo-13', { action: 'cancel' })).status).toBe(409);
  });

  it('creating a work order from problems links them; a problem can only be in one work order', async () => {
    const r = await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-11', type: 'corrective', issueIds: ['i-06'] } });
    expect(r.status).toBe(200);
    expect(await row("SELECT status, wo_id FROM issues WHERE id = 'i-06'")).toMatchObject({ status: 'in_work_order', wo_id: r.json.id });
    expect((await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-11', type: 'corrective', issueIds: ['i-06'] } })).status).toBe(409);
    expect((await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-11', type: 'corrective', issueIds: ['i-04'] } })).status).toBe(400); // i-04 is on v-02
    expect((await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-11', type: 'preventive' } })).status).toBe(400);
    expect((await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-11', type: 'preventive', pmTaskIds: ['nope'] } })).status).toBe(400);
  });

  it('a stale second click is refused instead of applied twice', async () => {
    const a = await T(fm, 'wo-14', { action: 'start' });
    const b = await T(fm, 'wo-14', { action: 'start' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
  });
});

describe('moves', () => {
  it('moves several units at once and writes a move row for each', async () => {
    const r = await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01', 'v-02', 'v-03'], toBaseId: 'b-lethem', reason: 'Surge' } });
    expect(r.json).toMatchObject({ ok: true, moved: 3 });
    expect((await rows("SELECT id FROM vehicles WHERE base_id = 'b-lethem' AND id IN ('v-01','v-02','v-03')")).length).toBe(3);
    const m = await rows("SELECT * FROM moves WHERE reason = 'Surge'");
    expect(m).toHaveLength(3);
    expect(m.every((x: any) => x.from_base_id === 'b-hq' && x.to_base_id === 'b-lethem' && !x.temp_until)).toBe(true);
    expect((await row("SELECT home_base_id FROM vehicles WHERE id = 'v-01'")).home_base_id).toBe('b-lethem');
  });
  it('skips units already at the destination', async () => {
    const r = await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01', 'v-19'], toBaseId: 'b-lethem' } });
    expect(r.json.moved).toBe(1);
  });
  it('a temporary loan remembers the home base and the return date', async () => {
    const until = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const r = await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01'], toBaseId: 'b-linden', tempUntil: until } });
    expect(r.status).toBe(200);
    expect(await veh('v-01')).toMatchObject({ base_id: 'b-linden', home_base_id: 'b-hq', temp_until: until, temp_from_base_id: 'b-hq' });
    // moving it on again keeps the original home
    await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01'], toBaseId: 'b-lethem', tempUntil: until } });
    expect(await veh('v-01')).toMatchObject({ base_id: 'b-lethem', home_base_id: 'b-hq', temp_from_base_id: 'b-hq' });
    const doc = byId((await syncAll(fm)).data.vehicles, 'v-01');
    expect(doc).toMatchObject({ tempUntil: until, tempFromBaseId: 'b-hq', baseId: 'b-lethem' });
    // a permanent move afterwards clears the loan
    await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01'], toBaseId: 'b-hq' } });
    expect(await veh('v-01')).toMatchObject({ base_id: 'b-hq', temp_until: null, temp_from_base_id: null });
  });
  it('a temporary move needs a future date; unknown base or unit is refused', async () => {
    expect((await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01'], toBaseId: 'b-linden', tempUntil: '2020-01-01' } })).status).toBe(400);
    expect((await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-01'], toBaseId: 'nope' } })).status).toBe(400);
    expect((await api('POST', '/api/moves', { cookie: fm, body: { vehicleIds: ['v-nope'], toBaseId: 'b-hq' } })).status).toBe(404);
  });
});

describe('parts, vehicles, setup', () => {
  it('receiving stock sets a weighted average cost', async () => {
    // p-oilf: 24 on hand at G$4,500; receive 24 at G$5,500 -> average 5,000
    const r = await api('POST', '/api/parts/p-oilf/receive', { cookie: sup, body: { qty: 24, cost: 5500 } });
    expect(r.json.unitCost).toBe(5000);
    expect(await row("SELECT on_hand, unit_cost FROM parts WHERE id = 'p-oilf'")).toMatchObject({ on_hand: 48, unit_cost: 5000 });
    expect((await api('POST', '/api/parts/p-oilf/receive', { cookie: sup, body: { qty: 0, cost: 1 } })).status).toBe(400);
  });
  it('adds a vehicle with PM records, an opening reading, and refuses duplicate unit names', async () => {
    const body = { unit: 'GEMA-21', make: 'Toyota', model: 'HiAce', year: 2026, baseId: 'b-hq', engineHours: 10, odometerKm: 200, pmProgramId: 'pm-type2', pmStart: 'today' };
    const r = await api('POST', '/api/vehicles', { cookie: fm, body });
    expect(r.status).toBe(200);
    expect((await row('SELECT COUNT(*) n FROM vehicle_pm WHERE vehicle_id = ?', r.json.id)).n).toBe(12);
    expect((await row("SELECT COUNT(*) n FROM meter_readings WHERE vehicle_id = ?", r.json.id)).n).toBe(1);
    expect((await api('POST', '/api/vehicles', { cookie: fm, body: { ...body, unit: 'gema-21' } })).status).toBe(409);
    const never = await api('POST', '/api/vehicles', { cookie: fm, body: { ...body, unit: 'GEMA-22', pmStart: 'never' } });
    expect((await row('SELECT COUNT(*) n FROM vehicle_pm WHERE vehicle_id = ?', never.json.id)).n).toBe(0);
  });
  it('editing a PM program removes PM records of deleted tasks and refreshes the units', async () => {
    const s0 = (await syncAll(fm)).cursor;
    const prog = byId((await syncAll(fm)).data.pmPrograms, 'pm-type2');
    const tasks = prog.tasks.filter((t: any) => t.id !== 't-ac');
    const r = await api('PUT', '/api/pm-programs/pm-type2', { cookie: fm, body: { name: prog.name, appliesTo: prog.appliesTo, tasks: [...tasks, { name: 'New check', group: 'X', intervalDays: 10 }] } });
    expect(r.status).toBe(200);
    expect((await row("SELECT COUNT(*) n FROM vehicle_pm WHERE task_id = 't-ac'")).n).toBe(0);
    const d = (await syncAll(fm, s0)).data;
    expect(d.vehicles.length).toBe(20);
    expect(d.pmPrograms[0].tasks.length).toBe(12);
    expect((await api('PUT', '/api/pm-programs/pm-type2', { cookie: fm, body: { name: 'x', tasks: [{ name: 'no interval' }] } })).status).toBe(400);
  });
  it('saves settings and uses the new approval threshold', async () => {
    expect((await api('PUT', '/api/settings', { cookie: fm, body: { approvalThresholdGYD: 10000, dueSoonHours: 25, dueSoonDays: 14, comebackDays: 30 } })).status).toBe(200);
    const c = await api('POST', '/api/work-orders', { cookie: fm, body: { vehicleId: 'v-02', type: 'corrective' } });
    await api('POST', `/api/work-orders/${c.json.id}/lines`, { cookie: fm, body: { kind: 'labor', description: 'x', qty: 2, unitCost: 6000 } });
    expect((await wo(c.json.id)).approvalNeeded).toBe(true);
  });
});

describe('audit log', () => {
  it('records who did what, with before and after', async () => {
    await api('POST', '/api/vehicles/v-02/status', { cookie: sup, body: { to: 'oos_repair', reason: 'Leaking' } });
    await T(fm, 'wo-15', { action: 'approve' });
    const a = await rows("SELECT * FROM audit_log WHERE action IN ('vehicle.status','wo.approve') ORDER BY id");
    expect(a.map((x: any) => x.action)).toEqual(['vehicle.status', 'wo.approve']);
    expect(a[0].user_email).toMatch(/base_supervisor/);
    expect(JSON.parse(a[0].before_json).status).toBe('in_service');
    expect(JSON.parse(a[0].after_json)).toMatchObject({ status: 'oos_repair' });
    expect(JSON.parse(a[1].before_json).status).toBe('open');
  });
  it('writes an audit row for every kind of write', async () => {
    const calls: [string, string, any, string][] = [
      ['POST', '/api/issues', { vehicleId: 'v-02', title: 'x', severity: 'minor' }, 'issue.report'],
      ['POST', '/api/vehicles/v-02/readings', { hours: 99999 }, 'reading.log'],
      ['POST', '/api/moves', { vehicleIds: ['v-02'], toBaseId: 'b-linden' }, 'vehicle.move'],
      ['POST', '/api/parts', { number: 'P-9', description: 'x' }, 'part.create'],
      ['POST', '/api/mechanics', { name: 'Z' }, 'mechanic.create'],
      ['POST', '/api/bases', { name: 'Z' }, 'base.create'],
      ['PUT', '/api/settings', { approvalThresholdGYD: 1, dueSoonHours: 1, dueSoonDays: 1, comebackDays: 1 }, 'settings.update'],
      ['POST', '/api/work-orders', { vehicleId: 'v-02', type: 'inspection' }, 'wo.create'],
    ];
    for (const [m, p, b, action] of calls) {
      const before = (await row('SELECT COUNT(*) n FROM audit_log WHERE action = ?', action)).n;
      const r = await api(m, p, { cookie: fm, body: b });
      expect(r.status, p).toBe(200);
      expect((await row('SELECT COUNT(*) n FROM audit_log WHERE action = ?', action)).n, action).toBe(before + 1);
    }
  });
  it('a failed write leaves no audit row and no half-done changes', async () => {
    const before = (await row('SELECT COUNT(*) n FROM audit_log')).n;
    await T(fm, 'wo-09', { action: 'complete', hours: 1 }); // too low -> 400
    expect((await row('SELECT COUNT(*) n FROM audit_log')).n).toBe(before);
    expect((await row("SELECT status FROM work_orders WHERE id = 'wo-09'")).status).toBe('in_progress');
  });
});
void E;
