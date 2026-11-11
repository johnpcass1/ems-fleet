import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ACTIVITY_CATEGORIES, CATEGORY_KEYS, CATEGORY_RULES, categoryOf, dayLabel, describe as describeRow, describePlain, diffFields, dmy, formatValue, gyDayEndISO, gyDayStartISO, NO_LOOKUP,
  sanitizeAudit, timeHM, truncate, csvSafe, type Lookup,
} from '../../src/shared/activity';

const L: Lookup = {
  ...NO_LOOKUP,
  unit: (id) => ({ v3: 'GEMA-03', v12: 'GEMA-12' } as any)[id] ?? null,
  wo: (id) => ({ wo12: 'WO-0012' } as any)[id] ?? null,
  base: (id) => ({ hq: 'HQ', linden: 'Linden', b3: 'Berbice' } as any)[id] ?? null,
  person: (id) => ({ u1: 'Jane Doe' } as any)[id] ?? null,
  mechanic: (id) => ({ m1: 'Ravi' } as any)[id] ?? null,
  part: (id) => ({ p1: 'P-1001' } as any)[id] ?? null,
  issue: (id) => (id === 'i1' ? { title: 'Siren dead', vehicleId: 'v3' } : null),
};
const row = (action: string, entityType: string, entityId: string | null, before: any = null, after: any = null, extra: any = {}) => ({ action, entityType, entityId, before, after, ...extra });
const say = (r: any, lk: Lookup = L) => describePlain(r, lk);

describe('describer sentences', () => {
  it('bus checks', () => {
    expect(say(row('buscheck.submit', 'bus_check', 'c1', null, { vehicleId: 'v3', unit: 'GEMA-03', shortages: 2, problems: 3 }))).toBe('Submitted a bus check on GEMA-03 with 2 shortages and 3 vehicle problems sent to maintenance');
    expect(say(row('buscheck.submit', 'bus_check', 'c1', null, { vehicleId: 'v3', unit: 'GEMA-03', shortages: 0, problems: 0 }))).toBe('Submitted a bus check on GEMA-03 with no shortages');
    expect(say(row('buschecklist.create', 'bus_check_list', 'l1', null, { starter: true, items: 79 }))).toBe('Started the bus check requirements from the standard list (79 items)');
    expect(say(row('buschecklist.deactivate', 'bus_check_list', 'l1', { name: 'Box' }, { name: 'Box' }))).toBe("Made the bus check list 'Box' inactive");
  });
  it('moves, status, readings, problems', () => {
    expect(say(row('vehicle.move', 'vehicle', 'v3', { baseId: 'hq' }, { baseId: 'linden', tempUntil: null }))).toBe('Moved GEMA-03 from HQ to Linden');
    expect(say(row('vehicle.move', 'vehicle', 'v3', { baseId: 'hq' }, { baseId: 'linden', tempUntil: '2026-11-20' }))).toBe('Moved GEMA-03 from HQ to Linden until 20/11/2026');
    expect(say(row('vehicle.status', 'vehicle', 'v3', { status: 'in_service' }, { status: 'oos_repair', reason: 'Brakes' }))).toBe('Changed GEMA-03 from In service to Out: repair (Brakes)');
    expect(say(row('reading.log', 'vehicle', 'v3', { engineHours: 1 }, { hours: 1234, flagged: false }))).toBe('Logged 1,234 engine hours on GEMA-03');
    expect(say(row('issue.report', 'issue', 'i9', null, { vehicleId: 'v12', title: 'Transmission slipping', severity: 'critical' }))).toBe('Reported a critical problem on GEMA-12: Transmission slipping');
    expect(say(row('issue.report', 'issue', 'i9', null, { vehicleId: 'v12', title: 'x', severity: 'minor' }))).toBe('Reported a minor problem on GEMA-12: x');
    expect(say(row('issue.dismiss', 'issue', 'i1'))).toBe("Dismissed the problem 'Siren dead' on GEMA-03");
  });
  it('work orders', () => {
    expect(say(row('wo.create', 'work_order', 'wo12', null, { number: 'WO-0012', vehicleId: 'v3' }))).toBe('Opened work order WO-0012 for GEMA-03');
    expect(say(row('wo.close', 'work_order', 'wo12', { status: 'completed' }, { status: 'closed' }))).toBe('Closed work order WO-0012');
    expect(say(row('wo.hold', 'work_order', 'wo12', null, { status: 'on_hold', reason: 'parts' }))).toBe('Put work order WO-0012 on hold (Waiting for parts)');
    expect(say(row('wo.schedule', 'work_order', 'wo12', null, { scheduledFor: '2026-11-12' }))).toBe('Scheduled work order WO-0012 for 12/11/2026');
    expect(say(row('wo.update', 'work_order', 'wo12', { priority: 'normal', mechanicId: null, notes: '' }, { priority: 'high' }))).toBe('Updated work order WO-0012 (priority)');
    // a work order that was removed (sample data) still reads sensibly, with its stored number
    expect(say(row('wo.create', 'work_order', 'gone', null, { number: 'WO-0007', vehicleId: 'v3' }))).toBe('Opened work order WO-0007 for GEMA-03');
    expect(say(row('wo.approve', 'work_order', 'gone'), L)).toBe('Approved a work order');
  });
  it('people, roles and permissions', () => {
    expect(say(row('user.update', 'user', 'u1', { name: 'Jane Doe', role: 'crew', baseIds: [] }, { name: 'Jane Doe', role: 'base_supervisor', baseIds: [] }))).toBe("Changed Jane Doe's role from Crew to Base supervisor");
    expect(say(row('user.update', 'user', 'u1', { name: 'Jane Doe', role: 'crew', baseIds: ['hq'] }, { name: 'Jane Doe', role: 'crew', baseIds: ['hq', 'linden'] }))).toBe("Changed Jane Doe's bases to HQ, Linden");
    expect(say(row('user.update', 'user', 'u1', { name: 'Jane Doe', role: 'crew', baseIds: [] }, { name: 'Jane Doe', role: 'mechanic', baseIds: ['hq'] }))).toBe('Updated Jane Doe (role, bases)');
    expect(say(row('user.create', 'user', 'u1', null, { name: 'Jane Doe', email: 'j@x.org', role: 'crew' }))).toBe('Added Jane Doe as Crew');
    expect(say(row('user.deactivate', 'user', 'u1', { active: true }, { active: false }))).toBe('Deactivated Jane Doe');
    expect(say(row('role.permissions', 'role', 'crew', { role: 'crew', overrides: {} }, { role: 'crew', overrides: { report: false } }))).toBe("Turned off 'Report problems' for Crew");
    expect(say(row('role.permissions', 'role', 'crew', { role: 'crew', overrides: { report: false } }, { role: 'crew', overrides: {} }))).toBe("Put 'Report problems' back to the default for Crew");
    expect(say(row('role.permissions', 'role', 'crew', { overrides: {} }, { overrides: { report: false, move: true } }))).toBe('Changed 2 permissions for Crew');
    expect(say(row('user.permissions', 'user', 'u1', { email: 'j@x.org', overrides: {} }, { email: 'j@x.org', overrides: { move: true } }))).toBe("Turned on 'Move units between bases' for Jane Doe");
    expect(say(row('role.reset', 'role', 'crew'))).toBe('Put Crew permissions back to the defaults');
  });
  it('sign-ins, settings, features', () => {
    expect(say(row('auth.login', 'user', 'u1'))).toBe('Signed in');
    expect(say(row('auth.logout', 'user', 'u1'))).toBe('Signed out');
    expect(say(row('auth.login_failed', 'user', null, null, null, { email: 'jdoe@example.org' }))).toBe('Failed sign-in for jdoe@example.org');
    expect(say(row('auth.locked', 'user', null, null, { minutes: 15 }, { email: 'jdoe@example.org' }))).toBe('Locked jdoe@example.org for 15 minutes after too many wrong passwords');
    expect(say(row('features.update', 'settings', 'main', { uploads: false }, { uploads: true }))).toBe('Turned photo and PDF uploads on');
    expect(say(row('features.update', 'settings', 'main', { uploads: true }, { uploads: false }))).toBe('Turned photo and PDF uploads off');
    expect(say(row('settings.update', 'settings', 'main', { approvalThresholdGYD: 100, comebackDays: 30, features: { uploads: true } }, { approvalThresholdGYD: 200, comebackDays: 30, features: { uploads: true } }))).toBe('Changed settings (approval threshold)');
    expect(say(row('backup.run', 'backup', '2026-11-10'))).toBe('Ran a backup');
  });
  it('parts, mechanics, bases', () => {
    expect(say(row('part.receive', 'part', 'p1', null, { onHand: 9, received: 5, cost: 12000 }))).toBe('Received 5 of part P-1001 at G$ 12,000 each');
    expect(say(row('mechanic.create', 'mechanic', 'm9', null, { name: 'Ravi' }))).toBe('Added mechanic Ravi');
    expect(say(row('base.update', 'base', 'hq', null, { name: 'HQ' }))).toBe('Updated base HQ');
  });
  it('links: names that still exist are linked, others are plain text', () => {
    const segs = describeRow(row('vehicle.move', 'vehicle', 'v3', { baseId: 'hq' }, { baseId: 'linden' }), L);
    expect(segs.find((s) => s.k === 'unit')).toMatchObject({ id: 'v3', v: 'GEMA-03' });
    expect(describeRow(row('vehicle.move', 'vehicle', 'gone', { baseId: 'hq' }, { baseId: 'linden' }), L).some((s) => s.id)).toBe(false);
    expect(describeRow(row('wo.close', 'work_order', 'wo12'), L).find((s) => s.k === 'wo')).toMatchObject({ id: 'wo12', v: 'WO-0012' });
    expect(describeRow(row('user.deactivate', 'user', 'u1'), L).find((s) => s.k === 'user')).toMatchObject({ id: 'u1' });
  });
  it('falls back to a generic sentence for actions it does not know', () => {
    expect(say(row('wo.mystery', 'work_order', 'wo12'), NO_LOOKUP)).toBe('Updated a work order');
    expect(say(row('wo.mystery', 'work_order', 'wo12'), L)).toBe('Updated work order WO-0012');
    expect(say(row('vehicle.archive', 'vehicle', 'v3'), L)).toBe('Updated unit GEMA-03');
    expect(say(row('widget.create', 'widget', 'w1'), NO_LOOKUP)).toBe('Added a widget');
    expect(say(row('widget.delete', 'widget', 'w1'), NO_LOOKUP)).toBe('Removed a widget');
  });
  it('never throws on odd data', () => {
    expect(say(row('vehicle.move', 'vehicle', 'v3', 'junk', 5))).toMatch(/GEMA-03/);
    expect(say(row('user.update', 'user', 'u1', null, null))).toBe('Updated Jane Doe');
  });
});

describe('category mapping', () => {
  it('maps actions to the ten categories', () => {
    const m: [string, string, string][] = [
      ['vehicle.move', 'vehicle', 'vehicles'], ['vehicle.status', 'vehicle', 'vehicles'], ['reading.log', 'vehicle', 'vehicles'], ['reading.accept', 'meter_reading', 'vehicles'],
      ['issue.report', 'issue', 'problems'], ['issue.dismiss', 'issue', 'problems'], ['wo.create', 'work_order', 'work_orders'], ['wo.line.add', 'work_order', 'work_orders'],
      ['program.update', 'pm_program', 'pm'], ['part.receive', 'part', 'parts_mechanics'], ['mechanic.create', 'mechanic', 'parts_mechanics'],
      ['user.update', 'user', 'people'], ['role.permissions', 'role', 'people'], ['settings.update', 'settings', 'settings'], ['features.update', 'settings', 'settings'], ['base.create', 'base', 'settings'], ['sample.remove', 'sample', 'settings'],
      ['auth.login', 'user', 'sign_ins'], ['auth.login_failed', 'user', 'sign_ins'], ['auth.locked', 'user', 'sign_ins'], ['auth.logout', 'user', 'sign_ins'], ['backup.run', 'backup', 'backups'],
      ['attachment.add', 'issue', 'problems'], ['attachment.delete', 'work_order', 'work_orders'],
      ['buscheck.submit', 'bus_check', 'bus_checks'], ['buschecklist.update', 'bus_check_list', 'bus_checks'], ['buschecklist.create', 'bus_check_list', 'bus_checks'],
    ];
    for (const [a, e, c] of m) expect(categoryOf(a, e), a).toBe(c);
    expect(categoryOf('something.new', 'x')).toBe('other');
    expect(categoryOf('attachment.add', 'vehicle')).toBe('other');
  });
  it('has nine categories, every rule points at one, and prefixes are safe for LIKE', () => {
    expect(ACTIVITY_CATEGORIES).toHaveLength(10);
    for (const r of CATEGORY_RULES) { expect(CATEGORY_KEYS).toContain(r.category); expect(r.prefix).toMatch(/^[a-z]+\.$/); }
  });
  it('every action the Worker writes has a category (so the Type filter can find it)', () => {
    const dir = process.cwd() + '/src/worker/';
    const actions = new Set<string>(['wo.approve', 'wo.schedule', 'wo.start', 'wo.hold', 'wo.resume', 'wo.complete', 'wo.close', 'wo.cancel', 'role.permissions', 'role.reset', 'user.deactivate', 'user.reactivate', 'program.create', 'program.update', 'attachment.add', 'attachment.delete']);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(dir + f, 'utf8');
      for (const m of src.matchAll(/\.audit\(\s*'([a-z_.]+)'/g)) actions.add(m[1]);
      for (const m of src.matchAll(/(?:action:|issueAndSend\([^)]*,)\s*'((?:auth|user|backup)\.[a-z_]+)'/g)) actions.add(m[1]);
      for (const m of src.matchAll(/'((?:auth|user)\.[a-z_]+)'\)/g)) actions.add(m[1]);
    }
    expect(actions.size).toBeGreaterThan(30);
    for (const a of actions) {
      const entity = a.startsWith('attachment.') ? 'issue' : 'x';
      expect(categoryOf(a, entity), a).not.toBe('other');
      // and every one has its own sentence (not the generic fallback)
      if (!a.startsWith('attachment.')) expect(say(row(a, 'thing', 'id1')), a).toBeTruthy();
    }
  });
});

describe('field diff formatter', () => {
  it('lists only fields that differ, with names, dates, G$ amounts and yes/no', () => {
    const d = diffFields('vehicle', { id: 'v3', unit: 'GEMA-03', status: 'in_service', baseId: 'hq', engineHours: 1000, odometerKm: 5000 }, { unit: 'GEMA-03', baseId: 'linden', engineHours: 1250, odometerKm: 5000 }, L);
    expect(d.map((x) => [x.label, x.from, x.to])).toEqual([['Base', 'HQ', 'Linden'], ['Engine hours', '1,000 h', '1,250 h']]);
  });
  it('formats money, dates, booleans, roles, statuses and base lists', () => {
    expect(formatValue('unitCost', 12000, 'part', L)).toBe('G$ 12,000');
    expect(formatValue('approvalThresholdGYD', 150000, 'settings', L)).toBe('G$ 150,000');
    expect(formatValue('tempUntil', '2026-11-20', 'vehicle', L)).toBe('20/11/2026');
    expect(formatValue('at', '2026-11-10T15:30:00.000Z', 'x', L)).toBe('10/11/2026 11:30');
    expect(formatValue('active', false, 'user', L)).toBe('No');
    expect(formatValue('role', 'base_supervisor', 'user', L)).toBe('Base supervisor');
    expect(formatValue('status', 'oos_parts', 'vehicle', L)).toBe('Out: waiting for parts');
    expect(formatValue('status', 'on_hold', 'work_order', L)).toBe('On hold');
    expect(formatValue('baseIds', ['hq', 'linden'], 'user', L)).toBe('HQ, Linden');
    expect(formatValue('mechanicId', 'm1', 'work_order', L)).toBe('Ravi');
    expect(formatValue('notes', '', 'work_order', L)).toBe('—');
    expect(formatValue('priority', 'urgent', 'work_order', L)).toBe('Urgent');
  });
  it('treats a missing key in a partial update as unchanged, and a create as from "—"', () => {
    expect(diffFields('work_order', { priority: 'normal', mechanicId: null, notes: 'a' }, { priority: 'high' }, L)).toEqual([{ key: 'priority', label: 'Priority', from: 'Normal', to: 'High' }]);
    const c = diffFields('mechanic', null, { name: 'Ravi', shop: 'Linden' }, L);
    expect(c.map((x) => [x.label, x.from, x.to])).toEqual([['Name', '—', 'Ravi'], ['Location', '—', 'Linden']]);
    expect(diffFields('x', { a: 1 }, { a: 1 }, L)).toEqual([]);
    expect(diffFields('x', null, null, L)).toEqual([]);
  });
  it('shows permission changes by name with Role default for a cleared one', () => {
    const d = diffFields('user', { email: 'j@x', overrides: { move: true } }, { email: 'j@x', overrides: { report: false } }, L);
    expect(d.map((x) => [x.label, x.from, x.to])).toEqual([['Report problems', 'Role default', 'No'], ['Move units between bases', 'Yes', 'Role default']]);
  });
  it('flattens nested settings (features) with a readable label', () => {
    const d = diffFields('settings', { comebackDays: 30, features: { uploads: false } }, { comebackDays: 30, features: { uploads: true } }, L);
    expect(d).toEqual([{ key: 'features.uploads', label: 'Photo and PDF uploads', from: 'No', to: 'Yes' }]);
  });
  it('truncates long values', () => {
    expect(truncate('short')).toEqual({ text: 'short', cut: false });
    const t = truncate('x'.repeat(300), 100);
    expect(t.cut).toBe(true);
    expect(t.text.length).toBe(101);
  });
});

describe('dates and times (Guyana, UTC-4)', () => {
  it('day labels', () => {
    expect(dayLabel('2026-11-10', '2026-11-10')).toBe('Today');
    expect(dayLabel('2026-11-09', '2026-11-10')).toBe('Yesterday');
    expect(dayLabel('2026-11-09', '2026-11-12')).toBe('Mon 9 Nov 2026');
    expect(dayLabel('2026-10-31', '2026-11-01')).toBe('Yesterday');
  });
  it('day boundaries and times are Guyana time', () => {
    expect(gyDayStartISO('2026-11-10')).toBe('2026-11-10T04:00:00.000Z');
    expect(gyDayEndISO('2026-11-10')).toBe('2026-11-11T04:00:00.000Z');
    expect(timeHM('2026-11-10T02:05:00.000Z')).toBe('22:05');
    expect(dmy('2026-11-10T02:05:00.000Z')).toBe('09/11/2026');
  });
});

describe('sanitiser', () => {
  it('removes password, hash, token and session keys at any depth, in arrays too, and keeps the rest', () => {
    const out = sanitizeAudit({ name: 'x', password: 'p', newPassword: 'n', password_hash: 'h', passwordHash: 'h', token: 't', token_hash: 'th', resetToken: 'r', Session: 's', sessionId: 'sid', cookie: 'c',
      nested: { ok: 1, deep: { secret: 's', fine: [{ token: 'x', keep: 'y' }] } }, list: [{ password: 'p', a: 1 }, 2, 'text'] });
    expect(out).toEqual({ name: 'x', nested: { ok: 1, deep: { fine: [{ keep: 'y' }] } }, list: [{ a: 1 }, 2, 'text'] });
    expect(JSON.stringify(out)).not.toMatch(/password|token|session|secret|hash/i);
  });
  it('blanks link secrets in text and survives null, numbers and cycles of depth', () => {
    expect(sanitizeAudit({ link: 'https://x/set-password#t=AbC_123-xyz', n: 5, z: null })).toEqual({ link: 'https://x/set-password#t=[removed]', n: 5, z: null });
    expect(sanitizeAudit(null)).toBeNull();
    expect(sanitizeAudit(7)).toBe(7);
  });
});

describe('csv safety', () => {
  it('keeps spreadsheet programs from running formulas', () => {
    expect(csvSafe('=HYPERLINK("x")')).toBe("'=HYPERLINK(\"x\")");
    expect(csvSafe('+1')).toBe("'+1");
    expect(csvSafe('Signed in')).toBe('Signed in');
    expect(csvSafe(null)).toBe('');
  });
});
