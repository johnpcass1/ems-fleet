import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, makeUser, makeAgency, superCookie, seedDemo, syncAll, loginAs, cookieOf, row, rows, E, PASSWORD, SUPER_EMAIL } from './helpers';

/**
 * Two agencies share one database: GEMA (the demo fleet) and BB (built through the API in beforeEach). Everything here checks that the server keeps
 * them apart, in both directions, and that an id from the other agency behaves exactly like an id that does not exist.
 */
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const upForm = (entityId: string, name: string) => {
  const f = new FormData();
  f.set('entity_type', 'issue'); f.set('entity_id', entityId);
  f.set('file', new File([png()], name, { type: 'image/png' }));
  return f;
};

let sup: string;       // the super user (home agency GEMA)
let gAdmin: string;    // GEMA system administrator
let bAdmin: string;    // B system administrator
let b: { agency: string; email: string; password: string; id: string };
// ids that belong to each agency
const G: Record<string, string> = { vehicle: 'v-02', issue: 'i-04', wo: 'wo-15', base: 'b-hq', mechanic: 'm-2' };
const B: Record<string, string> = {};

const COLLECTIONS = ['bases', 'issues', 'mechanics', 'meterReadings', 'moves', 'people', 'parts', 'pmPrograms', 'settings', 'statusEvents', 'vehicles', 'workOrders'];
/** Every id in a sync answer, as "collection:id". */
const syncIds = (s: any) => COLLECTIONS.flatMap((k) => (s.data[k] || []).map((x: any) => `${k}:${x.id}`));
const post = (cookie: string, path: string, body?: any) => api('POST', path, { cookie, body: body ?? {} });
const must = (r: { status: number; json: any }, what: string) => { expect(r.status, what + ' ' + JSON.stringify(r.json)).toBe(200); return r.json; };

beforeEach(async () => {
  await seedDemo();
  gAdmin = (await as('system_admin', { email: 'g-admin@gema.test' })).cookie;
  sup = await superCookie();
  b = await makeAgency('BB', 'Bravo Ambulance', 'admin@b.test');
  bAdmin = await loginAs(b);
  // Build B's records through the API (the way a real administrator would).
  B.base = must(await post(bAdmin, '/api/bases', { name: 'B Depot', region: 'North', minUnits: 1 }), 'base').id;
  B.mechanic = must(await post(bAdmin, '/api/mechanics', { name: 'B Mechanic' }), 'mechanic').id;
  B.part = must(await post(bAdmin, '/api/parts', { number: 'ZZB-1', description: 'B only part', onHand: 5, reorderPoint: 1, unitCost: 10 }), 'part').id;
  B.vehicle = must(await post(bAdmin, '/api/vehicles', { unit: 'ZZB-UNIT-1', make: 'Ford', model: 'Transit', baseId: B.base, pmStart: 'never' }), 'vehicle').id;
  B.issue = must(await post(bAdmin, '/api/issues', { vehicleId: B.vehicle, title: 'ZZB problem', severity: 'minor' }), 'issue').id;
  B.wo = must(await post(bAdmin, '/api/work-orders', { vehicleId: B.vehicle, type: 'corrective', issueIds: [B.issue] }), 'wo').id;
  B.line = must(await post(bAdmin, `/api/work-orders/${B.wo}/lines`, { kind: 'labor', description: 'ZZB labour', qty: 1, unitCost: 5 }), 'line').lineId;
  B.user = must(await post(bAdmin, '/api/users', { name: 'B Crew', email: 'crew@b.test', role: 'crew', baseIds: [], password: 'b-crew-password-1' }), 'user').id;
  // Uploads are off by default and only the super user can switch them on: do it in both agencies, through the Open screen for B.
  must(await api('PUT', '/api/features', { cookie: sup, body: { uploads: true } }), 'features G');
  must(await post(sup, '/api/agencies/BB/open'), 'open B');
  must(await api('PUT', '/api/features', { cookie: sup, body: { uploads: true } }), 'features B');
  must(await post(sup, '/api/agencies/back'), 'back');
  B.attachment = must(await api('POST', '/api/attachments', { cookie: bAdmin, form: upForm(B.issue, 'b.png') }), 'b attachment').id;
  G.attachment = must(await api('POST', '/api/attachments', { cookie: gAdmin, form: upForm(G.issue, 'g.png') }), 'g attachment').id;
  const gs = await syncAll(gAdmin);
  G.part = gs.data.parts[0].id;
  G.user = (await row("SELECT id FROM users WHERE email = 'g-admin@gema.test'")).id;
});

describe('creating an agency', () => {
  it('starts empty: no bases, vehicles, parts or work orders, default settings, one administrator', async () => {
    const c = await makeAgency('NEWCO', 'New Co', 'boss@newco.test');
    const ck = await loginAs(c);
    const s = await syncAll(ck);
    expect(s.agencyId).toBe('NEWCO');
    for (const k of COLLECTIONS) if (k !== 'people' && k !== 'settings') expect(s.data[k] ?? [], k).toEqual([]);
    expect(s.data.people).toHaveLength(1);
    expect(s.data.settings).toHaveLength(1);
    expect(s.data.settings[0].id).toBe('NEWCO');
    expect(s.data.settings[0].sample).toBeFalsy();
  });
  it('stores the code in upper case, rejects a duplicate or a bad code, and audits the creation', async () => {
    must(await post(sup, '/api/agencies', { code: ' lower-1 ', name: 'Lower', admin: { name: 'A', email: 'a@lower.test', password: PASSWORD } }), 'create');
    expect(await row("SELECT id FROM agencies WHERE id = 'LOWER-1'")).toBeTruthy();
    const dup = await post(sup, '/api/agencies', { code: 'bb', name: 'Dup', admin: { name: 'A', email: 'a@dup.test', password: PASSWORD } });
    expect(dup.status).toBe(409);
    for (const code of ['X', 'A'.repeat(21), 'bad code', 'a_b', 'é1']) {
      expect((await post(sup, '/api/agencies', { code, name: 'x', admin: { name: 'A', email: 'a@x.test', password: PASSWORD } })).status, code).toBe(400);
    }
    expect((await post(sup, '/api/agencies', { code: 'WEAK', name: 'Weak', admin: { name: 'A', email: 'a@weak.test', password: 'short' } })).status).toBe(400);
    expect(await row("SELECT 1 AS x FROM agencies WHERE id = 'WEAK'")).toBeNull();
    const a = await row("SELECT user_email, agency_id FROM audit_log WHERE action = 'agency.create' AND entity_id = 'LOWER-1'");
    expect(a).toMatchObject({ user_email: SUPER_EMAIL, agency_id: 'LOWER-1' });
  });
  it('lists agencies with users, vehicles and created date', async () => {
    const r = await api('GET', '/api/agencies', { cookie: sup });
    expect(r.status).toBe(200);
    const g = r.json.agencies.find((x: any) => x.id === 'GEMA'), bb = r.json.agencies.find((x: any) => x.id === 'BB');
    expect(g).toMatchObject({ name: 'GEMA', active: true, isHome: true });
    expect(g.vehicles).toBeGreaterThan(5);
    expect(bb).toMatchObject({ name: 'Bravo Ambulance', active: true, isHome: false, vehicles: 1, users: 2 });
    expect(bb.createdAt).toBeTruthy();
  });
  it('rename works and is audited; the home agency cannot be deactivated', async () => {
    must(await api('PATCH', '/api/agencies/BB', { cookie: sup, body: { name: 'Bravo Two' } }), 'rename');
    expect((await row("SELECT name FROM agencies WHERE id = 'BB'")).name).toBe('Bravo Two');
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'agency.rename' AND agency_id = 'BB'")).toBeTruthy();
    expect((await post(sup, '/api/agencies/GEMA/deactivate')).status).toBe(400);
    expect((await post(sup, '/api/agencies/NOPE/deactivate')).status).toBe(404);
  });
});

describe('sync never carries the other agency\'s rows', () => {
  it('each agency sees only its own, in both directions', async () => {
    const g = await syncAll(gAdmin), bb = await syncAll(bAdmin);
    const gi = syncIds(g), bi = syncIds(bb);
    expect(gi.length).toBeGreaterThan(50);
    expect(gi).toContain('vehicles:v-02');
    expect(bi).toContain('vehicles:' + B.vehicle);
    for (const x of gi) expect(bi, x).not.toContain(x);
    expect(gi.some((x) => x.includes(B.vehicle) || x.includes(B.issue) || x.includes(B.wo) || x.includes(B.part) || x.includes(B.user))).toBe(false);
    expect(bi.some((x) => /v-0|wo-1|i-04/.test(x))).toBe(false);
    expect(bb.data.settings.map((x: any) => x.id)).toEqual(['BB']);
    expect(g.data.settings.map((x: any) => x.id)).toEqual(['GEMA']);
    expect(bb.data.people.map((x: any) => x.id).sort()).toEqual([b.id, B.user].sort());
    expect(g.data.people.map((x: any) => x.id)).not.toContain(b.id);
  });
  it('an incremental poll after a change in the other agency returns nothing', async () => {
    const g0 = await syncAll(gAdmin);
    must(await post(bAdmin, '/api/vehicles/' + B.vehicle + '/status', { to: 'oos_repair', reason: 'x' }), 'b status');
    const g1 = await syncAll(gAdmin, g0.cursor);
    expect(g1.data).toEqual({});
    expect(g1.deleted).toEqual({});
  });
  it('deletions are per agency too (a removed WO line shows only to its own agency)', async () => {
    const g0 = await syncAll(gAdmin), b0 = await syncAll(bAdmin);
    must(await api('DELETE', `/api/work-orders/${B.wo}/lines/${B.line}`, { cookie: bAdmin }), 'remove line');
    expect((await syncAll(gAdmin, g0.cursor)).deleted).toEqual({});
    expect((await syncAll(bAdmin, b0.cursor)).data.workOrders[0].lines).toEqual([]);
  });
  it('asking for another agency by name forces a full resync instead of a delta', async () => {
    const g0 = await syncAll(gAdmin);
    const r = await api('GET', `/api/sync?since=${g0.cursor}&agency=B`, { cookie: gAdmin });
    expect(r.json.full).toBe(true);
    expect(r.json.agencyId).toBe('GEMA');
    expect(syncIds(r.json)).not.toContain('vehicles:' + B.vehicle);
  });
});

describe('lists, history, settings and roles are per agency', () => {
  it('users list', async () => {
    const g = (await api('GET', '/api/users', { cookie: gAdmin })).json.users, bb = (await api('GET', '/api/users', { cookie: bAdmin })).json.users;
    const ge = g.map((x: any) => x.email), be = bb.map((x: any) => x.email);
    expect(be.sort()).toEqual(['admin@b.test', 'crew@b.test']);
    expect(ge).toContain('g-admin@gema.test');
    expect(ge).not.toContain('admin@b.test');
    expect(ge).not.toContain('crew@b.test');
  });
  it('activity history and CSV', async () => {
    const g = (await api('GET', '/api/admin/activity?limit=200', { cookie: gAdmin })).json.rows;
    const bb = (await api('GET', '/api/admin/activity?limit=200', { cookie: bAdmin })).json.rows;
    expect(bb.length).toBeGreaterThan(5);
    expect(bb.some((r: any) => r.entityId === B.vehicle)).toBe(true);
    expect(g.some((r: any) => r.entityId === B.vehicle || r.entityId === B.wo || r.entityId === B.issue)).toBe(false);
    expect(bb.some((r: any) => r.entityId === 'v-02' || r.entityId === G.issue || r.email === 'g-admin@gema.test')).toBe(false);
    expect(g.some((r: any) => r.action === 'agency.create' || r.email === 'admin@b.test')).toBe(false);
    const gCsv = await (await api('GET', '/api/admin/activity/export', { cookie: gAdmin })).res.text();
    const bCsv = await (await api('GET', '/api/admin/activity/export', { cookie: bAdmin })).res.text();
    expect(bCsv).toContain('ZZB-UNIT-1');
    expect(gCsv).not.toContain('ZZB');
    expect(gCsv).not.toContain('admin@b.test');
    expect(bCsv).not.toContain('g-admin@gema.test');
    const gUnit = (await syncAll(gAdmin)).data.vehicles.find((v: any) => v.id === 'v-02').unit;
    expect(bCsv).not.toContain(gUnit);
    // asking for the other agency's row id as the "after" cursor does not leak or fail differently from an unknown id
    const bId = bb[0].id;
    const x = await api('GET', `/api/admin/activity?limit=5&before=${bId}`, { cookie: gAdmin });
    expect(x.status).toBeLessThan(500);
  });
  it('settings and features are separate', async () => {
    must(await api('PUT', '/api/settings', { cookie: bAdmin, body: { approvalThresholdGYD: 777, dueSoonHours: 11, dueSoonDays: 12, comebackDays: 13 } }), 'b settings');
    const g = (await syncAll(gAdmin)).data.settings[0], bb = (await syncAll(bAdmin)).data.settings[0];
    expect(bb.approvalThresholdGYD).toBe(777);
    expect(g.approvalThresholdGYD).not.toBe(777);
    // the switch was turned on in both agencies in beforeEach; turning it off in B leaves GEMA on
    must(await api('PUT', '/api/features', { cookie: sup, body: { uploads: true } }), 'g on');
    must(await post(sup, '/api/agencies/BB/open'), 'open');
    must(await api('PUT', '/api/features', { cookie: sup, body: { uploads: false } }), 'b off');
    must(await post(sup, '/api/agencies/back'), 'back');
    expect((await syncAll(bAdmin)).data.settings[0].features?.uploads).toBeFalsy();
    expect((await syncAll(gAdmin)).data.settings[0].features?.uploads).toBeTruthy();
    expect((await row("SELECT COUNT(*) AS n FROM settings WHERE id IN ('GEMA','BB')")).n).toBe(2);
  });
  it('role permissions are per agency', async () => {
    must(await api('PUT', '/api/roles/crew/permissions', { cookie: bAdmin, body: { overrides: { report: false } } }), 'b role');
    const g = (await syncAll(gAdmin)).data.settings[0], bb = (await syncAll(bAdmin)).data.settings[0];
    expect(bb.rolePerms).toEqual({ crew: { report: false } });
    expect(g.rolePerms ?? {}).toEqual({});
    // and it really takes effect only for B's crew
    const bCrew = await loginAs({ agency: 'BB', email: 'crew@b.test', password: 'b-crew-password-1' });
    expect((await post(bCrew, '/api/issues', { vehicleId: B.vehicle, title: 'x', severity: 'minor' })).status).toBe(403);
    const gCrew = (await as('crew')).cookie;
    expect((await post(gCrew, '/api/issues', { vehicleId: 'v-02', title: 'x', severity: 'minor' })).status).toBe(200);
  });
  it('reports and the dispatcher feed are built from sync, which is per agency; a dispatcher sees only their own', async () => {
    const gd = (await as('dispatcher')).cookie;
    const bd = await (async () => { await makeUser('dispatcher', { agency: 'BB', email: 'd@b.test' }); return loginAs({ agency: 'BB', email: 'd@b.test', password: PASSWORD }); })();
    const g = await syncAll(gd), bb = await syncAll(bd);
    expect(syncIds(bb).filter((x) => x.startsWith('vehicles:'))).toEqual(['vehicles:' + B.vehicle]);
    expect(syncIds(g)).not.toContain('vehicles:' + B.vehicle);
    expect(g.data.workOrders.length).toBeGreaterThan(5);
    expect(bb.data.workOrders.map((x: any) => x.id)).toEqual([B.wo]);
  });
});

/**
 * Every endpoint that takes an id, used with the OTHER agency's id. The answer must be the same as for an id that does not exist at all, and
 * nothing may change.
 */
describe('ids from the other agency behave like unknown ids', () => {
  type Call = [string, string, string, any?];
  const same = async (cookie: string, calls: Call[], realIds: Record<string, string>) => {
    for (const [name, method, path, body] of calls) {
      const sub = (p: string, map: Record<string, string>) => p.replace(/\{(\w+)\}/g, (_, k) => map[k]);
      const other = await api(method, sub(path, realIds), { cookie, body: body ? JSON.parse(sub(JSON.stringify(body), realIds)) : undefined });
      const unknown = await api(method, sub(path, Object.fromEntries(Object.keys(realIds).map((k) => [k, 'zz-nope']))), { cookie, body: body ? JSON.parse(sub(JSON.stringify(body), Object.fromEntries(Object.keys(realIds).map((k) => [k, 'zz-nope'])))) : undefined });
      expect([other.status, other.json?.message ?? other.json?.error], name).toEqual([unknown.status, unknown.json?.message ?? unknown.json?.error]);
      expect([400, 404], `${name} -> ${other.status}`).toContain(other.status);
    }
  };
  const calls: Call[] = [
    ['edit vehicle', 'PATCH', '/api/vehicles/{vehicle}', { unit: 'HIJACK', make: 'x', model: 'y', baseId: '{base}' }],
    ['status', 'POST', '/api/vehicles/{vehicle}/status', { to: 'oos_repair', reason: 'x' }],
    ['readings', 'POST', '/api/vehicles/{vehicle}/readings', { hours: 5 }],
    ['move', 'POST', '/api/moves', { vehicleIds: ['{vehicle}'], toBaseId: '{base}', reason: 'x' }],
    ['report issue on other vehicle', 'POST', '/api/issues', { vehicleId: '{vehicle}', title: 'x', severity: 'minor' }],
    ['dismiss issue', 'POST', '/api/issues/{issue}/dismiss'],
    ['edit WO', 'PATCH', '/api/work-orders/{wo}', { notes: 'hijack' }],
    ['add line', 'POST', '/api/work-orders/{wo}/lines', { kind: 'labor', description: 'x', qty: 1, unitCost: 1 }],
    ['remove line', 'DELETE', '/api/work-orders/{wo}/lines/{line}'],
    ['transition WO', 'POST', '/api/work-orders/{wo}/transition', { action: 'cancel' }],
    ['create WO on other vehicle', 'POST', '/api/work-orders', { vehicleId: '{vehicle}', type: 'corrective' }],
    ['edit part', 'PUT', '/api/parts/{part}', { number: 'X', description: 'hijack' }],
    ['receive part', 'POST', '/api/parts/{part}/receive', { qty: 1, cost: 1 }],
    ['edit mechanic', 'PUT', '/api/mechanics/{mechanic}', { name: 'hijack' }],
    ['edit base', 'PUT', '/api/bases/{base}', { name: 'hijack' }],
    ['edit user', 'PUT', '/api/users/{user}', { name: 'Hijack', role: 'crew', baseIds: [] }],
    ['set password', 'POST', '/api/users/{user}/password', { password: 'hijacked-pass-99' }],
    ['deactivate user', 'POST', '/api/users/{user}/deactivate'],
    ['reactivate user', 'POST', '/api/users/{user}/reactivate'],
    ['user permissions', 'POST', '/api/users/{user}/permissions', { overrides: { report: false } }],
    ['invite user', 'POST', '/api/users/{user}/invite'],
    ['reset link', 'POST', '/api/users/{user}/reset-link'],
    ['download attachment', 'GET', '/api/attachments/{attachment}/file'],
    ['delete attachment', 'DELETE', '/api/attachments/{attachment}'],
  ];
  it('B using GEMA ids', async () => {
    await same(bAdmin, calls, { ...G, line: 'l-1' });
  });
  it('GEMA using B ids', async () => {
    await same(gAdmin, calls, { ...B });
  });
  it('nothing changed in either agency', async () => {
    await same(bAdmin, calls, { ...G, line: 'l-1' });
    await same(gAdmin, calls, { ...B });
    expect(await row('SELECT unit FROM vehicles WHERE id = ?', B.vehicle)).toEqual({ unit: 'ZZB-UNIT-1' });
    expect((await row('SELECT status FROM vehicles WHERE id = ?', B.vehicle)).status).not.toBe('oos_repair');
    expect((await row('SELECT status FROM work_orders WHERE id = ?', B.wo)).status).not.toBe('cancelled');
    expect((await row('SELECT status FROM issues WHERE id = ?', B.issue)).status).toBe('in_work_order');
    expect((await row('SELECT name FROM users WHERE id = ?', B.user)).name).toBe('B Crew');
    expect((await row('SELECT active FROM users WHERE id = ?', B.user)).active).toBe(1);
    expect(await row('SELECT 1 AS x FROM attachments WHERE id = ?', B.attachment)).toBeTruthy();
    expect((await row('SELECT unit FROM vehicles WHERE id = ?', 'v-02')).unit).not.toBe('HIJACK');
    expect((await row('SELECT status FROM work_orders WHERE id = ?', G.wo)).status).not.toBe('cancelled');
    expect(await row('SELECT 1 AS x FROM attachments WHERE id = ?', G.attachment)).toBeTruthy();
    expect((await row('SELECT COUNT(*) AS n FROM vehicles WHERE agency_id = ?', 'BB')).n).toBe(1);
    expect((await row('SELECT COUNT(*) AS n FROM audit_log WHERE agency_id = ? AND action = ?', 'BB', 'vehicle.update')).n).toBe(0);
  });
  it('new work orders and issues cannot name the other agency\'s records', async () => {
    const r1 = await post(bAdmin, '/api/work-orders', { vehicleId: B.vehicle, type: 'corrective', issueIds: [G.issue] });
    expect([400, 404]).toContain(r1.status);
    const r2 = await post(bAdmin, '/api/moves', { vehicleIds: [B.vehicle], toBaseId: G.base, reason: 'x' });
    expect([400, 404]).toContain(r2.status);
    const r3 = await post(bAdmin, '/api/work-orders/' + B.wo + '/lines', { kind: 'part', description: 'x', qty: 1, unitCost: 1, partId: G.part });
    expect([400, 404]).toContain(r3.status);
    const r4 = await post(bAdmin, '/api/work-orders', { vehicleId: B.vehicle, type: 'corrective', mechanicId: G.mechanic });
    expect([400, 404]).toContain(r4.status);
    const r5 = await post(bAdmin, '/api/users', { name: 'X', email: 'x@b.test', role: 'crew', baseIds: [G.base], password: 'long-enough-pass-1' });
    expect([400, 404]).toContain(r5.status);
    expect(await row("SELECT 1 AS x FROM users WHERE email = 'x@b.test'")).toBeNull();
  });
  it('attachments: the file stays in its own agency prefix, and uploads to the other agency\'s record fail', async () => {
    const a = await row('SELECT r2_key, agency_id FROM attachments WHERE id = ?', B.attachment);
    expect(a).toEqual({ r2_key: `attachments/BB/${B.attachment}`, agency_id: 'BB' });
    expect((await row('SELECT r2_key FROM attachments WHERE id = ?', G.attachment)).r2_key).toBe(`attachments/GEMA/${G.attachment}`);
    expect((await api('POST', '/api/attachments', { cookie: bAdmin, form: upForm(G.issue, 'x.png') })).status).toBe(404);
    expect((await api('POST', '/api/attachments', { cookie: gAdmin, form: upForm(B.issue, 'x.png') })).status).toBe(404);
    expect((await api('GET', `/api/attachments/${B.attachment}/file`, { cookie: bAdmin })).status).toBe(200);
    expect((await api('GET', `/api/attachments/${G.attachment}/file`, { cookie: gAdmin })).status).toBe(200);
    // even if a row's agency and the file's key disagree, the download checks the row's agency, not the key
    await E.DB.prepare('UPDATE attachments SET agency_id = ? WHERE id = ?').bind('GEMA', B.attachment).run();
    expect((await api('GET', `/api/attachments/${B.attachment}/file`, { cookie: bAdmin })).status).toBe(404);
  });
  it('a legacy attachment key without an agency prefix still downloads for its own agency', async () => {
    await E.FILES.put('attachments/legacy-1', png(), { httpMetadata: { contentType: 'image/png' } });
    await E.DB.prepare("INSERT INTO attachments (id, entity_type, entity_id, r2_key, name, content_type, size, created_by, created_at, updated_at, agency_id) VALUES ('legacy-1','issue',?,'attachments/legacy-1','old.png','image/png',33,'u',?,?,'GEMA')")
      .bind(G.issue, new Date().toISOString(), new Date().toISOString()).run();
    expect((await api('GET', '/api/attachments/legacy-1/file', { cookie: gAdmin })).status).toBe(200);
    expect((await api('GET', '/api/attachments/legacy-1/file', { cookie: bAdmin })).status).toBe(404);
  });
});

describe('the same email in two agencies', () => {
  it('is two separate accounts with separate passwords', async () => {
    must(await post(gAdmin, '/api/users', { name: 'Pat G', email: 'pat@both.test', role: 'crew', baseIds: [], password: 'pat-gema-password-1' }), 'g pat');
    must(await post(bAdmin, '/api/users', { name: 'Pat B', email: 'pat@both.test', role: 'crew', baseIds: [], password: 'pat-b-password-22' }), 'b pat');
    // duplicates inside one agency are still refused
    expect((await post(bAdmin, '/api/users', { name: 'Pat B2', email: 'PAT@both.test', role: 'crew', baseIds: [], password: 'pat-b-password-33' })).status).toBe(409);
    const g = await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@both.test', password: 'pat-gema-password-1' } });
    const bb = await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: 'pat@both.test', password: 'pat-b-password-22' } });
    expect(g.status).toBe(200); expect(bb.status).toBe(200);
    expect(g.json.user.id).not.toBe(bb.json.user.id);
    expect(g.json.user.name).toBe('Pat G'); expect(bb.json.user.name).toBe('Pat B');
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: 'pat@both.test', password: 'pat-gema-password-1' } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@both.test', password: 'pat-b-password-22' } })).status).toBe(401);
    // the session belongs to the agency it was created in
    expect((await syncAll(cookieOf(g))).agencyId).toBe('GEMA');
    expect((await syncAll(cookieOf(bb))).agencyId).toBe('BB');
    // changing one password does not touch the other account
    must(await post(bAdmin, `/api/users/${bb.json.user.id}/password`, { password: 'pat-b-changed-pass-4' }), 'b change');
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'pat@both.test', password: 'pat-gema-password-1' } })).status).toBe(200);
  });
  it('a lockout in one agency does not lock the same email in the other', async () => {
    must(await post(gAdmin, '/api/users', { name: 'Lee G', email: 'lee@both.test', role: 'crew', baseIds: [], password: 'lee-gema-password-1' }), 'g');
    must(await post(bAdmin, '/api/users', { name: 'Lee B', email: 'lee@both.test', role: 'crew', baseIds: [], password: 'lee-b-password-1' }), 'b');
    for (let i = 0; i < 10; i++) await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: 'lee@both.test', password: 'wrong-wrong-' + i } });
    const locked = await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: 'lee@both.test', password: 'lee-b-password-1' } });
    expect(locked.status).toBe(429);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'lee@both.test', password: 'lee-gema-password-1' } })).status).toBe(200);
  });
});

describe('the site owner\'s email', () => {
  it('in another agency is not a super user, and nobody there can create or change an account to use it', async () => {
    // a stray account with the owner's email in B (made directly, as if it predated the rule)
    await makeUser('system_admin', { agency: 'BB', email: SUPER_EMAIL, name: 'Stray' });
    const ck = await loginAs({ agency: 'BB', email: SUPER_EMAIL, password: PASSWORD });
    const me = await api('GET', '/api/auth/session', { cookie: ck });
    expect(me.json.user.isSuperuser).toBe(false);
    expect((await api('GET', '/api/agencies', { cookie: ck })).status).toBe(403);
    expect((await api('PUT', '/api/features', { cookie: ck, body: { uploads: true } })).status).toBe(403);
    expect((await api('GET', '/api/admin/backups', { cookie: ck })).status).toBe(403);
    // the real one still is
    expect((await api('GET', '/api/auth/session', { cookie: sup })).json.user.isSuperuser).toBe(true);
    // B's admin cannot create it, invite it or rename another account to it
    const make = await post(bAdmin, '/api/users', { name: 'Owner', email: SUPER_EMAIL.toUpperCase(), role: 'crew', baseIds: [], password: 'long-enough-pass-1' });
    expect(make.status).toBe(400);
    expect(make.json.code).toBe('reserved_email');
    expect((await post(bAdmin, '/api/users', { name: 'Owner', email: SUPER_EMAIL, role: 'crew', baseIds: [], invite: true })).status).toBe(400);
    // (an account's email cannot be edited at all; the check in checkTarget also covers a stray owner-email account in this agency)
    const stray = (await row('SELECT id FROM users WHERE agency_id = ? AND email = ?', 'BB', SUPER_EMAIL)).id;
    const edit = await api('PUT', '/api/users/' + stray, { cookie: bAdmin, body: { name: 'Edited', role: 'crew', baseIds: [] } });
    expect(edit.status).toBe(400);
    expect((await post(bAdmin, `/api/users/${stray}/password`, { password: 'hijacked-pass-99' })).status).toBe(400);
    expect((await row('SELECT name FROM users WHERE id = ?', stray)).name).toBe('Stray');
    expect((await row('SELECT email FROM users WHERE id = ?', B.user)).email).toBe('crew@b.test');
    // creating an agency whose first administrator uses the owner's email is refused too
    const ag = await post(sup, '/api/agencies', { code: 'OWN', name: 'Own', admin: { name: 'O', email: SUPER_EMAIL, password: PASSWORD } });
    expect(ag.status).toBe(400);
    expect(await row("SELECT 1 AS x FROM agencies WHERE id = 'OWN'")).toBeNull();
    // while the super user's session is inside B, the rule still holds
    must(await post(sup, '/api/agencies/BB/open'), 'open');
    expect((await post(sup, '/api/users', { name: 'Owner', email: SUPER_EMAIL, role: 'crew', baseIds: [], password: 'long-enough-pass-1' })).status).toBe(400);
  });
  it('SUPERUSER_AGENCY decides which agency is home (the email in the home agency is the only super account)', async () => {
    expect((await api('GET', '/api/agencies', { cookie: sup })).json.homeAgency).toBe('GEMA');
  });
});

describe('signing in with an Agency ID', () => {
  const login = (agencyId: any, email: string, password: string) => api('POST', '/api/auth/login', { body: { agencyId, email, password } });
  it('wrong agency, unknown agency, wrong email and wrong password all give the same answer', async () => {
    const real = (await as('crew', { email: 'real@gema.test' })).user;
    const answers = [
      await login('GEMA', real.email, 'not-the-password-1'),   // wrong password
      await login('GEMA', 'nobody@gema.test', PASSWORD),       // wrong email
      await login('BB', real.email, PASSWORD),                  // right account, wrong agency
      await login('NOPE', real.email, PASSWORD),               // unknown agency
      await login('bad code!', real.email, PASSWORD),          // not even a valid code
    ];
    for (const a of answers) expect([a.status, a.json], 'x').toEqual([401, answers[0].json]);
    expect(answers[0].json.code).toBe('bad_login');
    expect(JSON.stringify(answers[0].json)).not.toMatch(/agency (is|does)|inactive|unknown|not found/i);
    // an inactive agency: the same again
    must(await post(sup, '/api/agencies/BB/deactivate'), 'deactivate');
    const inactive = await login('BB', 'admin@b.test', PASSWORD);
    expect([inactive.status, inactive.json]).toEqual([401, answers[0].json]);
  });
  it('the code is trimmed and not case sensitive; a missing code is refused', async () => {
    expect((await login('  bb  ', 'admin@b.test', PASSWORD)).status).toBe(200);
    expect((await login('gema', SUPER_EMAIL, PASSWORD)).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { body: { email: 'admin@b.test', password: PASSWORD } })).status).toBeGreaterThanOrEqual(400);
  });
  it('a failed sign-in is recorded in the agency it was tried in, and not for an unknown agency', async () => {
    await login('BB', 'admin@b.test', 'wrong-wrong-1');
    await login('NOPE', 'x@nope.test', 'wrong-wrong-1');
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'auth.login_failed' AND agency_id = 'BB'")).toBeTruthy();
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'auth.login_failed' AND agency_id <> 'BB'")).toBeNull();
  });
  it('forgot password takes the Agency ID and always answers the same', async () => {
    const f = (agencyId: string, email: string) => api('POST', '/api/auth/forgot', { body: { agencyId, email } });
    const a = await f('BB', 'admin@b.test'), n1 = await f('BB', 'nobody@b.test'), n2 = await f('NOPE', 'admin@b.test'), n3 = await f('GEMA', 'admin@b.test');
    for (const r of [a, n1, n2, n3]) expect([r.status, r.json]).toEqual([a.status, a.json]);
    expect(a.status).toBe(200);
    expect((await api('POST', '/api/auth/forgot', { body: { email: 'admin@b.test' } })).status).toBe(400);
  });
});

describe('deactivating and reactivating an agency', () => {
  it('ends the agency\'s sessions at once, blocks sign-in, and leaves its data in place', async () => {
    expect((await api('GET', '/api/auth/session', { cookie: bAdmin })).json.user).toBeTruthy();
    must(await post(sup, '/api/agencies/BB/deactivate'), 'deactivate');
    expect((await api('GET', '/api/auth/session', { cookie: bAdmin })).json.user).toBeNull();
    expect((await api('GET', '/api/sync?since=0', { cookie: bAdmin })).status).toBe(401);
    expect((await row("SELECT COUNT(*) AS n FROM sessions WHERE agency_id = 'BB'")).n).toBe(0);
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: b.email, password: PASSWORD } })).status).toBe(401);
    expect((await post(sup, '/api/agencies/BB/open')).status).toBe(400);
    expect((await row('SELECT COUNT(*) AS n FROM vehicles WHERE agency_id = ?', 'BB')).n).toBe(1);
    // GEMA carries on
    expect((await syncAll(gAdmin)).data.vehicles.length).toBeGreaterThan(5);
    must(await post(sup, '/api/agencies/BB/reactivate'), 'reactivate');
    expect((await api('POST', '/api/auth/login', { body: { agencyId: 'BB', email: b.email, password: PASSWORD } })).status).toBe(200);
    expect((await syncAll(await loginAs(b))).data.vehicles).toHaveLength(1);
  });
  it('a super user who is viewing the agency is sent back to their own', async () => {
    must(await post(sup, '/api/agencies/BB/open'), 'open');
    expect((await syncAll(sup)).agencyId).toBe('BB');
    must(await post(sup, '/api/agencies/BB/deactivate'), 'deactivate');
    const s = await syncAll(sup);
    expect(s.agencyId).toBe('GEMA');
    expect(s.data.vehicles.some((v: any) => v.id === 'v-02')).toBe(true);
  });
});

describe('the super user opening another agency', () => {
  it('switches the session into B and back; changes made there are audited with the super user\'s email', async () => {
    const g = await syncAll(sup);
    expect(g.agencyId).toBe('GEMA');
    expect(g.me.agency.id).toBe('GEMA');
    const o = await post(sup, '/api/agencies/bb/open');
    expect(o.json.agency).toEqual({ id: 'BB', name: 'Bravo Ambulance' });
    const inB = await syncAll(sup);
    expect(inB.agencyId).toBe('BB');
    expect(inB.me).toMatchObject({ isSuperuser: true, agency: { id: 'BB', name: 'Bravo Ambulance' }, homeAgency: { id: 'GEMA' } });
    expect(syncIds(inB)).toContain('vehicles:' + B.vehicle);
    expect(syncIds(inB)).not.toContain('vehicles:v-02');
    expect(syncIds(inB).filter((x) => x.startsWith('people:'))).toContain('people:' + B.user);
    expect((await api('GET', '/api/users', { cookie: sup })).json.users.map((x: any) => x.email)).toContain('crew@b.test');
    // an edit made while inside B lands in B and is attributed to the super user
    must(await api('PUT', '/api/bases/' + B.base, { cookie: sup, body: { name: 'B Depot 2' } }), 'edit');
    expect((await row('SELECT name FROM bases WHERE id = ?', B.base)).name).toBe('B Depot 2');
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'base.update' AND agency_id = 'BB' AND user_email = ?", SUPER_EMAIL)).toBeTruthy();
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'agency.open' AND agency_id = 'BB' AND user_email = ?", SUPER_EMAIL)).toBeTruthy();
    // GEMA's ids do not work while inside B
    expect((await post(sup, '/api/vehicles/v-02/status', { to: 'oos_repair', reason: 'x' })).status).toBe(404);
    // the B administrator saw none of this as a switch of their own session
    expect((await syncAll(bAdmin)).agencyId).toBe('BB');
    // back
    const back = await post(sup, '/api/agencies/back');
    expect(back.json.agency).toEqual({ id: 'GEMA', name: 'GEMA' });
    const home = await syncAll(sup);
    expect(home.agencyId).toBe('GEMA');
    expect(syncIds(home)).toContain('vehicles:v-02');
    expect(syncIds(home)).not.toContain('vehicles:' + B.vehicle);
    expect(await row("SELECT 1 AS x FROM audit_log WHERE action = 'agency.close' AND user_email = ?", SUPER_EMAIL)).toBeTruthy();
    // a second login starts at home again (the switch belongs to one session)
    must(await post(sup, '/api/agencies/BB/open'), 'open again');
    const fresh = await loginAs({ agency: 'GEMA', email: SUPER_EMAIL, password: PASSWORD });
    expect((await syncAll(fresh)).agencyId).toBe('GEMA');
  });
  it('the activity history inside B shows only B', async () => {
    must(await post(sup, '/api/agencies/BB/open'), 'open');
    const r = (await api('GET', '/api/admin/activity?limit=200', { cookie: sup })).json.rows;
    expect(r.some((x: any) => x.entityId === B.vehicle)).toBe(true);
    expect(r.some((x: any) => x.entityId === 'v-02')).toBe(false);
  });
  it('a plain user cannot open an agency or switch the session', async () => {
    expect((await post(bAdmin, '/api/agencies/GEMA/open')).status).toBe(403);
    expect((await post(gAdmin, '/api/agencies/BB/open')).status).toBe(403);
    expect((await syncAll(bAdmin)).agencyId).toBe('BB');
    expect((await syncAll(gAdmin)).agencyId).toBe('GEMA');
    // a hand-made acting_agency_id on a non-super session is ignored
    await E.DB.prepare("UPDATE sessions SET acting_agency_id = 'GEMA' WHERE agency_id = 'BB'").run();
    expect((await syncAll(bAdmin)).agencyId).toBe('BB');
  });
});

describe('only the super user may manage agencies', () => {
  it('everybody else gets 403, logged-out gets 401', async () => {
    const roles = ['system_admin', 'fleet_manager', 'viewer'];
    const cookies = [gAdmin, bAdmin, ...(await Promise.all(roles.map((r) => as(r)))).map((x) => x.cookie)];
    const calls: [string, string, any?][] = [
      ['GET', '/api/agencies'], ['POST', '/api/agencies', { code: 'ZED', name: 'Z', admin: { name: 'A', email: 'a@z.test', password: PASSWORD } }],
      ['PATCH', '/api/agencies/BB', { name: 'Hacked' }], ['POST', '/api/agencies/BB/open'], ['POST', '/api/agencies/back'],
      ['POST', '/api/agencies/BB/deactivate'], ['POST', '/api/agencies/BB/reactivate'],
    ];
    for (const ck of cookies) for (const [m, p, body] of calls) expect((await api(m, p, { cookie: ck, body })).status, `${m} ${p}`).toBe(403);
    for (const [m, p, body] of calls) expect((await api(m, p, { body })).status, `anon ${m} ${p}`).toBe(401);
    expect((await row("SELECT name FROM agencies WHERE id = 'BB'")).name).toBe('Bravo Ambulance');
    expect(await row("SELECT 1 AS x FROM agencies WHERE id = 'ZED'")).toBeNull();
    expect((await row('SELECT active FROM agencies WHERE id = ?', 'BB')).active).toBe(1);
  });
  it('the backup list and sample removal are not reachable across agencies either', async () => {
    expect((await api('GET', '/api/admin/backups', { cookie: bAdmin })).status).toBe(403);
    // removing sample data in B touches nothing in GEMA
    const before = (await row("SELECT COUNT(*) AS n FROM vehicles WHERE agency_id = 'GEMA'")).n;
    await post(bAdmin, '/api/admin/sample/remove');
    expect((await row("SELECT COUNT(*) AS n FROM vehicles WHERE agency_id = 'GEMA'")).n).toBe(before);
  });
});

describe('work order numbers and counters are per agency', () => {
  it('B starts at WO-0001 whatever GEMA has reached', async () => {
    const bNums = (await syncAll(bAdmin)).data.workOrders.map((w: any) => w.number);
    expect(bNums).toEqual(['WO-0001']);
    const gMax = (await syncAll(gAdmin)).data.workOrders.length;
    expect(gMax).toBeGreaterThan(5);
    const gNew = must(await post(gAdmin, '/api/work-orders', { vehicleId: 'v-02', type: 'corrective' }), 'g wo');
    expect(gNew.number).toBe('WO-' + String(gMax + 1).padStart(4, '0'));
    const bNew = must(await post(bAdmin, '/api/work-orders', { vehicleId: B.vehicle, type: 'inspection' }), 'b wo');
    expect(bNew.number).toBe('WO-0002');
    // the same vehicle unit name can exist in both agencies
    const unit = (await syncAll(gAdmin)).data.vehicles[0].unit;
    must(await post(bAdmin, '/api/vehicles', { unit, make: 'Ford', model: 'T', baseId: B.base, pmStart: 'never' }), 'same unit in B');
    expect((await post(bAdmin, '/api/vehicles', { unit: unit.toLowerCase(), make: 'Ford', model: 'T', baseId: B.base, pmStart: 'never' })).status).toBe(409);
  });
});

describe('the database', () => {
  it('every agency-owned row in the tests carries an agency and nothing is left over without one', async () => {
    for (const t of ['bases', 'vehicles', 'issues', 'work_orders', 'work_order_lines', 'parts', 'mechanics', 'users', 'attachments', 'audit_log', 'settings', 'meter_readings', 'status_events', 'tombstones']) {
      const r = await rows(`SELECT agency_id, COUNT(*) AS n FROM ${t} GROUP BY agency_id`);
      for (const x of r) expect(['GEMA', 'BB'], `${t}: ${x.agency_id}`).toContain(x.agency_id);
    }
    // B's rows exist in B and GEMA's rows exist in GEMA (nothing was filed under the default by mistake)
    for (const t of ['bases', 'vehicles', 'issues', 'work_orders', 'parts', 'mechanics', 'attachments']) {
      expect((await row(`SELECT COUNT(*) AS n FROM ${t} WHERE agency_id = 'BB'`)).n, t).toBe(1);
    }
    expect((await row("SELECT COUNT(*) AS n FROM work_order_lines WHERE agency_id = 'BB'")).n).toBe(1);
    expect((await row("SELECT COUNT(*) AS n FROM wo_issue_links WHERE agency_id = 'BB'")).n).toBe(1);
  });
});
