import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, makeUser, superCookie, seedDemo, row, rows, E, PASSWORD, SUPER_EMAIL, loginAs } from './helpers';
import { Tx } from '../../src/worker/db';
import { EXPORT_MAX } from '../../src/worker/activity';
import { env } from 'cloudflare:workers';

const A = '/api/admin/activity';
let n = 0;
/** Insert audit rows directly, with the time we want. */
async function put(r: { at: string; user?: string | null; email?: string | null; action?: string; et?: string; eid?: string | null; before?: any; after?: any }) {
  await E.DB.prepare('INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, before_json, after_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(r.at, r.user ?? null, r.email ?? null, r.action ?? 'vehicle.update', r.et ?? 'vehicle', r.eid ?? `e${++n}`, r.before ? JSON.stringify(r.before) : null, r.after ? JSON.stringify(r.after) : null, r.at, r.at).run();
}
/** Logging in writes an audit row; start the test from an empty log once the people are signed in. */
const clearAudit = () => E.DB.prepare('DELETE FROM audit_log').run();
const get = (cookie: string, qs = '') => api('GET', `${A}${qs ? '?' + qs : ''}`, { cookie });
const ids = (r: any) => r.json.rows.map((x: any) => x.id);

describe('access', () => {
  it('super user and system administrator get 200; everybody else 403; logged-out 401', async () => {
    const sup = await superCookie();
    const sa = (await as('system_admin')).cookie;
    for (const c of [sup, sa]) {
      expect((await get(c)).status).toBe(200);
      expect((await api('GET', `${A}/export`, { cookie: c })).status).toBe(200);
      expect((await api('GET', '/api/admin/audit', { cookie: c })).status).toBe(200);
    }
    for (const role of ['fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer']) {
      const c = (await as(role, { baseIds: [] })).cookie;
      expect((await get(c)).status, role).toBe(403);
      expect((await api('GET', `${A}/export`, { cookie: c })).status, role + ' export').toBe(403);
      expect((await api('GET', '/api/admin/audit', { cookie: c })).status, role + ' audit').toBe(403);
    }
    expect((await api('GET', A)).status).toBe(401);
    expect((await api('GET', `${A}/export`)).status).toBe(401);
  });
  it('a super user whose role is not an admin role still gets in (the rule is isSuper || system_admin)', async () => {
    await makeUser('viewer', { email: SUPER_EMAIL });
    expect((await get(await loginAs({ email: SUPER_EMAIL, password: PASSWORD }))).status).toBe(200);
  });
});

describe('filters and paging', () => {
  let sup: string;
  beforeEach(async () => { sup = await superCookie(); await clearAudit(); });

  it('returns newest first with the actor, category and parsed before/after', async () => {
    const u = await makeUser('crew', { name: 'Jane Doe' });
    await put({ at: '2026-11-01T15:00:00.000Z', user: u.id, email: u.email, action: 'vehicle.move', before: { baseId: 'b-hq' }, after: { baseId: 'b-linden' } });
    await put({ at: '2026-11-02T15:00:00.000Z', user: u.id, email: u.email, action: 'wo.close', et: 'work_order' });
    const r = await get(sup, 'userId=' + u.id);
    expect(r.json.rows.map((x: any) => x.action)).toEqual(['wo.close', 'vehicle.move']);
    expect(r.json.rows[1]).toMatchObject({ category: 'vehicles', before: { baseId: 'b-hq' }, after: { baseId: 'b-linden' }, actor: { id: u.id, name: 'Jane Doe', email: u.email, role: 'crew', active: true, isSuper: false } });
    expect(r.json.hasMore).toBe(false);
  });
  it('resolves the CURRENT name, shows deactivated people, and falls back to the stored id', async () => {
    const u = await makeUser('crew', { name: 'Old Name' });
    await put({ at: '2026-11-01T15:00:00.000Z', user: u.id, email: u.email });
    await E.DB.prepare('UPDATE users SET name = ?, active = 0 WHERE id = ?').bind('New Name', u.id).run();
    await put({ at: '2026-11-02T15:00:00.000Z', user: 'u-gone-forever', email: 'gone@x.org' });
    await put({ at: '2026-11-03T15:00:00.000Z', user: null, email: 'create-admin script' });
    const r = (await get(sup, 'limit=10')).json.rows;
    expect(r[2].actor).toMatchObject({ name: 'New Name', active: false });
    expect(r[1].actor).toMatchObject({ id: 'u-gone-forever', name: 'u-gone-forever', email: 'gone@x.org', role: null });
    expect(r[0].actor).toBeNull();
    expect(r[0].email).toBe('create-admin script');
  });
  it('marks the super user', async () => {
    await get(sup); // creates the super account
    await put({ at: '2026-11-01T15:00:00.000Z', user: (await row('SELECT id FROM users WHERE email = ?', SUPER_EMAIL)).id, email: SUPER_EMAIL });
    expect((await get(sup)).json.rows[0].actor.isSuper).toBe(true);
  });
  it('filters by person', async () => {
    const a = await makeUser('crew'), b = await makeUser('crew');
    await put({ at: '2026-11-01T15:00:00.000Z', user: a.id }); await put({ at: '2026-11-01T16:00:00.000Z', user: b.id }); await put({ at: '2026-11-01T17:00:00.000Z', user: b.id });
    expect((await get(sup, 'userId=' + b.id)).json.rows).toHaveLength(2);
    expect((await get(sup, 'userId=' + a.id)).json.rows).toHaveLength(1);
  });
  it('filters by type (category), including attachments by what they are attached to', async () => {
    const t = '2026-11-01T15:00:00.000Z';
    await put({ at: t, action: 'vehicle.move' }); await put({ at: t, action: 'reading.log' }); await put({ at: t, action: 'issue.report', et: 'issue' }); await put({ at: t, action: 'wo.start', et: 'work_order' });
    await put({ at: t, action: 'attachment.add', et: 'issue' }); await put({ at: t, action: 'attachment.add', et: 'work_order' }); await put({ at: t, action: 'program.update', et: 'pm_program' });
    await put({ at: t, action: 'part.create', et: 'part' }); await put({ at: t, action: 'user.update', et: 'user' }); await put({ at: t, action: 'features.update', et: 'settings' });
    await put({ at: t, action: 'auth.login', et: 'user' }); await put({ at: t, action: 'backup.run', et: 'backup' });
    const cnt = async (type: string) => (await get(sup, 'type=' + type)).json.rows.length;
    expect(await cnt('vehicles')).toBe(2); expect(await cnt('problems')).toBe(2); expect(await cnt('work_orders')).toBe(2); expect(await cnt('pm')).toBe(1);
    expect(await cnt('parts_mechanics')).toBe(1); expect(await cnt('people')).toBe(1); expect(await cnt('settings')).toBe(1); expect(await cnt('sign_ins')).toBe(1); expect(await cnt('backups')).toBe(1);
    expect((await get(sup, 'type=nonsense')).status).toBe(400);
  });
  it('filters by item (entityType + entityId); entityId alone is refused', async () => {
    await put({ at: '2026-11-01T15:00:00.000Z', et: 'vehicle', eid: 'v-02' }); await put({ at: '2026-11-01T16:00:00.000Z', et: 'vehicle', eid: 'v-03' }); await put({ at: '2026-11-01T17:00:00.000Z', et: 'work_order', eid: 'v-02' });
    expect((await get(sup, 'entityType=vehicle&entityId=v-02')).json.rows).toHaveLength(1);
    expect((await get(sup, 'entityType=work_order&entityId=v-02')).json.rows).toHaveLength(1);
    expect((await get(sup, 'entityType=vehicle')).json.rows).toHaveLength(2);
    expect((await get(sup, 'entityId=v-02')).status).toBe(400);
  });
  it('date range is in Guyana time (UTC-4), both ends included', async () => {
    // Guyana 9 Nov 23:59:59 = 10 Nov 03:59:59 UTC ; Guyana 10 Nov 00:00 = 04:00 UTC ; Guyana 10 Nov 23:59:59 = 11 Nov 03:59:59 UTC
    await put({ at: '2026-11-10T03:59:59.999Z', eid: 'nov9-late' }); await put({ at: '2026-11-10T04:00:00.000Z', eid: 'nov10-start' });
    await put({ at: '2026-11-11T03:59:59.999Z', eid: 'nov10-end' }); await put({ at: '2026-11-11T04:00:00.000Z', eid: 'nov11-start' });
    const eids = async (qs: string) => (await get(sup, qs)).json.rows.map((x: any) => x.entityId).sort();
    expect(await eids('from=2026-11-10&to=2026-11-10')).toEqual(['nov10-end', 'nov10-start']);
    expect(await eids('from=2026-11-10')).toEqual(['nov10-end', 'nov10-start', 'nov11-start']);
    expect(await eids('to=2026-11-09')).toEqual(['nov9-late']);
    expect(await eids('from=2026-11-09&to=2026-11-09')).toEqual(['nov9-late']);
    expect((await get(sup, 'from=2026-11-12&to=2026-11-10')).status).toBe(400);
    expect((await get(sup, 'from=10/11/2026')).status).toBe(400);
  });
  it('free text matches the action, the item id, the person (name and email), the unit name and the work order number', async () => {
    await seedDemo();
    const u = await makeUser('crew', { name: 'Zelda Quimby' });
    await put({ at: '2026-11-01T15:00:00.000Z', user: u.id, email: u.email, action: 'part.create', et: 'part', eid: 'p-xyz' });
    await put({ at: '2026-11-01T16:00:00.000Z', action: 'vehicle.move', et: 'vehicle', eid: 'v-02' });
    await put({ at: '2026-11-01T17:00:00.000Z', action: 'wo.close', et: 'work_order', eid: 'wo-09' });
    const unit = (await row("SELECT unit FROM vehicles WHERE id = 'v-02'")).unit, num = (await row("SELECT number FROM work_orders WHERE id = 'wo-09'")).number;
    const find = async (q: string) => (await get(sup, 'q=' + encodeURIComponent(q))).json.rows.map((x: any) => x.entityId);
    expect(await find('part.create')).toEqual(['p-xyz']);
    expect(await find('p-xyz')).toEqual(['p-xyz']);
    expect(await find('zelda')).toEqual(['p-xyz']);
    expect(await find(u.email)).toEqual(['p-xyz']);
    expect(await find(unit)).toEqual(['v-02']);
    expect(await find(num)).toEqual(['wo-09']);
    expect(await find('nothing-matches-this')).toEqual([]);
    expect(await find('%')).toEqual([]); // wildcards are literal
    expect((await find('vehicle.')).length).toBe(1);
  });
  it('combines filters', async () => {
    const a = await makeUser('crew'); const t = '2026-11-10T15:00:00.000Z';
    await put({ at: t, user: a.id, action: 'vehicle.move', eid: 'x1' }); await put({ at: t, user: a.id, action: 'wo.close', et: 'work_order', eid: 'x2' }); await put({ at: t, action: 'vehicle.move', eid: 'x3' });
    const r = await get(sup, `userId=${a.id}&type=vehicles&from=2026-11-10&to=2026-11-10`);
    expect(r.json.rows.map((x: any) => x.entityId)).toEqual(['x1']);
  });
  it('pages 50 at a time, newest first, with a cursor and no gaps or repeats (also across equal times)', async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 120; i++) stmts.push(E.DB.prepare("INSERT INTO audit_log (at, action, entity_type, entity_id, created_at, updated_at) VALUES (?, 'vehicle.update', 'vehicle', ?, ?, ?)").bind(`2026-11-0${1 + (i % 3)}T12:00:00.000Z`, `p${i}`, 'x', 'x'));
    await E.DB.batch(stmts);
    const p1 = (await get(sup)).json;
    expect(p1.rows).toHaveLength(50); expect(p1.hasMore).toBe(true); expect(p1.nextBefore).toBe(p1.rows[49].id);
    const p2 = (await get(sup, 'before=' + p1.nextBefore)).json;
    const p3 = (await get(sup, 'before=' + p2.nextBefore)).json;
    expect(p2.rows).toHaveLength(50); expect(p3.rows).toHaveLength(20); expect(p3.hasMore).toBe(false); expect(p3.nextBefore).toBeNull();
    const all = [...p1.rows, ...p2.rows, ...p3.rows];
    expect(new Set(all.map((x: any) => x.id)).size).toBe(120);
    const sorted = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
    expect(all.map((x: any) => x.id)).toEqual(sorted.map((x: any) => x.id));
    expect((await get(sup, 'before=abc')).status).toBe(400);
    expect((await get(sup, 'before=99999999')).status).toBe(400);
    expect((await get(sup, 'limit=10')).json.rows).toHaveLength(10);
    expect((await get(sup, 'limit=9999')).json.rows).toHaveLength(120);
  });
  it('real writes show up with who did them', async () => {
    await seedDemo();
    const fm = await as('fleet_manager', { name: 'Fran Manager' });
    await api('POST', '/api/moves', { cookie: fm.cookie, body: { vehicleIds: ['v-02'], toBaseId: 'b-linden' } });
    const r = (await get(sup, 'type=vehicles')).json.rows;
    expect(r[0]).toMatchObject({ action: 'vehicle.move', entityId: 'v-02', after: { baseId: 'b-linden' }, actor: { name: 'Fran Manager', role: 'fleet_manager' } });
  });
});

describe('sign-in history', () => {
  const login = (email: string, password: string) => api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email, password } });
  const allAudit = async () => JSON.stringify(await rows('SELECT * FROM audit_log'));

  it('records successful sign-ins and sign-outs with no password', async () => {
    const u = await makeUser('crew');
    const r = await login(u.email, PASSWORD);
    await api('POST', '/api/auth/logout', { cookie: (r.headers.get('set-cookie') || '').split(';')[0] });
    const a = await rows('SELECT user_id, user_email, action, entity_type, entity_id, before_json, after_json FROM audit_log ORDER BY id');
    expect(a.map((x: any) => x.action)).toEqual(['auth.login', 'auth.logout']);
    expect(a[0]).toMatchObject({ user_id: u.id, user_email: u.email, entity_type: 'user', entity_id: u.id });
    expect(await allAudit()).not.toContain(PASSWORD);
  });
  it('records a failed sign-in for an unknown address: the address tried, no user, no password', async () => {
    const r = await login('Nobody@Example.org', 'my-secret-guess-77');
    expect(r.status).toBe(401);
    const a = await rows('SELECT * FROM audit_log');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'auth.login_failed', user_id: null, user_email: 'nobody@example.org', entity_id: null });
    expect(await allAudit()).not.toContain('my-secret-guess-77');
  });
  it('records a failed sign-in for a real account with that account as the user', async () => {
    const u = await makeUser('crew');
    await login(u.email, 'wrong-password-1');
    const a = await row("SELECT * FROM audit_log WHERE action = 'auth.login_failed'");
    expect(a).toMatchObject({ user_id: u.id, user_email: u.email, entity_id: u.id });
    expect(await allAudit()).not.toContain('wrong-password-1');
  });
  it('does not keep text that is not an email address (a password typed into the email box)', async () => {
    await login('hunter2-my-real-password', 'x');
    const a = await row("SELECT user_email FROM audit_log WHERE action = 'auth.login_failed'");
    expect(a.user_email).toBe('(not an email address)');
    expect(await allAudit()).not.toContain('hunter2');
  });
  it('the failure that locks the account also writes auth.locked, once; later attempts add nothing', async () => {
    const u = await makeUser('crew');
    for (let i = 0; i < 9; i++) await login(u.email, 'wrong-' + i);
    expect((await row("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.locked'")).n).toBe(0);
    expect((await login(u.email, 'wrong-9')).status).toBe(401);
    expect((await row("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.login_failed'")).n).toBe(10);
    const locked = await rows("SELECT * FROM audit_log WHERE action = 'auth.locked'");
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ user_id: u.id, user_email: u.email });
    expect(JSON.parse(locked[0].after_json)).toEqual({ minutes: 15, fails: 10 });
    const before = (await row('SELECT COUNT(*) n FROM audit_log')).n;
    expect((await login(u.email, PASSWORD)).status).toBe(429);
    expect((await row('SELECT COUNT(*) n FROM audit_log')).n).toBe(before);
    expect(await allAudit()).not.toMatch(/wrong-\d/);
  });
  it('shows up in the activity list under Sign-ins', async () => {
    const u = await makeUser('crew');
    const sup = await superCookie();
    await login(u.email, 'nope-nope-nope'); await login(u.email, PASSWORD);
    const r = (await get(sup, 'type=sign_ins&userId=' + u.id)).json.rows;
    expect(r.map((x: any) => x.action)).toEqual(['auth.login', 'auth.login_failed']);
  });
});

describe('the audit writer never stores secrets', () => {
  it('strips password, hash, token and session keys even when a caller passes them', async () => {
    const tx = new Tx(E.DB, { id: 'u1', email: 'a@x.org', agencyId: 'GEMA' } as any);
    tx.audit('test.secret', 'user', 'u1',
      { name: 'x', password: 'pw-before', password_hash: 'hash-before', nested: { token: 'tok-before', keep: 1 } },
      { name: 'y', newPassword: 'pw-after', token_hash: 'th', session: { id: 'sess-after', user: 'u1' }, list: [{ resetToken: 'rt', ok: true }], link: 'https://x/set-password#t=LinkSecret_123' });
    await tx.commit();
    const a = await row("SELECT before_json, after_json FROM audit_log WHERE action = 'test.secret'");
    expect(JSON.parse(a.before_json)).toEqual({ name: 'x', nested: { keep: 1 } });
    expect(JSON.parse(a.after_json)).toEqual({ name: 'y', list: [{ ok: true }], link: 'https://x/set-password#t=[removed]' });
    expect(a.before_json + a.after_json).not.toMatch(/pw-|hash-|tok-|sess-|LinkSecret|"rt"/);
  });
  it('and the list answer is sanitised again on the way out (rows written before this existed)', async () => {
    const sup = await superCookie(); await clearAudit();
    await put({ at: '2026-11-01T15:00:00.000Z', after: { ok: 1, password: 'old-leak', token: 't0k' } });
    const r = await get(sup);
    expect(r.json.rows[0].after).toEqual({ ok: 1 });
  });
  it('no audit row written by the real admin flows contains a password or a link secret', async () => {
    const fm = (await as('system_admin')).cookie;
    const made = await api('POST', '/api/users', { cookie: fm, body: { name: 'N P', email: 'np@gema.test', role: 'crew', baseIds: [], password: 'Initial-pass-word-1' } });
    expect(made.status).toBe(200);
    await api('POST', `/api/users/${made.json.id}/password`, { cookie: fm, body: { password: 'Another-pass-word-2' } });
    await api('POST', '/api/auth/change-password', { cookie: fm, body: { currentPassword: PASSWORD, newPassword: 'Third-pass-word-3' } });
    const dump = JSON.stringify(await rows('SELECT * FROM audit_log'));
    expect(dump).not.toMatch(/pass-word|Initial|Another|Third|pbkdf2/);
    expect(await row("SELECT COUNT(*) n FROM audit_log WHERE action IN ('user.create','user.set_password','auth.change_password')")).toMatchObject({ n: 3 });
  });
});

describe('CSV export', () => {
  const csv = async (cookie: string, qs = '') => {
    const r = await api('GET', `${A}/export${qs ? '?' + qs : ''}`, { cookie });
    const bytes = new Uint8Array(await r.res.arrayBuffer());
    return { r, bytes, text: new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes) };
  };
  it('is a CSV download of the current filtered view with readable sentences', async () => {
    await seedDemo();
    const sup = await superCookie();
    const fm = await as('fleet_manager', { name: 'Fran Manager' });
    await clearAudit();
    await api('POST', '/api/moves', { cookie: fm.cookie, body: { vehicleIds: ['v-02'], toBaseId: 'b-linden' } });
    await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: 'nobody@example.org', password: 'x' } });
    const { r, text, bytes } = await csv(sup, 'type=vehicles');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // a byte-order mark, so Excel reads it as UTF-8
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="fleet-activity-gema-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(text.startsWith('﻿When (Guyana time),Person,Email,Role,Type,What happened')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Fran Manager,.*,Fleet manager,Vehicles,Moved GEMA-\d+ from .* to Linden,vehicle\.move,vehicle,v-02/);
    expect(r.headers.get('x-activity-rows')).toBe('1');
    expect(r.headers.get('x-activity-truncated')).toBe('0');
    const all = (await csv(sup)).text;
    expect(all).toContain('Failed sign-in for nobody@example.org');
    expect((await csv(sup, 'type=nonsense')).r.status).toBe(400);
    const none = await csv(sup, 'q=zzz-nothing');
    expect(none.text.trim().split('\r\n')).toHaveLength(1);
  });
  it('respects person, item and date filters', async () => {
    const sup = await superCookie(); await clearAudit();
    const a = await makeUser('crew', { name: 'Ann A' });
    await put({ at: '2026-11-10T15:00:00.000Z', user: a.id, eid: 'in-range' }); await put({ at: '2026-11-12T15:00:00.000Z', user: a.id, eid: 'out-range' }); await put({ at: '2026-11-10T15:00:00.000Z', eid: 'other-person' });
    const t = (await csv(sup, `userId=${a.id}&from=2026-11-10&to=2026-11-10`)).text;
    expect(t).toContain('in-range'); expect(t).not.toContain('out-range'); expect(t).not.toContain('other-person');
    expect((await csv(sup, 'entityType=vehicle&entityId=other-person')).text).toContain('other-person');
  });
  it('keeps spreadsheet programs from running formulas typed into the email box', async () => {
    await api('POST', '/api/auth/login', { body: { agencyId: 'GEMA', email: '=cmd|calc@evil.org', password: 'x' } });
    const { text } = await csv(await superCookie(), 'type=sign_ins');
    expect(text).toContain("'=cmd|calc@evil.org");
    expect(text).not.toMatch(/,=cmd/);
  });
  it(`stops at ${EXPORT_MAX} rows, newest first, and says so`, async () => {
    const sup = await superCookie(); await clearAudit();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < EXPORT_MAX + 120; i++) stmts.push(E.DB.prepare("INSERT INTO audit_log (at, action, entity_type, entity_id, created_at, updated_at) VALUES (?, 'vehicle.update', 'vehicle', ?, 'x', 'x')").bind(new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), `bulk-${i}`));
    for (let i = 0; i < stmts.length; i += 500) await E.DB.batch(stmts.slice(i, i + 500));
    const { r, text } = await csv(sup);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(EXPORT_MAX + 1);
    expect(r.headers.get('x-activity-rows')).toBe(String(EXPORT_MAX));
    expect(r.headers.get('x-activity-truncated')).toBe('1');
    expect(lines[1]).toContain(`bulk-${EXPORT_MAX + 119}`); // newest
    expect(text).not.toContain('bulk-119,'); // the oldest 120 are cut
    // narrowing the dates gets them
    const old = await csv(sup, 'from=2026-01-01&to=2026-01-01');
    expect(old.r.headers.get('x-activity-truncated')).toBe('0');
  }, 60000);
});

describe('migration 0004', () => {
  it('applies on a database that already has audit rows, keeps them, and the queries use the new indexes', async () => {
    // put the database back the way 0003 left it, with data in it
    await E.DB.batch([E.DB.prepare('DROP INDEX IF EXISTS idx_audit_user_at'), E.DB.prepare('DROP INDEX IF EXISTS idx_audit_entity_at'), E.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id)')]);
    for (let i = 0; i < 30; i++) await put({ at: `2026-11-0${1 + (i % 9)}T12:00:00.000Z`, user: i % 2 ? 'u-a' : 'u-b', eid: `m${i}` });
    const mig = ((env as any).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith('0004_'));
    expect(mig).toBeTruthy();
    await E.DB.batch(mig!.queries.map((q) => E.DB.prepare(q)));
    expect((await row('SELECT COUNT(*) n FROM audit_log')).n).toBe(30);
    const idx = (await rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'")).map((x: any) => x.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_audit_at', 'idx_audit_user_at', 'idx_audit_entity_at']));
    expect(idx).not.toContain('idx_audit_entity');
    const plan = async (sql: string, ...p: unknown[]) => JSON.stringify(await rows('EXPLAIN QUERY PLAN ' + sql, ...p));
    expect(await plan("SELECT * FROM audit_log WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 51", 'u-a')).toContain('idx_audit_user_at');
    expect(await plan("SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY at DESC, id DESC LIMIT 51", 'vehicle', 'm1')).toContain('idx_audit_entity_at');
    expect(await plan("SELECT * FROM audit_log WHERE at >= ? AND at < ? ORDER BY at DESC, id DESC LIMIT 51", 'a', 'b')).toContain('idx_audit_at');
    // running it twice is harmless
    await E.DB.batch(mig!.queries.map((q) => E.DB.prepare(q)));
    expect((await row('SELECT COUNT(*) n FROM audit_log')).n).toBe(30);
  });
});
