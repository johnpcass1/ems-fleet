import { describe, it, expect, beforeEach } from 'vitest';
import { api, as, seedDemo, syncAll, row, byId, E, setUploads, rows, superCookie } from './helpers';

const pdf = () => new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const webp = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
function form(bytes: Uint8Array, name: string, type: string, entityType = 'issue', entityId = 'i-04') {
  const f = new FormData();
  f.set('entity_type', entityType);
  f.set('entity_id', entityId);
  f.set('file', new File([bytes], name, { type }));
  return f;
}
let fm: string, crew: string, sup: string, viewer: string, dispatcher: string;
beforeEach(async () => {
  await seedDemo();
  fm = (await as('fleet_manager')).cookie;
  crew = (await as('crew')).cookie;
  sup = (await as('base_supervisor', { baseIds: ['b-hq'] })).cookie;
  viewer = (await as('viewer')).cookie;
  dispatcher = (await as('dispatcher')).cookie;
  await setUploads(fm, true); // uploads are off by default; the tests below cover the switch itself in 'uploads switch'
});
const up = (cookie: string, f: FormData) => api('POST', '/api/attachments', { cookie, form: f });

describe('upload', () => {
  it('accepts a real PDF, PNG, JPEG and WebP and stores them in R2', async () => {
    for (const [bytes, name, type] of [[pdf(), 'report.pdf', 'application/pdf'], [png(), 'a.png', 'image/png'], [jpeg(), 'a.jpg', 'image/jpeg'], [webp(), 'a.webp', 'image/webp']] as const) {
      const r = await up(crew, form(bytes, name, type));
      expect(r.status, name).toBe(200);
      expect(r.json.type).toBe(type);
      const a = await row('SELECT * FROM attachments WHERE id = ?', r.json.id);
      expect(a).toMatchObject({ entity_type: 'issue', entity_id: 'i-04', name, content_type: type, size: bytes.length });
      expect(a.r2_key).toBe('attachments/' + r.json.id);
      expect(await E.FILES.head(a.r2_key)).toBeTruthy();
    }
  });
  it('shows up on the parent record in sync and bumps its change counter', async () => {
    const c0 = (await syncAll(fm)).cursor;
    const r = await up(crew, form(pdf(), 'report.pdf', 'application/pdf'));
    const s = await syncAll(fm, c0);
    const issue = byId(s.data.issues, 'i-04');
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0]).toMatchObject({ assetId: r.json.id, name: 'report.pdf', type: 'application/pdf' });
    expect(issue.attachments[0].by).toBeTruthy();
  });
  it('rejects a spoofed type: HTML or text declared as PDF/PNG', async () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect((await up(crew, form(html, 'x.pdf', 'application/pdf'))).status).toBe(415);
    expect((await up(crew, form(html, 'x.png', 'image/png'))).status).toBe(415);
    expect((await up(crew, form(html, 'x.html', 'text/html'))).status).toBe(415);
    expect((await up(crew, form(html, 'x.bin', ''))).status).toBe(415);
  });
  it('rejects a real file declared as the wrong type', async () => {
    const r = await up(crew, form(png(), 'x.pdf', 'application/pdf'));
    expect(r.status).toBe(415);
    expect(r.json.code).toBe('type_mismatch');
    expect((await row('SELECT COUNT(*) n FROM attachments')).n).toBe(0);
    expect((await E.FILES.list()).objects.length).toBe(0);
  });
  it('rejects empty files and files over 20 MB', async () => {
    expect((await up(crew, form(new Uint8Array(0), 'e.pdf', 'application/pdf'))).status).toBe(400);
    const big = new Uint8Array(21 * 1024 * 1024);
    big.set(pdf());
    const r = await up(crew, form(big, 'big.pdf', 'application/pdf'));
    expect(r.status).toBe(413);
    expect(r.json.code).toBe('too_large');
    const ok = new Uint8Array(20 * 1024 * 1024);
    ok.set(pdf());
    expect((await up(crew, form(ok, 'ok.pdf', 'application/pdf'))).status).toBe(200);
  });
  it('sanitises the file name', async () => {
    const r = await up(crew, form(pdf(), '..\\..\\evil"name;<x>.pdf', 'application/pdf'));
    expect(r.status).toBe(200);
    expect(r.json.name).not.toMatch(/[\\"<>;]/);
  });
  it('needs a login, the CSRF header, a known record and the right to edit it', async () => {
    expect((await up('', form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(401);
    expect((await api('POST', '/api/attachments', { cookie: crew, form: form(pdf(), 'a.pdf', 'application/pdf'), noCsrf: true })).status).toBe(403);
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf', 'issue', 'nope'))).status).toBe(404);
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf', 'vehicle', 'v-01'))).status).toBe(400);
    expect((await up(viewer, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    expect((await up(dispatcher, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    // crew limited to HQ cannot attach to a problem on a Lethem unit; i-01 is on v-12 (Linden)
    const hqCrew = (await as('crew', { baseIds: ['b-hq'] })).cookie;
    expect((await up(hqCrew, form(pdf(), 'a.pdf', 'application/pdf', 'issue', 'i-01'))).status).toBe(403);
    expect((await up(hqCrew, form(pdf(), 'a.pdf', 'application/pdf', 'issue', 'i-04'))).status).toBe(200);
  });
  it('work order files: assigned mechanic and supervisors yes; other mechanics and crew no', async () => {
    const own = (await as('mechanic', { mechanicId: 'm-1' })).cookie;
    const other = (await as('mechanic', { mechanicId: 'm-2' })).cookie;
    const f = () => form(pdf(), 'quote.pdf', 'application/pdf', 'work_order', 'wo-14');
    expect((await up(own, f())).status).toBe(200);
    expect((await up(other, f())).status).toBe(403);
    expect((await up(crew, f())).status).toBe(403);
    expect((await up(sup, f())).status).toBe(200);
    const wo = byId((await syncAll(fm)).data.workOrders, 'wo-14');
    expect(wo.attachments).toHaveLength(2);
  });
});

describe('download', () => {
  async function stored() {
    const r = await up(crew, form(pdf(), 'Service report \u00fc.pdf', 'application/pdf'));
    return r.json.id as string;
  }
  it('is refused when logged out', async () => {
    const id = await stored();
    expect((await api('GET', `/api/attachments/${id}/file`)).status).toBe(401);
  });
  it('streams with the right headers for logged-in staff', async () => {
    const id = await stored();
    for (const c of [crew, viewer, sup, fm]) {
      const r = await api('GET', `/api/attachments/${id}/file`, { cookie: c });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('content-disposition')).toMatch(/^inline; filename="Service report _\.pdf"; filename\*=UTF-8''Service%20report%20%C3%BC\.pdf$/);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('cache-control')).toMatch(/^private/);
      expect(new Uint8Array(await r.res.arrayBuffer())).toEqual(pdf());
    }
  });
  it('is not available to the dispatcher', async () => {
    const id = await stored();
    expect((await api('GET', `/api/attachments/${id}/file`, { cookie: dispatcher })).status).toBe(403);
  });
  it('images keep their type and a locked-down CSP', async () => {
    const r1 = await up(crew, form(png(), 'p.png', 'image/png'));
    const r = await api('GET', `/api/attachments/${r1.json.id}/file`, { cookie: viewer });
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
  });
  it('unknown id is a 404', async () => {
    expect((await api('GET', '/api/attachments/f-nope/file', { cookie: fm })).status).toBe(404);
  });
});

describe('delete', () => {
  it('only fleet managers and admins can delete; it removes the row and the R2 object', async () => {
    const r = await up(crew, form(pdf(), 'a.pdf', 'application/pdf'));
    const id = r.json.id;
    const key = (await row('SELECT r2_key k FROM attachments WHERE id = ?', id)).k;
    for (const c of [crew, sup, viewer, dispatcher]) expect((await api('DELETE', `/api/attachments/${id}`, { cookie: c })).status).toBe(403);
    expect(await E.FILES.head(key)).toBeTruthy();
    const c0 = (await syncAll(fm)).cursor;
    expect((await api('DELETE', `/api/attachments/${id}`, { cookie: fm })).status).toBe(200);
    expect(await row('SELECT 1 FROM attachments WHERE id = ?', id)).toBeNull();
    expect(await E.FILES.head(key)).toBeNull();
    const s = await syncAll(fm, c0);
    expect(byId(s.data.issues, 'i-04').attachments).toBeUndefined(); // the parent was refreshed
    expect((await api('GET', `/api/attachments/${id}/file`, { cookie: fm })).status).toBe(404);
    expect((await row("SELECT COUNT(*) n FROM audit_log WHERE action = 'attachment.delete'")).n).toBe(1);
  });
});

describe('uploads switch (Features, super user only)', () => {
  const reset = async () => { await E.DB.prepare('DELETE FROM settings').run(); await E.DB.prepare('DELETE FROM attachments').run(); };
  const putSettings = (cookie: string, extra: object = {}) => api('PUT', '/api/settings', { cookie, body: { approvalThresholdGYD: 150000, dueSoonHours: 25, dueSoonDays: 14, comebackDays: 30, ...extra } });
  const r2Count = async () => (await E.FILES.list()).objects.length;

  it('is off by default: 403 uploads_disabled, nothing in R2, nothing in the attachments table', async () => {
    await reset(); // a fresh database: no settings document at all
    const r = await up(crew, form(pdf(), 'a.pdf', 'application/pdf'));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'uploads_disabled', message: 'Photo and PDF uploads are turned off for now.' });
    expect((await row('SELECT COUNT(*) n FROM attachments')).n).toBe(0);
    expect(await r2Count()).toBe(0);
  });
  it('a settings document without features counts as off, on the server and in what clients receive', async () => {
    await E.DB.prepare("UPDATE settings SET data = '{\"approvalThresholdGYD\":150000}' WHERE id = 'main'").run();
    await setUploads(null, false); // writes features.uploads = false next to the old keys
    await E.DB.prepare("UPDATE settings SET data = '{\"approvalThresholdGYD\":150000}' WHERE id = 'main'").run();
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    expect((await syncAll(fm)).data.settings[0].features).toBeUndefined(); // the browser reads a missing key as off
    expect((await syncAll(dispatcher)).data.settings[0].features).toEqual({ uploads: false });
    await E.DB.prepare("UPDATE settings SET data = '{\"features\":{\"uploads\":\"yes\"}}' WHERE id = 'main'").run();
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403); // junk is not "on"
  });
  it('is refused before the body is read: an oversized or malformed upload gets 403, not 413 or 400', async () => {
    await setUploads(null, false);
    const big = new Uint8Array(21 * 1024 * 1024); big.set(pdf());
    expect((await up(crew, form(big, 'big.pdf', 'application/pdf'))).status).toBe(403);
    expect((await api('POST', '/api/attachments', { cookie: crew, body: { nope: 1 } })).json.error).toBe('uploads_disabled');
    expect(await r2Count()).toBe(0);
  });
  it('the super user can turn it on and off; the change is audited and uploads follow it', async () => {
    const su = await superCookie();
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(200); // beforeEach turned it on
    expect((await api('PUT', '/api/features', { cookie: su, body: { uploads: false } })).status).toBe(200);
    expect((await up(crew, form(pdf(), 'b.pdf', 'application/pdf'))).status).toBe(403);
    expect((await syncAll(fm)).data.settings[0].features.uploads).toBe(false);
    const log = await rows("SELECT user_email, before_json, after_json FROM audit_log WHERE action = 'features.update' ORDER BY id");
    const last = log[log.length - 1];
    expect(last.user_email).toBe('johnpcass3@gmail.com');
    expect(JSON.parse(last.before_json).uploads).toBe(true);
    expect(JSON.parse(last.after_json).uploads).toBe(false);
  });
  it('even the super user cannot upload while the switch is off', async () => {
    await setUploads(null, false);
    const su = await superCookie();
    expect((await up(su, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    expect((await up(su, form(pdf(), 'a.pdf', 'application/pdf'))).json.error).toBe('uploads_disabled');
  });
  it('only the super user can change features: fleet managers, system admins and everyone else get 403', async () => {
    await setUploads(null, false);
    const admin = (await as('system_admin')).cookie;
    for (const c of [fm, admin, crew, sup, viewer, dispatcher, (await as('mechanic', { mechanicId: 'm-1' })).cookie]) {
      expect((await api('PUT', '/api/features', { cookie: c, body: { uploads: true } })).status).toBe(403);
    }
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    expect((await api('PUT', '/api/features', { cookie: '', body: { uploads: true } })).status).toBe(401);
    expect((await api('PUT', '/api/features', { cookie: await superCookie(), body: { uploads: 'yes' } })).status).toBe(400);
  });
  it('the ordinary settings save cannot change features, even with a crafted request', async () => {
    await setUploads(null, false);
    const admin = (await as('system_admin')).cookie;
    for (const c of [fm, admin]) {
      expect((await putSettings(c, { features: { uploads: true }, uploadsEnabled: true, dueSoonDays: 21 })).status).toBe(200);
      expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(403);
    }
    const s = (await syncAll(fm)).data.settings[0];
    expect(s.dueSoonDays).toBe(21); // the real settings did save
    expect(s.features.uploads).toBe(false);
    expect(s.uploadsEnabled).toBeUndefined();
    // and turning it on is not undone by a later ordinary save
    await setUploads(null, true);
    expect((await putSettings(fm, { dueSoonDays: 22 })).status).toBe(200);
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(200);
  });
  it('with the switch on, only people with the upload permission can upload; the permission can be granted and revoked', async () => {
    expect((await up(crew, form(pdf(), 'a.pdf', 'application/pdf'))).status).toBe(200);
    const target = await row("SELECT id FROM users WHERE role = 'crew' LIMIT 1");
    expect((await api('POST', `/api/users/${target.id}/permissions`, { cookie: fm, body: { overrides: { upload: false } } })).status).toBe(200);
    const r = await up(crew, form(pdf(), 'b.pdf', 'application/pdf'));
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('forbidden');
    const vTarget = await row("SELECT id FROM users WHERE role = 'viewer' LIMIT 1");
    expect((await api('POST', `/api/users/${vTarget.id}/permissions`, { cookie: fm, body: { overrides: { upload: true, report: true } } })).status).toBe(200);
    expect((await up(viewer, form(pdf(), 'c.pdf', 'application/pdf'))).status).toBe(200);
  });
  it('existing files can still be downloaded and deleted while uploads are off', async () => {
    const id = (await up(crew, form(pdf(), 'keep.pdf', 'application/pdf'))).json.id as string;
    const png1 = (await up(crew, form(png(), 'p.png', 'image/png'))).json.id as string;
    await setUploads(null, false);
    const g = await api('GET', `/api/attachments/${id}/file`, { cookie: viewer });
    expect(g.status).toBe(200);
    expect(new Uint8Array(await g.res.arrayBuffer())).toEqual(pdf());
    expect(byId((await syncAll(fm)).data.issues, 'i-04').attachments).toHaveLength(2);
    expect((await api('DELETE', `/api/attachments/${id}`, { cookie: crew })).status).toBe(403);
    expect((await api('DELETE', `/api/attachments/${id}`, { cookie: fm })).status).toBe(200);
    expect((await api('DELETE', `/api/attachments/${png1}`, { cookie: fm })).status).toBe(200);
    expect(await r2Count()).toBe(0);
  });
  it('reporting a problem works with uploads off (no files attached)', async () => {
    await setUploads(null, false);
    const r = await api('POST', '/api/issues', { cookie: crew, body: { vehicleId: 'v-01', title: 'Wiper stuck', description: '', severity: 'minor', hours: null } });
    expect(r.status).toBe(200);
    const iss = (await syncAll(fm)).data.issues.find((i: any) => i.title === 'Wiper stuck');
    expect(iss).toBeTruthy();
    expect(iss.attachments ?? []).toHaveLength(0);
  });
});
