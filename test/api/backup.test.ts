import { describe, it, expect, beforeEach } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { api, as, seedDemo, E } from './helpers';
import { backupStep, listBackups, BACKUP_TABLES, KEEP_BACKUPS } from '../../src/worker/backup';
import worker from '../../src/worker/index';

// The file is several gzip members joined together (see src/worker/backup.ts). Node's zlib, gzip, 7-Zip and Python
// read that as one stream; the browser-style DecompressionStream in this runtime does not, so use node:zlib here.
async function gunzip(buf: ArrayBuffer): Promise<string> {
  return gunzipSync(Buffer.from(buf)).toString('utf8');
}
async function runAll(now: Date, force = false) {
  let last: any, steps = 0;
  do { last = await backupStep(E, { now, force: force && steps === 0 }); steps++; } while (last.status === 'running' && steps < 200);
  return { last, steps };
}
beforeEach(async () => { await seedDemo(); });

describe('nightly backup', () => {
  it('writes one valid gzip JSON file with every table, in many small steps', async () => {
    const day = new Date('2026-11-05T07:00:00Z');
    const { last, steps } = await runAll(day);
    expect(last).toMatchObject({ status: 'done', date: '2026-11-05', key: 'backups/2026-11-05.json.gz' });
    expect(steps).toBeGreaterThan(BACKUP_TABLES.length - 1); // one small piece per table at least
    const obj = await E.FILES.get('backups/2026-11-05.json.gz');
    expect(obj).toBeTruthy();
    const bytes = await obj!.arrayBuffer();
    const u8 = new Uint8Array(bytes);
    expect([u8[0], u8[1]]).toEqual([0x1f, 0x8b]); // gzip magic
    const json = JSON.parse(await gunzip(bytes));
    expect(json.app).toBe('gema-fleet');
    expect(Object.keys(json.tables)).toEqual(BACKUP_TABLES);
    expect(json.tables.vehicles).toHaveLength(20);
    expect(json.tables.work_orders).toHaveLength(15);
    expect(json.tables.work_order_lines.length).toBeGreaterThan(20);
    expect(json.tables.vehicle_pm).toHaveLength(239);
    expect(json.tables.vehicles[0].unit).toBeTruthy();
    expect(json.tables.counter[0].v).toBeGreaterThan(0);
    // working files are cleaned up
    const tmp = await E.FILES.list({ prefix: 'backups/tmp/' });
    expect(tmp.objects).toHaveLength(0);
  });
  it('does not include login sessions, but does include users and the audit log', async () => {
    await as('fleet_manager');
    await runAll(new Date('2026-11-06T07:00:00Z'));
    const json = JSON.parse(await gunzip(await (await E.FILES.get('backups/2026-11-06.json.gz'))!.arrayBuffer()));
    expect(json.tables.sessions).toBeUndefined();
    expect(json.tables.login_attempts).toBeUndefined();
    expect(json.tables.users).toHaveLength(1);
    expect(json.tables.audit_log.length).toBeGreaterThan(0);
  });
  it('splits big tables into chunks and still produces valid JSON', async () => {
    const stmts: D1PreparedStatement[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 2500; i++) stmts.push(E.DB.prepare('INSERT INTO login_attempts (email, at_ms, ok, created_at, updated_at) VALUES (?,?,0,?,?)').bind('x@y', i, now, now));
    for (let i = 0; i < 2500; i += 500) stmts.push(E.DB.prepare('SELECT 1'));
    await E.DB.batch(stmts.filter((s, i) => i < 2500));
    // audit_log is a backed-up table with an auto-increment id: fill it
    const a: D1PreparedStatement[] = [];
    for (let i = 0; i < 2300; i++) a.push(E.DB.prepare("INSERT INTO audit_log (at, action, entity_type, created_at, updated_at) VALUES (?, 'seed', 'x', ?, ?)").bind(now, now, now));
    await E.DB.batch(a);
    const { steps } = await runAll(new Date('2026-11-07T07:00:00Z'));
    const json = JSON.parse(await gunzip(await (await E.FILES.get('backups/2026-11-07.json.gz'))!.arrayBuffer()));
    expect(json.tables.audit_log).toHaveLength(2300);
    expect(steps).toBeGreaterThanOrEqual(BACKUP_TABLES.length + 2);
    expect(json.tables.audit_log[2299].action).toBe('seed');
  });
  it('is idempotent for the day, and "force" makes a fresh one', async () => {
    const day = new Date('2026-11-08T07:00:00Z');
    await runAll(day);
    expect((await backupStep(E, { now: day })).status).toBe('idle');
    const again = await runAll(day, true);
    expect(again.last.status).toBe('done');
  });
  it('keeps only the newest 30 backups', async () => {
    for (let d = 1; d <= 34; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`.replace('2026-09-31', '2026-10-01').replace(/^2026-09-3[1-4]$/, '2026-10-0' + (d - 30));
      await E.FILES.put(`backups/${date}.json.gz`, new Uint8Array([0x1f, 0x8b, 8, 0]));
    }
    expect((await listBackups(E)).length).toBe(34);
    await runAll(new Date('2026-11-09T07:00:00Z'));
    const left = await listBackups(E);
    expect(left).toHaveLength(KEEP_BACKUPS);
    expect(left[0].date).toBe('2026-11-09');
    // the oldest ones are the ones that went
    expect(left.some((b) => b.date === '2026-09-01')).toBe(false);
    expect(left.some((b) => b.date === '2026-09-05')).toBe(false);
  });
  it('the scheduled (cron) entry point runs one step', async () => {
    const ctxWaits: Promise<unknown>[] = [];
    await (worker as any).scheduled({}, E, { waitUntil: (p: Promise<unknown>) => ctxWaits.push(p) });
    await Promise.all(ctxWaits);
    const job = await E.DB.prepare('SELECT status, state FROM backup_jobs').first<any>();
    expect(job.status).toBe('running');
    expect(JSON.parse(job.state).n).toBe(1);
  });
  it('cleans up pieces left by an unfinished backup from an earlier day', async () => {
    await E.FILES.put('backups/tmp/2026-01-01/00000.gz', new Uint8Array([1]));
    await backupStep(E, { now: new Date('2026-11-10T07:00:00Z') });
    expect(await E.FILES.head('backups/tmp/2026-01-01/00000.gz')).toBeNull();
  });
});

describe('backup admin API', () => {
  it('lists, runs, downloads; only for the system administrator', async () => {
    const admin = (await as('system_admin')).cookie;
    const fm = (await as('fleet_manager')).cookie;
    expect((await api('GET', '/api/admin/backups', { cookie: fm })).status).toBe(403);
    expect((await api('POST', '/api/admin/backups/step', { cookie: fm, body: {} })).status).toBe(403);
    let r: any; let guard = 0;
    do { r = (await api('POST', '/api/admin/backups/step', { cookie: admin, body: {} })).json; } while (r.status === 'running' && ++guard < 200);
    expect(r.status).toBe('done');
    const list = await api('GET', '/api/admin/backups', { cookie: admin });
    expect(list.json.backups).toHaveLength(1);
    const date = list.json.backups[0].date;
    expect(list.json.backups[0].size).toBeGreaterThan(100);
    const dl = await api('GET', `/api/admin/backups/${date}`, { cookie: admin });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="gema-fleet-\d{4}-\d{2}-\d{2}\.json\.gz"/);
    const json = JSON.parse(await gunzip(await dl.res.arrayBuffer()));
    expect(json.tables.vehicles).toHaveLength(20);
    expect((await api('GET', '/api/admin/backups/not-a-date', { cookie: admin })).status).toBe(400);
    expect((await api('GET', '/api/admin/backups/2020-01-01', { cookie: admin })).status).toBe(404);
  });
});
