import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, makeUser, makeAgency, loginAs, seedDemo, syncAll, row, rows, E } from './helpers';
import { buildToday } from '../../src/worker/buscheck';
import { STARTER_SECTIONS } from '../../src/shared/busCheckStarter';
import { shiftsOnDate } from '../../src/shared/buscheck';
import { gyDate } from '../../src/shared/pure';

/**
 * Bus checks through the real API. GEMA has the demo fleet; BB is a second agency built through the API (see agencies.test.ts).
 * Reading the tests: `ok(...)` answers every item in the list as "all fine", `short(...)` changes some of those answers.
 */
const post = (cookie: string, path: string, body?: any) => api('POST', path, { cookie, body: body ?? {} });
const must = (r: { status: number; json: any }, what: string) => { expect(r.status, what + ' ' + JSON.stringify(r.json)).toBe(200); return r.json; };

let fm: string, sup: string, crew: { user: any; cookie: string };
let listId: string;
let sections: any[];

/** All-fine answers for a list's sections. */
const ok = (secs: any[]) => {
  const a: any = {};
  for (const s of secs) for (const it of s.items) {
    if (it.kind === 'count') a[it.id] = { status: 'ok' };
    else if (it.kind === 'check') a[it.id] = { status: 'pass' };
    else if (it.kind === 'number') a[it.id] = { value: (it.min ?? 0) + 500 };
    else if (it.kind === 'date') a[it.id] = { date: '2099-12-31' };
  }
  return a;
};
const vehicleNow = async (id: string) => (await row<any>('SELECT engine_hours, odometer_km, base_id, status FROM vehicles WHERE id = ?', id))!;
async function payload(vehicleId: string, o: any = {}) {
  const v = await vehicleNow(vehicleId);
  return {
    vehicleId, listId, baseId: v.base_id,
    crew: { emt1: { name: 'Ann Crew' }, emt2: { name: 'Bob Crew' } }, km: v.odometer_km + 5, hours: v.engine_hours + 1,
    answers: ok(sections), problems: [], attested: true, ...o,
  };
}
/** Save the Setup settings with the given changes (the screen always sends the whole form). */
const saveSettings = async (cookie: string, change: any) => {
  const cur = (await syncAll(cookie)).data.settings[0];
  const { id, ...rest } = cur;
  return api('PUT', '/api/settings', { cookie, body: { ...rest, ...change } });
};
const submit = (cookie: string, body: any) => api('POST', '/api/bus-checks', { cookie, body });
const first = (id: string) => sections.flatMap((s) => s.items).find((i: any) => i.id === id);

beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager', { email: 'fm@gema.test' })).cookie;
  sup = (await as('base_supervisor', { email: 'sup@gema.test', baseIds: ['b-hq'] })).cookie;
  crew = await as('crew', { email: 'crew@gema.test', baseIds: [] });
  listId = must(await post(fm, '/api/bus-check-lists/standard'), 'starter').id;
  sections = (await syncAll(fm)).data.busCheckLists.find((l: any) => l.id === listId).sections;
});

describe('permissions', () => {
  it('only crew, supervisors, fleet managers and system admins may do a check', async () => {
    const body = await payload('v-01');
    for (const role of ['mechanic', 'viewer', 'dispatcher']) {
      const c = (await as(role, { email: `${role}@x.test` })).cookie;
      expect((await submit(c, body)).status, role).toBe(403);
    }
    expect((await submit(crew.cookie, body)).status).toBe(200);
  });
  it('reports: not crew, supervisors only for their own bases', async () => {
    const id = must(await submit(fm, await payload('v-01')), 'check').id; // v-01 is at HQ
    expect((await api('GET', '/api/bus-checks', { cookie: crew.cookie })).status).toBe(403);
    expect((await api('GET', '/api/bus-checks/today', { cookie: crew.cookie })).status).toBe(403);
    expect((await api('GET', '/api/bus-checks/shortages', { cookie: crew.cookie })).status).toBe(403);
    expect((await api('GET', '/api/bus-checks/' + id, { cookie: crew.cookie })).status).toBe(403);
    expect((await api('GET', '/api/bus-checks/' + id, { cookie: sup })).status).toBe(200);
    const other = (await as('base_supervisor', { email: 'sup2@gema.test', baseIds: ['b-lethem'] })).cookie;
    expect((await api('GET', '/api/bus-checks/' + id, { cookie: other })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks', { cookie: other })).json.rows).toHaveLength(0);
    expect((await api('GET', '/api/bus-checks', { cookie: sup })).json.rows).toHaveLength(1);
    const none = (await as('base_supervisor', { email: 'sup3@gema.test', baseIds: [] })).cookie;
    expect((await api('GET', '/api/bus-checks', { cookie: none })).json.rows).toHaveLength(0);
    expect((await api('GET', '/api/bus-checks/' + id, { cookie: none })).status).toBe(404);
  });
  it('a supervisor cannot do a check on a unit outside their bases; crew with bases likewise', async () => {
    const lethem = (await row<any>("SELECT id FROM vehicles WHERE base_id = 'b-lethem' LIMIT 1"))!.id;
    expect((await submit(sup, await payload(lethem))).status).toBe(403);
    const cb = (await as('crew', { email: 'cb@gema.test', baseIds: ['b-hq'] })).cookie;
    expect((await submit(cb, await payload(lethem))).status).toBe(403);
    expect((await submit(cb, await payload('v-01'))).status).toBe(200);
  });
  it('editing requirements: fleet manager and admin yes; supervisor and crew no', async () => {
    const list = { name: 'X', unitTypes: ['Box'], sections: [{ title: 'S', items: [{ name: 'Torch', kind: 'check' }] }] };
    expect((await post(sup, '/api/bus-check-lists', list)).status).toBe(403);
    expect((await post(crew.cookie, '/api/bus-check-lists', list)).status).toBe(403);
    const adm = (await as('system_admin', { email: 'adm@gema.test' })).cookie;
    expect((await post(adm, '/api/bus-check-lists', list)).status).toBe(200);
    expect((await api('PUT', '/api/bus-check-lists/' + listId, { cookie: sup, body: { name: 'z', sections: [] } })).status).toBe(403);
  });
  it('per-person and per-role changes are honoured by the server', async () => {
    const adm = (await as('system_admin', { email: 'adm@gema.test' })).cookie;
    must(await post(adm, `/api/users/${crew.user.id}/permissions`, { overrides: { busCheckReports: true, busCheck: false } }), 'override');
    const c = await loginAs(crew.user);
    expect((await api('GET', '/api/bus-checks', { cookie: c })).status).toBe(200);
    expect((await submit(c, await payload('v-01'))).status).toBe(403);
    // a role-level change: let supervisors edit requirements
    must(await api('PUT', '/api/roles/base_supervisor/permissions', { cookie: adm, body: { overrides: { busCheckEdit: true } } }), 'role');
    const s2 = await loginAs({ email: 'sup@gema.test', password: 'correct-horse-9' });
    expect((await post(s2, '/api/bus-check-lists', { name: 'S2', unitTypes: ['Zed'], sections: [{ title: 'S', items: [{ name: 'Torch', kind: 'check' }] }] })).status).toBe(200);
  });
  it('the new permissions are listed with the right defaults', async () => {
    const me = await api('GET', '/api/auth/me', { cookie: crew.cookie });
    expect(me.json.user.perms).toMatchObject({ busCheck: true, busCheckReports: false, busCheckEdit: false });
    const me2 = await api('GET', '/api/auth/me', { cookie: fm });
    expect(me2.json.user.perms).toMatchObject({ busCheck: true, busCheckReports: true, busCheckEdit: true });
  });
});

describe('requirement lists', () => {
  it('the starter list can only be created once, and holds the converted items', async () => {
    expect((await post(fm, '/api/bus-check-lists/standard')).status).toBe(409);
    const n = sections.flatMap((s) => s.items).length;
    expect(n).toBe(STARTER_SECTIONS.flatMap((s) => s.items).length);
    expect(sections.map((s) => s.title).length).toBe(8);
    expect(await row("SELECT COUNT(*) AS n FROM bus_check_lists WHERE agency_id = 'GEMA'")).toEqual({ n: 1 });
  });
  it('nothing is created until asked: a new agency has no lists', async () => {
    await makeAgency('BB');
    expect(await row("SELECT COUNT(*) AS n FROM bus_check_lists WHERE agency_id = 'BB'")).toEqual({ n: 0 });
  });
  it('duplicate, rename, set unit types, edit items, reorder, deactivate: all audited', async () => {
    const dup = must(await post(fm, `/api/bus-check-lists/${listId}/duplicate`), 'dup').id;
    let l = (await syncAll(fm)).data.busCheckLists.find((x: any) => x.id === dup);
    expect(l).toMatchObject({ name: 'Standard ambulance (copy)', active: false, unitTypes: [] });
    const secs = JSON.parse(JSON.stringify(l.sections));
    secs[0].items.reverse(); // reorder
    secs[0].items.push({ name: 'Spare torch', kind: 'count', min: 2, unit: 'pcs' });
    secs[1].items.splice(0, 1); // remove
    const r = await api('PUT', '/api/bus-check-lists/' + dup, { cookie: fm, body: { name: 'Box ambulance', unitTypes: ['Box ambulance'], active: true, sections: secs, updatedAt: l.updatedAt } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    l = (await syncAll(fm)).data.busCheckLists.find((x: any) => x.id === dup);
    expect(l.name).toBe('Box ambulance');
    expect(l.sections[0].items.at(-1)).toMatchObject({ name: 'Spare torch', kind: 'count', min: 2 });
    expect(l.sections[0].items[0].id).toBe(secs[0].items[0].id);
    const off = await api('PUT', '/api/bus-check-lists/' + dup, { cookie: fm, body: { name: l.name, unitTypes: l.unitTypes, active: false, sections: l.sections } });
    expect(off.status).toBe(200);
    const acts = (await rows("SELECT action FROM audit_log WHERE entity_type = 'bus_check_list' ORDER BY id")).map((x: any) => x.action);
    expect(acts).toEqual(['buschecklist.create', 'buschecklist.duplicate', 'buschecklist.update', 'buschecklist.deactivate']);
  });
  it('refuses overlapping unit types and a second default, and a stale save', async () => {
    const l = (await syncAll(fm)).data.busCheckLists[0]; // the starter = the default list (no unit types)
    const mk = (o: any) => post(fm, '/api/bus-check-lists', { name: 'N', sections: [{ title: 'S', items: [{ name: 'Torch', kind: 'check' }] }], ...o });
    expect((await mk({ unitTypes: [] })).json.code).toBe('list_clash');
    expect((await mk({ unitTypes: ['Type II ambulance'] })).status).toBe(200);
    expect((await mk({ unitTypes: ['type ii  ambulance'] })).json.code).toBe('list_clash');
    expect((await mk({ unitTypes: [], active: false })).status).toBe(200); // inactive lists never clash
    const stale = await api('PUT', '/api/bus-check-lists/' + listId, { cookie: fm, body: { name: 'New name', unitTypes: [], active: true, sections: l.sections, updatedAt: '2000-01-01T00:00:00.000Z' } });
    expect(stale.status).toBe(409);
  });
  it('validates items: counts need a whole minimum, readings need a minimum, ids cannot repeat', async () => {
    const mk = (items: any[]) => post(fm, '/api/bus-check-lists', { name: 'V', unitTypes: ['V'], sections: [{ title: 'S', items }] });
    expect((await mk([{ name: 'a', kind: 'count' }])).status).toBe(400);
    expect((await mk([{ name: 'a', kind: 'count', min: 1.5 }])).status).toBe(400);
    expect((await mk([{ name: 'a', kind: 'number' }])).status).toBe(400);
    expect((await mk([{ name: 'a', kind: 'check', id: 'x' }, { name: 'b', kind: 'check', id: 'x' }])).status).toBe(400);
    expect((await mk([])).status).toBe(400);
    expect((await mk([{ name: 'a', kind: 'weird' }])).status).toBe(400);
  });
  it('lists reach the browser through sync, for everyone who reads fleet data', async () => {
    expect((await syncAll(crew.cookie)).data.busCheckLists).toHaveLength(1);
  });
  it('picks the list by unit type, falling back to the default', async () => {
    must(await post(fm, '/api/bus-check-lists', { name: 'Only II', unitTypes: ['Type II ambulance'], sections: [{ title: 'S', items: [{ name: 'Torch', kind: 'check', id: 'torch' }] }] }), 'type list');
    // the old (default) list no longer applies to a Type II ambulance: submitting with it is "stale"
    const r = await submit(fm, await payload('v-01'));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('stale_list');
  });
  it('no list at all: a clear message', async () => {
    await api('PUT', '/api/bus-check-lists/' + listId, { cookie: fm, body: { name: 'Standard ambulance', unitTypes: [], active: false, sections } });
    const r = await submit(fm, await payload('v-01'));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('no_list');
  });
});

describe('submitting', () => {
  it('saves the check, the reading, and nothing else when everything is fine', async () => {
    const v = await vehicleNow('v-01');
    const r = must(await submit(crew.cookie, await payload('v-01')), 'submit');
    expect(r).toMatchObject({ shortages: 0, newProblems: 0, joined: 0, reported: 0 });
    const c = (await row<any>('SELECT * FROM bus_checks WHERE id = ?', r.id))!;
    expect(c).toMatchObject({ agency_id: 'GEMA', vehicle_id: 'v-01', list_id: listId, shortages: 0, mileage_km: v.odometer_km + 5, engine_hours: v.engine_hours + 1, submitted_by: crew.user.id });
    expect(JSON.parse(c.crew)).toMatchObject({ emt1: { name: 'Ann Crew', userId: null }, emt2: { name: 'Bob Crew' } });
    expect(c.attestation).toContain('I verify that this unit');
    const rd = (await row<any>('SELECT * FROM meter_readings WHERE id = ?', c.reading_id))!;
    expect(rd).toMatchObject({ source: 'bus_check', hours: v.engine_hours + 1, km: v.odometer_km + 5, vehicle_id: 'v-01' });
    expect((await vehicleNow('v-01')).engine_hours).toBe(v.engine_hours + 1);
    // visible in the normal data (sync) the PM and unit screens use
    const sync = await syncAll(fm);
    expect(sync.data.meterReadings.find((m: any) => m.id === c.reading_id)).toBeTruthy();
    expect(await row("SELECT COUNT(*) AS n FROM issues WHERE bus_check_id = ?", r.id)).toEqual({ n: 0 });
    const acts = (await rows("SELECT action FROM audit_log WHERE entity_id = ? OR (action = 'reading.log' AND entity_id = 'v-01') ORDER BY id DESC", r.id)).map((x: any) => x.action);
    expect(acts).toContain('buscheck.submit');
  });
  it('uses the people chosen from the list, and takes their names from the database', async () => {
    const e1 = await makeUser('crew', { name: 'Real Name One' }), e2 = await makeUser('crew', { name: 'Real Name Two' });
    const r = must(await submit(crew.cookie, await payload('v-01', { crew: { emt1: { userId: e1.id, name: 'Spoofed' }, emt2: { userId: e2.id, name: '' }, driver: { name: ' Dan   Driver ' } } })), 'submit');
    const c = JSON.parse((await row<any>('SELECT crew FROM bus_checks WHERE id = ?', r.id))!.crew);
    expect(c).toMatchObject({ emt1: { userId: e1.id, name: 'Real Name One' }, emt2: { userId: e2.id, name: 'Real Name Two' }, driver: { userId: null, name: 'Dan Driver' } });
  });
  it('validation: EMT 2, same person twice, inactive or foreign people, attestation, answers, readings', async () => {
    const base = await payload('v-01');
    const bad = async (o: any, why: string, status = 400) => { const r = await submit(crew.cookie, { ...base, ...o }); expect(r.status, why + ' ' + JSON.stringify(r.json)).toBe(status); return r; };
    await bad({ crew: { emt1: { name: 'A' }, emt2: { name: '' } } }, 'no EMT 2');
    await bad({ crew: { emt1: { name: '' }, emt2: { name: 'B' } } }, 'no EMT 1');
    const u = await makeUser('crew');
    await bad({ crew: { emt1: { userId: u.id }, emt2: { userId: u.id } } }, 'same person');
    const gone = await makeUser('crew', { active: false });
    await bad({ crew: { emt1: { userId: gone.id }, emt2: { name: 'B' } } }, 'inactive person');
    await bad({ crew: { emt1: { userId: 'u-nobody' }, emt2: { name: 'B' } } }, 'unknown person');
    await bad({ attested: false }, 'not attested');
    const { attested, ...noAtt } = base; const r0 = await submit(crew.cookie, noAtt); expect(r0.status).toBe(400);
    const a = { ...base.answers }; delete a[Object.keys(a)[3]];
    const un = await bad({ answers: a }, 'unanswered'); expect(un.json.code).toBe('unanswered');
    await bad({ hours: -1 }, 'negative hours');
    await bad({ km: 1e12 }, 'huge km');
    await bad({ hours: 'x' }, 'text hours');
    await bad({ vehicleId: 'v-zzz' }, 'unknown unit', 404);
    await bad({ baseId: 'b-zzz' }, 'unknown base');
    const cnt = sections.flatMap((s) => s.items).find((i: any) => i.kind === 'count');
    await bad({ answers: { ...base.answers, [cnt.id]: { status: 'short', qty: cnt.min } } }, 'short but not below minimum');
    await bad({ answers: { ...base.answers, [cnt.id]: { status: 'short', qty: 1.5 } } }, 'fractional qty');
    const dt = sections.flatMap((s) => s.items).find((i: any) => i.kind === 'date');
    await bad({ answers: { ...base.answers, [dt.id]: { date: '2025-02-30' } } }, 'not a real date');
    expect(await row('SELECT COUNT(*) AS n FROM bus_checks')).toEqual({ n: 0 });
    expect(await row("SELECT COUNT(*) AS n FROM meter_readings WHERE source = 'bus_check'")).toEqual({ n: 0 }); // nothing half-saved
  });
  it('does not accept an id from a list that is not the unit\'s list, or an unknown answer key', async () => {
    const base = await payload('v-01');
    expect((await submit(crew.cookie, { ...base, listId: 'bl-none' })).status).toBe(400);
    // an answer for an item that is not on the list is refused
    const r = await submit(crew.cookie, { ...base, answers: { ...base.answers, 'not-an-item': { status: 'ok' } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('not on the list');
  });
  it('a suspicious reading is saved flagged and does not change the unit until a confirmer accepts', async () => {
    const v = await vehicleNow('v-01');
    const r = must(await submit(crew.cookie, await payload('v-01', { hours: v.engine_hours - 5 })), 'flagged');
    expect(r.flagged).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect((await vehicleNow('v-01')).engine_hours).toBe(v.engine_hours);
    expect(await row('SELECT flagged FROM meter_readings WHERE id = (SELECT reading_id FROM bus_checks WHERE id = ?)', r.id)).toEqual({ flagged: 1 });
  });
  it('shortages become problems with the agreed titles and severities', async () => {
    const all = sections.flatMap((s) => s.items);
    const cnt = all.find((i: any) => i.kind === 'count' && i.min >= 4), chk = all.find((i: any) => i.kind === 'check'), num = all.find((i: any) => i.kind === 'number'), dt = all.find((i: any) => i.kind === 'date');
    const body = await payload('v-01');
    body.answers[cnt.id] = { status: 'short', qty: cnt.min - 2, note: 'box was empty' };
    body.answers[chk.id] = { status: 'fail' };
    body.answers[num.id] = { value: 800 };
    body.answers[dt.id] = { date: '2025-02-01' };
    const r = must(await submit(crew.cookie, body), 'submit');
    expect(r).toMatchObject({ shortages: 4, newProblems: 4, joined: 0 });
    const is = await rows<any>("SELECT title, severity, status, source, source_ref, bus_check_id, vehicle_id, agency_id FROM issues WHERE bus_check_id = ? ORDER BY title", r.id);
    const by = (ref: string) => is.find((x: any) => x.source_ref === ref);
    expect(by(cnt.id)).toMatchObject({ title: `Bus check: ${cnt.name} short (${cnt.min - 2} of ${cnt.min}${cnt.unit ? ' ' + cnt.unit : ''})`, severity: 'minor', status: 'open', source: 'bus_check', vehicle_id: 'v-01', agency_id: 'GEMA' });
    expect(by(chk.id)).toMatchObject({ title: `Bus check: ${chk.name} failed`, severity: 'major' });
    expect(by(num.id)).toMatchObject({ title: `Bus check: ${num.name} 800${num.unit ? ' ' + num.unit : ''} (minimum ${num.min})`, severity: 'major' });
    expect(by(dt.id).title).toBe(`Bus check: ${dt.name} expired 01/02/2025`);
    expect(by(dt.id).severity).toBe('major');
    // they are ordinary problems: visible in sync, with the link to the check
    const sync = (await syncAll(fm)).data.issues.filter((x: any) => x.busCheckId === r.id);
    expect(sync).toHaveLength(4);
    expect(sync[0]).toMatchObject({ source: 'bus_check' });
    expect(await row('SELECT shortages FROM bus_checks WHERE id = ?', r.id)).toEqual({ shortages: 4 });
    // the unit is not taken out of service by a shortage
    expect((await vehicleNow('v-01')).status).toBe('in_service');
  });
  it('de-duplicates: the same open shortage joins the existing problem', async () => {
    const cnt = sections.flatMap((s) => s.items).find((i: any) => i.kind === 'count' && i.min >= 2);
    const mk = async (qty: number) => { const b = await payload('v-01'); b.answers[cnt.id] = { status: 'short', qty }; return must(await submit(crew.cookie, b), 'submit'); };
    const a = await mk(0), b = await mk(1);
    expect(a).toMatchObject({ newProblems: 1, joined: 0 });
    expect(b).toMatchObject({ newProblems: 0, joined: 1, shortages: 1 });
    const is = await rows<any>("SELECT id, description, bus_check_id FROM issues WHERE source = 'bus_check' AND source_ref = ?", cnt.id);
    expect(is).toHaveLength(1);
    expect(is[0].bus_check_id).toBe(a.id);
    expect(is[0].description).toContain('Found again by a bus check');
    const pb = JSON.parse((await row<any>('SELECT problems FROM bus_checks WHERE id = ?', b.id))!.problems);
    expect(pb).toEqual([{ issueId: is[0].id, kind: 'existing', itemId: cnt.id }]);
    // another unit is separate
    const c2 = await payload('v-02'); c2.answers[cnt.id] = { status: 'short', qty: 0 };
    expect(must(await submit(crew.cookie, c2), 'v-02').newProblems).toBe(1);
    // once the problem is dismissed, the next check creates a new one
    await post(fm, `/api/issues/${is[0].id}/dismiss`);
    expect((await mk(0)).newProblems).toBe(1);
  });
  it('problems the crew report inside the check use the normal rules (critical takes an available unit out of service)', async () => {
    const body = await payload('v-01', { problems: [{ title: 'Siren dead', description: 'No sound', severity: 'critical' }, { title: 'Cracked mirror', severity: 'minor' }] });
    const r = must(await submit(crew.cookie, body), 'submit');
    expect(r).toMatchObject({ shortages: 0, newProblems: 0, reported: 2 });
    const is = await rows<any>("SELECT title, severity, source, bus_check_id FROM issues WHERE bus_check_id = ? ORDER BY title", r.id);
    expect(is).toEqual([{ title: 'Cracked mirror', severity: 'minor', source: 'bus_check_report', bus_check_id: r.id }, { title: 'Siren dead', severity: 'critical', source: 'bus_check_report', bus_check_id: r.id }]);
    expect((await vehicleNow('v-01')).status).toBe('oos_repair');
    expect((await submit(crew.cookie, await payload('v-02', { problems: [{ title: '', severity: 'minor' }] }))).status).toBe(400);
    expect((await submit(crew.cookie, await payload('v-02', { problems: [{ title: 'x', severity: 'bogus' }] }))).status).toBe(400);
  });
  it('a retry with the same clientRef does not save a second check', async () => {
    const body = await payload('v-01', { clientRef: 'ref-1234567890' });
    const a = must(await submit(crew.cookie, body), 'first');
    const b = must(await submit(crew.cookie, body), 'retry');
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    expect(await row('SELECT COUNT(*) AS n FROM bus_checks')).toEqual({ n: 1 });
    expect((await submit(crew.cookie, { ...(await payload('v-02')), clientRef: 'ref-1234567890' })).status).toBe(409);
  });
  it('is read-only afterwards: there is no way to change or delete a check', async () => {
    const r = must(await submit(crew.cookie, await payload('v-01')), 'submit');
    for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      const x = await api(m, '/api/bus-checks/' + r.id, { cookie: fm, body: {} });
      expect([404, 405], m).toContain(x.status);
    }
    // editing the list afterwards leaves the check's own copy alone
    const l = (await syncAll(fm)).data.busCheckLists[0];
    const secs = JSON.parse(JSON.stringify(l.sections));
    const renamed = secs[0].items[0].name;
    secs[0].items[0].name = 'Renamed item'; secs[0].items.splice(1, 1);
    must(await api('PUT', '/api/bus-check-lists/' + listId, { cookie: fm, body: { name: 'Edited', unitTypes: [], active: true, sections: secs } }), 'edit');
    const got = (await api('GET', '/api/bus-checks/' + r.id, { cookie: fm })).json.check;
    expect(got.snapshot.sections[0].items[0].name).toBe(renamed);
    expect(got.snapshot.sections[0].items.length).toBe(sections[0].items.length);
    expect(got.list).toBe('Standard ambulance');
    expect(Object.keys(got.answers).length).toBeGreaterThan(50);
  });
  it('refuses a decommissioned unit', async () => {
    await E.DB.prepare("UPDATE vehicles SET status = 'decommissioned' WHERE id = 'v-03'").run();
    expect((await submit(crew.cookie, await payload('v-03'))).status).toBe(400);
  });
  it('is blocked when the person must change their password first', async () => {
    const u = await makeUser('crew', { mustChange: true });
    const c = await loginAs(u);
    expect((await submit(c, await payload('v-01'))).status).toBe(403);
  });
});

describe('Today, shifts and missed checks (fixed times)', () => {
  const D = '2026-01-15'; // a Thursday in the past
  const t = (hh: number, mm = 0, date = D) => Date.parse(`${date}T00:00:00.000Z`) + (hh + 4) * 36e5 + mm * 6e4; // Guyana = UTC-4
  const actor = (role: string, baseIds: string[] = []) => ({ id: 'x', email: '', name: '', role, baseIds, mechanicId: null, agencyId: 'GEMA', homeAgencyId: 'GEMA', perms: { busCheckReports: true } }) as any;
  const put = async (id: string, vehicle: string, at: string, shortages = 0) => {
    await E.DB.prepare(`INSERT INTO bus_checks (id, vehicle_id, list_id, list_name, base_id, submitted_at, submitted_by, crew, mileage_km, engine_hours, shortages, snapshot, answers, attestation, seq, created_at, updated_at, agency_id)
      VALUES (?,?,?,?,?,?,?,?,1,1,?,'{}','{}','a',1,?,?,'GEMA')`).bind(id, vehicle, listId, 'Standard ambulance', 'b-hq', at, 'u-none', '{}', shortages, at, at).run();
  };
  const cell = (rep: any, unit: string, k: number) => rep.bases.flatMap((b: any) => b.units).find((u: any) => u.unit === unit).cells[k];
  beforeEach(async () => {
    await E.DB.prepare("UPDATE vehicles SET created_at = '2020-01-01T00:00:00.000Z'").run();
    await E.DB.prepare('DELETE FROM status_events').run();
    await E.DB.prepare("UPDATE vehicles SET status = 'in_service'").run();
    await E.DB.prepare("UPDATE vehicles SET status = 'oos_repair' WHERE id = 'v-05'").run();
  });
  const unitOf = async (id: string) => (await row<any>('SELECT unit FROM vehicles WHERE id = ?', id))!.unit as string;
  it('assigns a check to the shift whose window contains it, with 60 minutes of grace before a shift', async () => {
    await put('c1', 'v-01', new Date(t(7, 30)).toISOString());       // morning shift
    await put('c2', 'v-02', new Date(t(6, 15)).toISOString());       // 45 min early: counts for the 07:00 shift
    await put('c3', 'v-03', new Date(t(5, 59)).toISOString());       // 61 min early: belongs to the previous night shift, so the morning is not covered
    await put('c4', 'v-04', new Date(t(19, 10)).toISOString());      // evening shift
    await put('c5', 'v-06', new Date(t(18, 5)).toISOString());       // 55 min early for the evening
    const rep = await buildToday(E, actor('fleet_manager'), D, [420, 1140], t(23, 0));
    const [u1, u2, u3, u4, u6] = await Promise.all(['v-01', 'v-02', 'v-03', 'v-04', 'v-06'].map(unitOf));
    expect([cell(rep, u1, 0).state, cell(rep, u1, 1).state]).toEqual(['checked', 'due']);
    expect([cell(rep, u2, 0).state, cell(rep, u2, 1).state]).toEqual(['checked', 'due']);
    expect([cell(rep, u3, 0).state, cell(rep, u3, 1).state]).toEqual(['missed', 'due']);
    expect([cell(rep, u4, 0).state, cell(rep, u4, 1).state]).toEqual(['missed', 'checked']);
    expect(cell(rep, u6, 1).state).toBe('checked');
    expect(cell(rep, u1, 0).check).toMatchObject({ id: 'c1' });
  });
  it('Due while the shift is open, Missed after it closes, upcoming before it starts', async () => {
    const at = async (h: number, m = 0) => buildToday(E, actor('fleet_manager'), D, [420, 1140], t(h, m));
    const u = await unitOf('v-01');
    let r = await at(5, 0); expect([cell(r, u, 0).state, cell(r, u, 1).state]).toEqual(['upcoming', 'upcoming']);
    r = await at(8, 0); expect([cell(r, u, 0).state, cell(r, u, 1).state]).toEqual(['due', 'upcoming']);
    r = await at(17, 30); expect([cell(r, u, 0).state, cell(r, u, 1).state]).toEqual(['due', 'upcoming']); // the morning window runs to 18:00 (an hour before the next shift)
    r = await at(18, 30); expect([cell(r, u, 0).state, cell(r, u, 1).state]).toEqual(['missed', 'upcoming']);
    r = await at(19, 30); expect([cell(r, u, 0).state, cell(r, u, 1).state]).toEqual(['missed', 'due']);
    expect(r.shifts.map((s: any) => s.state)).toEqual(['past', 'current']);
    expect(r.totals).toMatchObject({ checked: 0 });
  });
  it('a unit that was out of service at the shift start is not expected, and counts if it was checked anyway', async () => {
    const u5 = await unitOf('v-05');
    let r = await buildToday(E, actor('fleet_manager'), D, [420, 1140], t(23, 0));
    expect(cell(r, u5, 0)).toMatchObject({ state: 'not_expected', reason: 'Out of service' });
    await put('c9', 'v-05', new Date(t(8, 0)).toISOString());
    r = await buildToday(E, actor('fleet_manager'), D, [420, 1140], t(23, 0));
    expect(cell(r, u5, 0).state).toBe('checked');
    // out of service only from the evening on: expected in the morning
    await E.DB.prepare(`INSERT INTO status_events (id, vehicle_id, at, from_status, to_status, reason, by_user, seq, created_at, updated_at, agency_id) VALUES ('se1','v-02',?, 'in_service','oos_repair','x','u',1,?,?,'GEMA')`).bind(new Date(t(12)).toISOString(), D, D).run();
    r = await buildToday(E, actor('fleet_manager'), D, [420, 1140], t(23, 0));
    const u2 = await unitOf('v-02');
    expect([cell(r, u2, 0).state, cell(r, u2, 1).state]).toEqual(['missed', 'not_expected']);
  });
  it('works with other shift times, and totals are right', async () => {
    await put('c1', 'v-01', new Date(t(6, 0)).toISOString(), 2);
    await put('c2', 'v-02', new Date(t(14, 30)).toISOString());
    const rep = await buildToday(E, actor('fleet_manager'), D, [360, 840, 1320], t(23, 0));
    expect(rep.shifts).toHaveLength(3);
    expect(cell(rep, await unitOf('v-01'), 0).state).toBe('checked');
    expect(cell(rep, await unitOf('v-02'), 1).state).toBe('checked');
    expect(rep.totals.checked).toBe(2);
    expect(rep.totals.withShortages).toBe(1);
    const cells = rep.bases.flatMap((b: any) => b.units).flatMap((u: any) => u.cells);
    expect(rep.totals.missed).toBe(cells.filter((c: any) => c.state === 'missed').length);
    expect(cells.filter((c: any) => c.state === 'checked')).toHaveLength(2);
  });
  it('a supervisor sees only the units at their bases', async () => {
    const rep = await buildToday(E, actor('base_supervisor', ['b-hq']), D, [420, 1140], t(23, 0));
    expect(rep.bases.map((b: any) => b.id)).toEqual(['b-hq']);
    const none = await buildToday(E, actor('base_supervisor', []), D, [420, 1140], t(23, 0));
    expect(none.bases).toEqual([]);
  });
  it('the API endpoint validates the date and uses the Setup times', async () => {
    expect((await api('GET', '/api/bus-checks/today?date=nonsense', { cookie: fm })).status).toBe(400);
    expect((await api('GET', '/api/bus-checks/today?date=1999-01-01', { cookie: fm })).status).toBe(400);
    must(await saveSettings((await as('system_admin', { email: 'a2@gema.test' })).cookie, { busCheckShifts: '6:00, 14:00, 22:00' }), 'settings');
    const r = await api('GET', '/api/bus-checks/today?date=' + D, { cookie: fm });
    expect(r.status).toBe(200);
    expect(r.json.shifts.map((s: any) => s.label)).toEqual(['06:00', '14:00', '22:00']);
    expect(shiftsOnDate(D, [360])[0].label).toBe('06:00');
    expect(gyDate(Date.now())).toMatch(/^\d{4}-/);
  });
});

describe('settings: shift start times', () => {
  it('defaults to 07:00 and 19:00, validates and tidies', async () => {
    const adm = (await as('system_admin', { email: 'adm@gema.test' })).cookie;
    expect((await syncAll(adm)).data.settings[0].busCheckShifts ?? '07:00, 19:00').toBe('07:00, 19:00');
    for (const bad of ['', 'abc', '25:00', '07:00, 07:30', '07:00, 07:00', '1,2,3,4,5,6,7']) {
      expect((await saveSettings(adm, { busCheckShifts: bad })).status, bad).toBe(400);
    }
    must(await saveSettings(adm, { busCheckShifts: '19:00,7:00' }), 'ok');
    expect((await syncAll(adm)).data.settings[0].busCheckShifts).toBe('07:00, 19:00');
    expect((await saveSettings(fm, { busCheckShifts: '08:00' })).status).toBe(200) // fleet managers have Setup;
  });
});

describe('shortages report and history', () => {
  let ids: string[];
  beforeEach(async () => {
    const all = sections.flatMap((s) => s.items);
    const cnt = all.find((i: any) => i.kind === 'count'), chk = all.find((i: any) => i.kind === 'check');
    ids = [];
    for (const [veh, short] of [['v-01', [cnt.id, chk.id]], ['v-02', [cnt.id]], ['v-01', [cnt.id]], ['v-08', []]] as const) {
      const b = await payload(veh);
      for (const s of short) b.answers[s] = s === cnt.id ? { status: 'short', qty: 0 } : { status: 'fail' };
      ids.push(must(await submit(fm, b), 'submit').id);
    }
    (globalThis as any).__cnt = cnt;
  });
  it('counts how often each item was short, and by unit', async () => {
    const r = (await api('GET', '/api/bus-checks/shortages', { cookie: fm })).json;
    const cnt = (globalThis as any).__cnt;
    expect(r.totals).toMatchObject({ checks: 4, withShortages: 3, shortages: 4 });
    expect(r.items[0]).toMatchObject({ itemId: cnt.id, name: cnt.name, times: 3, units: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.units[0]).toMatchObject({ shortages: 3, checks: 2 });
    const sc = (await as('base_supervisor', { email: 's9@gema.test', baseIds: ['b-lethem'] })).cookie;
    expect((await api('GET', '/api/bus-checks/shortages', { cookie: sc })).json.items).toHaveLength(0);
    expect((await api('GET', '/api/bus-checks/shortages?from=2030-01-01&to=2030-02-01', { cookie: fm })).json.items).toHaveLength(0);
    expect((await api('GET', '/api/bus-checks/shortages?from=2026-02-01&to=2026-01-01', { cookie: fm })).status).toBe(400);
  });
  it('exports CSV, one row per shortage, with safe cells', async () => {
    const x = await api('GET', '/api/bus-checks/shortages/export', { cookie: fm });
    expect(x.status).toBe(200);
    expect(x.headers.get('content-type')).toContain('text/csv');
    const text = await x.res.text();
    expect(text.trim().split('\n')).toHaveLength(1 + 4);
    expect(text).toContain('What was found');
    expect((await api('GET', '/api/bus-checks/shortages/export', { cookie: crew.cookie })).status).toBe(403);
  });
  it('history: newest first, paged, filtered', async () => {
    const h = (await api('GET', '/api/bus-checks', { cookie: fm })).json;
    expect(h.rows.map((r: any) => r.id)).toEqual([...ids].reverse());
    expect(h.hasMore).toBe(false);
    const p1 = (await api('GET', '/api/bus-checks?limit=3', { cookie: fm })).json;
    expect(p1.rows).toHaveLength(3); expect(p1.hasMore).toBe(true);
    const p2 = (await api('GET', '/api/bus-checks?limit=3&before=' + encodeURIComponent(p1.nextBefore), { cookie: fm })).json;
    expect([...p1.rows, ...p2.rows].map((r: any) => r.id)).toEqual([...ids].reverse());
    expect(p2.hasMore).toBe(false);
    expect((await api('GET', '/api/bus-checks?before=junk', { cookie: fm })).status).toBe(400);
    expect((await api('GET', '/api/bus-checks?vehicleId=v-01', { cookie: fm })).json.rows).toHaveLength(2);
    expect((await api('GET', '/api/bus-checks?shortages=1', { cookie: fm })).json.rows).toHaveLength(3);
    expect((await api('GET', '/api/bus-checks?baseId=b-hq', { cookie: fm })).json.rows.length).toBeGreaterThan(0);
    expect((await api('GET', '/api/bus-checks?userId=' + (await row<any>("SELECT id FROM users WHERE email = 'fm@gema.test'"))!.id, { cookie: fm })).json.rows).toHaveLength(4);
    expect((await api('GET', '/api/bus-checks?from=2030-01-01', { cookie: fm })).json.rows).toHaveLength(0);
    expect((await api('GET', '/api/bus-checks?from=' + gyDate(Date.now()) + '&to=' + gyDate(Date.now()), { cookie: fm })).json.rows).toHaveLength(4);
    expect((await api('GET', '/api/bus-checks?vehicleId=nope', { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks?baseId=nope', { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks?userId=nope', { cookie: fm })).status).toBe(404);
    // a supervisor cannot reach other bases' units by filtering for them
    const lethem = (await row<any>("SELECT id FROM vehicles WHERE base_id = 'b-lethem' LIMIT 1"))!.id;
    expect((await api('GET', '/api/bus-checks?vehicleId=' + lethem, { cookie: sup })).status).toBe(404);
  });
  it('history CSV follows the same filters and scope', async () => {
    const x = await api('GET', '/api/bus-checks/export?shortages=1', { cookie: fm });
    expect(x.status).toBe(200);
    expect((await x.res.text()).trim().split('\n')).toHaveLength(1 + 3);
    expect(x.headers.get('x-rows')).toBe('3');
    const other = (await as('base_supervisor', { email: 's8@gema.test', baseIds: ['b-lethem'] })).cookie;
    expect(((await (await api('GET', '/api/bus-checks/export', { cookie: other })).res.text()).trim().split('\n')).length).toBe(1);
  });
  it('one check shows everything: crew, readings, answers, problems with their state, shift, attestation', async () => {
    const c = (await api('GET', '/api/bus-checks/' + ids[0], { cookie: fm })).json.check;
    expect(c).toMatchObject({ unit: expect.any(String), crew: { emt1: { name: 'Ann Crew' } }, shortages: 2 });
    expect(c.problems).toHaveLength(2);
    expect(c.problems[0]).toMatchObject({ kind: 'new', status: 'open' });
    expect(c.problems[0].title).toContain('Bus check:');
    expect(c.shift).toMatch(/^\d\d:\d\d shift on \d\d\/\d\d\/\d{4}$/);
    expect(c.attestation).toContain('I verify');
  });
});

describe('agency isolation (both directions)', () => {
  let bAdmin: string, B: any;
  beforeEach(async () => {
    const b = await makeAgency('BB', 'Bravo', 'admin@bb.test');
    bAdmin = await loginAs(b);
    B = {};
    B.base = must(await post(bAdmin, '/api/bases', { name: 'B Depot', region: 'N', minUnits: 1 }), 'base').id;
    B.vehicle = must(await post(bAdmin, '/api/vehicles', { unit: 'ZZB-1', make: 'Ford', model: 'T', type: 'Type II ambulance', baseId: B.base, pmStart: 'never' }), 'vehicle').id;
    B.crew = must(await post(bAdmin, '/api/users', { name: 'B Crew', email: 'crew@bb.test', role: 'crew', baseIds: [], password: 'b-crew-password-1' }), 'user').id;
    B.list = must(await post(bAdmin, '/api/bus-check-lists/standard'), 'B starter').id;
    B.sections = (await syncAll(bAdmin)).data.busCheckLists.find((l: any) => l.id === B.list).sections;
  });
  const bPayload = (o: any = {}) => ({ vehicleId: B.vehicle, listId: B.list, baseId: B.base, crew: { emt1: { name: 'x' }, emt2: { name: 'y' } }, km: 10, hours: 10, answers: ok(B.sections), problems: [], attested: true, ...o });

  it('each agency starts its own list and sees only its own', async () => {
    expect((await syncAll(bAdmin)).data.busCheckLists.map((l: any) => l.id)).toEqual([B.list]);
    expect((await syncAll(fm)).data.busCheckLists.map((l: any) => l.id)).toEqual([listId]);
  });
  it('GEMA cannot use B\'s unit, list, base or people; B cannot use GEMA\'s', async () => {
    const g = await payload('v-01');
    expect((await submit(fm, { ...g, vehicleId: B.vehicle })).status).toBe(404);
    expect((await submit(fm, { ...g, listId: B.list })).status).toBe(400);
    expect((await submit(fm, { ...g, baseId: B.base })).status).toBe(400);
    expect((await submit(fm, { ...g, crew: { emt1: { userId: B.crew }, emt2: { name: 'z' } } })).status).toBe(400);
    expect((await submit(bAdmin, bPayload({ vehicleId: 'v-01' }))).status).toBe(404);
    expect((await submit(bAdmin, bPayload({ listId }))).status).toBe(400);
    expect((await submit(bAdmin, bPayload({ baseId: 'b-hq' }))).status).toBe(400);
    expect((await submit(bAdmin, bPayload({ crew: { emt1: { userId: crew.user.id }, emt2: { name: 'z' } } }))).status).toBe(400);
    expect(await row('SELECT COUNT(*) AS n FROM bus_checks')).toEqual({ n: 0 });
    expect(await row('SELECT COUNT(*) AS n FROM issues WHERE bus_check_id IS NOT NULL')).toEqual({ n: 0 });
  });
  it('a check, its list and its problems never appear in the other agency', async () => {
    const gc = must(await submit(fm, await payload('v-01')), 'G').id;
    const bc = must(await submit(bAdmin, bPayload()), 'B').id;
    expect((await api('GET', '/api/bus-checks/' + gc, { cookie: bAdmin })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks/' + bc, { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks', { cookie: bAdmin })).json.rows.map((r: any) => r.id)).toEqual([bc]);
    expect((await api('GET', '/api/bus-checks', { cookie: fm })).json.rows.map((r: any) => r.id)).toEqual([gc]);
    expect((await api('GET', '/api/bus-checks/export', { cookie: fm }).then((r) => r.res.text())).includes('ZZB-1')).toBe(false);
    const gt = (await api('GET', '/api/bus-checks/today?date=' + gyDate(Date.now()), { cookie: fm })).json;
    expect(JSON.stringify(gt)).not.toContain('ZZB-1');
    const bt = (await api('GET', '/api/bus-checks/today?date=' + gyDate(Date.now()), { cookie: bAdmin })).json;
    expect(bt.bases.flatMap((b: any) => b.units).map((u: any) => u.unit)).toEqual(['ZZB-1']);
  });
  it('other agency\'s ids in filters are "not found"', async () => {
    expect((await api('GET', '/api/bus-checks?vehicleId=' + B.vehicle, { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks?baseId=' + B.base, { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks?userId=' + B.crew, { cookie: fm })).status).toBe(404);
    expect((await api('GET', '/api/bus-checks?vehicleId=v-01', { cookie: bAdmin })).status).toBe(404);
  });
  it('lists: B cannot read, change or copy GEMA\'s, and the reverse', async () => {
    const body = { name: 'Hijack', unitTypes: [], active: true, sections: sections };
    expect((await api('PUT', '/api/bus-check-lists/' + listId, { cookie: bAdmin, body })).status).toBe(404);
    expect((await post(bAdmin, `/api/bus-check-lists/${listId}/duplicate`)).status).toBe(404);
    expect((await api('PUT', '/api/bus-check-lists/' + B.list, { cookie: fm, body })).status).toBe(404);
    expect((await post(fm, `/api/bus-check-lists/${B.list}/duplicate`)).status).toBe(404);
    expect((await row<any>('SELECT name FROM bus_check_lists WHERE id = ?', listId))!.name).toBe('Standard ambulance');
    expect((await row<any>('SELECT name FROM bus_check_lists WHERE id = ?', B.list))!.name).toBe('Standard ambulance');
  });
  it('shortages, de-duplication and reports stay inside the agency', async () => {
    const cnt = sections.flatMap((s) => s.items).find((i: any) => i.kind === 'count');
    const g = await payload('v-01'); g.answers[cnt.id] = { status: 'short', qty: 0 };
    const b = bPayload(); b.answers[cnt.id] = { status: 'short', qty: 0 };
    must(await submit(fm, g), 'G'); const rb = must(await submit(bAdmin, b), 'B');
    expect(rb).toMatchObject({ newProblems: 1, joined: 0 }); // B did not join GEMA's open problem (same item id!)
    expect(await row("SELECT COUNT(*) AS n FROM issues WHERE source = 'bus_check' AND agency_id = 'BB'")).toEqual({ n: 1 });
    expect(await row("SELECT COUNT(*) AS n FROM issues WHERE source = 'bus_check' AND agency_id = 'GEMA'")).toEqual({ n: 1 });
    expect((await api('GET', '/api/bus-checks/shortages', { cookie: bAdmin })).json.items).toHaveLength(1);
    expect((await api('GET', '/api/bus-checks/shortages', { cookie: bAdmin })).json.totals.checks).toBe(1);
    const sy = await syncAll(bAdmin);
    expect(sy.data.issues.every((i: any) => i.vehicleId === B.vehicle)).toBe(true);
  });
  it('rows carry the right agency id, and the super user viewing B works in B', async () => {
    const bc = must(await submit(bAdmin, bPayload()), 'B').id;
    expect(await row('SELECT agency_id FROM bus_checks WHERE id = ?', bc)).toEqual({ agency_id: 'BB' });
    expect(await row('SELECT agency_id FROM meter_readings WHERE id = (SELECT reading_id FROM bus_checks WHERE id = ?)', bc)).toEqual({ agency_id: 'BB' });
    expect(await row("SELECT agency_id FROM audit_log WHERE action = 'buscheck.submit'")).toEqual({ agency_id: 'BB' });
  });
});
