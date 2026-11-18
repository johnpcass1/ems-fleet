/**
 * The demo (src/demo): the real API running on an in-memory database filled with the GEMA sample fleet.
 * Checks that it starts, that every demo person sees what their role allows, that changes stay in memory, and that the things
 * the demo must never do (uploads, turning uploads on, backups, agencies, passwords) are refused.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoServer, DEMO_PEOPLE, type DemoServer } from '../../src/demo/server';
import { ROLE_LIST } from '../../src/shared/constants';

const dir = join(__dirname, '../../migrations');
const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(dir, f), 'utf8'));
const SQL = await initSqlJs();

const call = async (d: DemoServer, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'X-Requested-With': 'gema-fleet' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await d.fetch(new Request('https://anywhere.example/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

describe('demo', () => {
  let d: DemoServer;
  beforeEach(async () => { d = await createDemoServer(SQL, migrations); });

  it('has one person for every role, and starts as the fleet manager', async () => {
    expect(DEMO_PEOPLE.map((p) => p.role).sort()).toEqual([...ROLE_LIST].sort());
    const s = await call(d, 'GET', '/auth/session');
    expect(s.json.user.role).toBe('fleet_manager');
    expect(s.json.user.agency.id).toBe('GEMA');
    expect(s.json.user.isSuperuser).toBeFalsy();
  });

  it('loads the GEMA sample fleet and a bus check list', async () => {
    const r = await call(d, 'GET', '/sync?since=0');
    expect(r.status).toBe(200);
    expect(r.json.data.vehicles.length).toBeGreaterThan(10);
    expect(r.json.data.vehicles.every((v: any) => v.sample)).toBe(true);
    expect(r.json.data.workOrders.length).toBeGreaterThan(5);
    expect(r.json.data.busCheckLists.length).toBe(1);
    expect(r.json.data.settings.find((s: any) => s.id === 'GEMA').features?.uploads === true).toBe(false); // missing means off
  });

  it('every demo person can sign in and gets what their role allows', async () => {
    for (const p of DEMO_PEOPLE) {
      await d.switchTo(p.id);
      const s = await call(d, 'GET', '/auth/session');
      expect(s.json.user.role).toBe(p.role);
      const r = await call(d, 'GET', '/sync?since=0');
      expect(r.status).toBe(200);
      if (p.role === 'dispatcher') expect(r.json.data.parts).toBeUndefined(); // the dispatch view only: no parts or costs
      if (p.role === 'mechanic') expect(r.json.data.workOrders.every((w: any) => w.mechanicId === 'm-2')).toBe(true);
    }
  });

  it('changes work, follow the real rules, and stay in this copy only', async () => {
    const v = (await call(d, 'GET', '/sync?since=0')).json.data.vehicles[0];
    const ok = await call(d, 'POST', `/vehicles/${v.id}/status`, { to: v.status === 'oos_repair' ? 'in_service' : 'oos_repair', reason: 'Demo test' });
    expect(ok.status).toBe(200);
    const after = (await call(d, 'GET', '/sync?since=0')).json.data.vehicles.find((x: any) => x.id === v.id);
    expect(after.status).not.toBe(v.status);
    // the viewer is refused by the real permission rules
    await d.switchTo('demo-viewer');
    expect((await call(d, 'POST', `/vehicles/${v.id}/status`, { to: v.status, reason: 'x' })).status).toBe(403);
    // a new demo starts from the sample data again
    const fresh = await createDemoServer(SQL, migrations);
    const again = (await call(fresh, 'GET', '/sync?since=0')).json.data.vehicles.find((x: any) => x.id === v.id);
    expect(again.status).toBe(v.status);
  });

  it('refuses uploads, the uploads switch, backups, agencies and passwords, even for the system administrator', async () => {
    await d.switchTo('demo-system-admin');
    const form = new FormData();
    form.set('file', new Blob(['x'], { type: 'application/pdf' }), 'a.pdf');
    const up = await d.fetch(new Request('https://x/api/attachments', { method: 'POST', headers: { 'X-Requested-With': 'gema-fleet' }, body: form }));
    expect(up.status).toBe(403);
    for (const [m, p, b] of [['PUT', '/features', { uploads: true }], ['GET', '/admin/backups'], ['POST', '/admin/backups/step', {}], ['POST', '/agencies', { id: 'X', name: 'X' }],
      ['POST', '/auth/login', { agencyId: 'GEMA', email: 'a@b.c', password: 'x' }], ['POST', '/auth/change-password', { currentPassword: 'a', newPassword: 'b' }],
      ['POST', '/users/demo-crew/password', { password: 'abcdefghijk' }], ['POST', '/admin/sample/remove', {}]] as const) {
      const r = await call(d, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.code).toBe('demo');
    }
    const s = (await call(d, 'GET', '/sync?since=0')).json.data.settings.find((x: any) => x.id === 'GEMA');
    expect(s.features?.uploads === true).toBe(false);
  });
});
