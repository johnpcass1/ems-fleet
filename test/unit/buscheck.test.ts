import { describe, it, expect } from 'vitest';
import {
  ITEM_KINDS, allOkFill, answerError, cellState, checkAnswers, cleanAnswer, listClash, parseShiftTimes, pickList, progress, shiftFor, shiftMinutes, shiftsOnDate, shortageOf, EARLY_MIN, latestFound, restockNote,
  type BusItem, type BusSection,
} from '../../src/shared/buscheck';
import { STARTER_SECTIONS } from '../../src/shared/busCheckStarter';
import { baseScope, vehicleInScope, type Actor } from '../../src/shared/perm';
import { gyDate } from '../../src/shared/pure';

const T = '2026-11-05';
const count: BusItem = { id: 'c', name: 'Sterile gauze pads 4x4"', kind: 'count', min: 6 };
const countU: BusItem = { id: 'cu', name: 'Gloves', kind: 'count', min: 10, unit: 'pairs' };
const check: BusItem = { id: 'k', name: 'Seatbelts', kind: 'check' };
const num: BusItem = { id: 'n', name: 'Oxygen cylinder 1 pressure', kind: 'number', min: 1000, unit: 'psi' };
const date: BusItem = { id: 'd', name: 'Hydro test', kind: 'date' };
const opt: BusItem = { id: 'o', name: 'Extra blanket', kind: 'optional' };

describe('shortage evaluation per kind', () => {
  it('count: OK is fine, Short is a minor problem with the agreed title', () => {
    expect(shortageOf(count, { status: 'ok' }, T)).toBeNull();
    expect(shortageOf(count, { status: 'short', qty: 2 }, T)).toMatchObject({ severity: 'minor', title: 'Bus check: Sterile gauze pads 4x4" short (2 of 6)' });
    expect(shortageOf(countU, { status: 'short', qty: 0 }, T)!.title).toBe('Bus check: Gloves short (0 of 10 pairs)');
  });
  it('check: fail is a major problem', () => {
    expect(shortageOf(check, { status: 'pass' }, T)).toBeNull();
    expect(shortageOf(check, { status: 'fail' }, T)).toMatchObject({ severity: 'major', title: 'Bus check: Seatbelts failed' });
  });
  it('number: below the minimum is major, at the minimum is fine', () => {
    expect(shortageOf(num, { value: 1000 }, T)).toBeNull();
    expect(shortageOf(num, { value: 1500 }, T)).toBeNull();
    expect(shortageOf(num, { value: 800 }, T)).toMatchObject({ severity: 'major', title: 'Bus check: Oxygen cylinder 1 pressure 800 psi (minimum 1000)' });
  });
  it('date: today is still good, yesterday is expired (shown as DD/MM/YYYY)', () => {
    expect(shortageOf(date, { date: T }, T)).toBeNull();
    expect(shortageOf(date, { date: '2099-01-01' }, T)).toBeNull();
    expect(shortageOf(date, { date: '2025-02-01' }, T)).toMatchObject({ severity: 'major', title: 'Bus check: Hydro test expired 01/02/2025' });
    expect(shortageOf(date, { date: '2026-11-04' }, T)).not.toBeNull();
  });
  it('optional is never a shortage, and the section is kept with the shortage', () => {
    expect(shortageOf(opt, { status: 'absent' }, T)).toBeNull();
    expect(shortageOf(check, { status: 'fail' }, T, 'Cab')!.section).toBe('Cab');
  });
  it('long titles are cut to the problem title limit', () => {
    const long: BusItem = { id: 'l', name: 'x'.repeat(200), kind: 'check' };
    const s = shortageOf(long, { status: 'fail' }, T)!;
    expect(s.title.length).toBeLessThanOrEqual(120);
  });
});

describe('answers', () => {
  const secs: BusSection[] = [{ id: 's', title: 'S', items: [count, check, num, date, opt] }];
  it('every required item must be answered, optional ones may be skipped', () => {
    const r = checkAnswers(secs, { c: { status: 'ok' } }, T);
    expect(r.unanswered).toEqual(['k', 'n', 'd']);
    expect(progress(secs, { c: { status: 'ok' } })).toEqual({ done: 1, total: 4 });
  });
  it('rejects wrong or impossible answers', () => {
    expect(answerError(count, { status: 'short', qty: 6 })).toMatch(/fewer than 6/);
    expect(answerError(count, { status: 'short', qty: 2.5 })).toMatch(/whole number/);
    expect(answerError(count, { status: 'short' })).toBeNull(); // Short on its own is enough; how many is optional
    expect(shortageOf(count, { status: 'short' }, T)?.title).toMatch(/short \(need 6/);
    expect(answerError(count, { status: 'pass' })).toBe('Answer OK or Short.');
    expect(answerError(check, { status: 'ok' })).toBe('Answer Pass or Fail.');
    expect(answerError(num, { value: -1 })).not.toBeNull();
    expect(answerError(date, { date: '2025-02-30' })).toBe('Enter a date.');
    expect(answerError(opt, undefined)).toBeNull();
    expect(answerError(opt, { status: 'present' })).toBeNull();
    expect(answerError(count, { status: 'ok', note: 'x'.repeat(500) })).toMatch(/too long/);
  });
  it('an answer for an item that is not on the list is an error', () => {
    const r = checkAnswers(secs, { c: { status: 'ok' }, k: { status: 'pass' }, n: { value: 2000 }, d: { date: '2099-01-01' }, zz: { status: 'ok' } }, T);
    expect(r.errors).toEqual([{ itemId: 'zz', name: 'zz', error: 'This item is not on the list.' }]);
  });
  it('All OK fills counts and checks only, and never overrides an existing answer', () => {
    expect(allOkFill(secs[0], { k: { status: 'fail' } })).toEqual({ c: { status: 'ok' } });
    expect(allOkFill(secs[0], {})).toEqual({ c: { status: 'ok' }, k: { status: 'pass' } });
  });
  it('cleanAnswer keeps only what belongs to the kind, and a note only for a problem', () => {
    expect(cleanAnswer(count, { status: 'ok', qty: 99, note: 'hi' })).toEqual({ status: 'ok' });
    expect(cleanAnswer(count, { status: 'short', qty: 2, note: ' low ' })).toEqual({ status: 'short', qty: 2, note: 'low' });
    expect(cleanAnswer(num, { value: 5, status: 'ok' })).toEqual({ value: 5 });
  });
});

describe('starter list conversion', () => {
  const items = STARTER_SECTIONS.flatMap((s) => s.items);
  it('has the 82 items of the source minus the 5 not required, plus the split oxygen items', () => {
    expect(STARTER_SECTIONS).toHaveLength(8);
    expect(items).toHaveLength(79); // 82 - 5 not_required = 77, + 1 (b.5a into two) + 1 (b.5c into two)
  });
  it('item ids and codes are unique, and every kind is a known kind', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.code)).size).toBe(items.length);
    expect(items.every((i) => (ITEM_KINDS as readonly string[]).includes(i.kind))).toBe(true);
    expect(new Set(STARTER_SECTIONS.map((s) => s.id)).size).toBe(8);
  });
  it('the oxygen items are split into readings and dates', () => {
    const by = (id: string) => items.find((i) => i.id === id)!;
    expect(by('b.5a-1')).toMatchObject({ kind: 'number', min: 1000, unit: 'psi' });
    expect(by('b.5a-2')).toMatchObject({ kind: 'number', min: 1000, unit: 'psi' });
    expect(by('b.5c-1').kind).toBe('date');
    expect(by('b.5c-2').kind).toBe('date');
    expect(items.some((i) => i.id === 'b.5a' || i.id === 'b.5c')).toBe(false);
  });
  it('counts have a whole minimum of 1 or more, readings have a minimum', () => {
    for (const i of items) {
      if (i.kind === 'count') expect(Number.isInteger(i.min) && i.min! >= 1, i.id).toBe(true);
      if (i.kind === 'number') expect(typeof i.min, i.id).toBe('number');
    }
  });
});

describe('list picking', () => {
  const L = (id: string, unitTypes: string[], active = true) => ({ id, name: id, unitTypes, active });
  it('a list naming the type wins over the default; inactive lists are ignored; type match ignores case and spaces', () => {
    const lists = [L('a-default', []), L('b-box', ['Box ambulance']), L('c-off', ['Van'], false)];
    expect(pickList(lists, 'box  AMBULANCE')!.id).toBe('b-box');
    expect(pickList(lists, 'Van')!.id).toBe('a-default');
    expect(pickList(lists, 'Whatever')!.id).toBe('a-default');
    expect(pickList(lists, null)!.id).toBe('a-default');
    expect(pickList([L('x', ['Box'])], 'Van')).toBeNull();
    expect(pickList([], 'Van')).toBeNull();
  });
  it('refuses overlapping types and a second default among active lists only', () => {
    const others = [L('a', ['Box', 'Van']), L('d', [])];
    expect(listClash({ ...L('n', ['van']), name: 'n' }, others)).toMatch(/already covers/);
    expect(listClash({ ...L('n', []), name: 'n' }, others)).toMatch(/default/);
    expect(listClash({ ...L('n', ['Truck']), name: 'n' }, others)).toBeNull();
    expect(listClash({ ...L('n', ['Van'], false), name: 'n' }, others)).toBeNull();
    expect(listClash({ ...L('a', ['Box']), name: 'a' }, others)).toBeNull(); // itself
  });
});

describe('shift times and windows', () => {
  it('parses, sorts and tidies; refuses nonsense', () => {
    expect(parseShiftTimes('19:00, 7:00')).toEqual({ ok: true, minutes: [420, 1140], text: '07:00, 19:00' });
    expect(parseShiftTimes('06:00;14:00 22:00')).toMatchObject({ ok: true, minutes: [360, 840, 1320] });
    for (const bad of ['', 'x', '24:00', '07:60', '07:00,07:00', '07:00, 08:30', '07:00, 12:00, 23:30, 06:00', '1,2,3,4,5,6,7']) expect(parseShiftTimes(bad).ok, bad).toBe(false);
    expect(shiftMinutes('garbage')).toEqual([420, 1140]);
    expect(shiftMinutes('08:00')).toEqual([480]);
  });
  const at = (date: string, h: number, m = 0) => Date.parse(`${date}T00:00:00.000Z`) + (h + 4) * 36e5 + m * 6e4;
  it('windows tile the timeline: every instant is in exactly one shift', () => {
    const mins = [420, 1140];
    for (let h = 0; h < 24; h += 0.5) {
      const ms = at('2026-03-10', Math.floor(h), (h % 1) * 60);
      const hits = ['2026-03-09', '2026-03-10', '2026-03-11'].flatMap((d) => shiftsOnDate(d, mins).filter((w) => ms >= w.openMs && ms < w.closeMs));
      expect(hits, `at ${h}`).toHaveLength(1);
    }
  });
  it('assignment with the default 07:00 / 19:00 times and 60 minutes of grace', () => {
    const m = [420, 1140];
    const f = (date: string, h: number, mm = 0) => shiftFor(at(date, h, mm), m);
    expect(f('2026-03-10', 7, 0)).toEqual({ date: '2026-03-10', index: 0 });
    expect(f('2026-03-10', 6, 0)).toEqual({ date: '2026-03-10', index: 0 });         // exactly 60 minutes early counts
    expect(f('2026-03-10', 5, 59)).toEqual({ date: '2026-03-09', index: 1 });        // 61 minutes early: still the night shift
    expect(f('2026-03-10', 17, 59)).toEqual({ date: '2026-03-10', index: 0 });
    expect(f('2026-03-10', 18, 0)).toEqual({ date: '2026-03-10', index: 1 });
    expect(f('2026-03-10', 23, 59)).toEqual({ date: '2026-03-10', index: 1 });
    expect(f('2026-03-11', 2, 0)).toEqual({ date: '2026-03-10', index: 1 });         // after midnight belongs to the evening shift that started the day before
    expect(EARLY_MIN).toBe(60);
  });
  it('a single shift a day, and three shifts', () => {
    expect(shiftFor(at('2026-03-10', 9), [480])).toEqual({ date: '2026-03-10', index: 0 });
    expect(shiftFor(at('2026-03-10', 3), [480])).toEqual({ date: '2026-03-09', index: 0 });
    const m = [360, 840, 1320];
    expect(shiftFor(at('2026-03-10', 13, 30), m)).toEqual({ date: '2026-03-10', index: 1 });
    expect(shiftFor(at('2026-03-10', 21, 30), m)).toEqual({ date: '2026-03-10', index: 2 });
    expect(shiftFor(at('2026-03-10', 5, 30), m)).toEqual({ date: '2026-03-10', index: 0 });
  });
  it('the date is the Guyana date (UTC-4), not the UTC date', () => {
    expect(gyDate(Date.parse('2026-03-11T02:00:00Z'))).toBe('2026-03-10');
  });
  it('cell states', () => {
    const w = shiftsOnDate('2026-03-10', [420, 1140])[0];
    expect(cellState(w, w.startMs - 1, true, false)).toBe('upcoming');
    expect(cellState(w, w.startMs, true, false)).toBe('due');
    expect(cellState(w, w.closeMs, true, false)).toBe('missed');
    expect(cellState(w, w.closeMs, false, false)).toBe('not_expected');
    expect(cellState(w, w.closeMs, false, true)).toBe('checked');
    expect(cellState(w, w.startMs - 1, true, true)).toBe('checked');
  });
});

describe('baseScope matches vehicleInScope', () => {
  const mk = (role: string, baseIds: string[], isSuper = false) => ({ id: 'x', email: '', name: '', role, baseIds, mechanicId: null, agencyId: 'A', homeAgencyId: 'A', isSuper }) as Actor;
  it('gives the same answer for every role, with and without bases', () => {
    const bases = ['b1', 'b2', 'b3', null];
    for (const role of ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'viewer', 'dispatcher']) {
      for (const ids of [[], ['b1'], ['b1', 'b2']]) {
        for (const key of ['busCheck', 'busCheckReports', 'reading']) {
          const a = mk(role, ids), sc = baseScope(a, key);
          for (const b of bases) expect(sc === null ? true : !!b && sc.includes(b), `${role} ${ids} ${key} ${b}`).toBe(vehicleInScope(a, key, b));
        }
      }
    }
    expect(baseScope(mk('crew', [], true), 'busCheck')).toBeNull();
  });
});

describe('reading a shortage\'s description', () => {
  const first = 'Found by a bus check on 05/11/2026 07:10.\nOxygen: Portable bag valve mask\nFound 2, the minimum is 6.\nNote: box was empty';
  it('latestFound: the first finding, then the newest "Found again" line, never the restock text or a crew note', () => {
    expect(latestFound(first)).toBe('Found 2, the minimum is 6.');
    const again = first + '\n\nFound again by a bus check on 06/11/2026 07:02: Found 0, the minimum is 6. Note: still none';
    expect(latestFound(again)).toBe('Found 0, the minimum is 6.');
    expect(latestFound(again + '\n\nFound again by a bus check on 07/11/2026 19:01: Marked as failed.')).toBe('Marked as failed.');
    expect(latestFound(again + '\n\nRestocked by Ann Lee on 07/11/2026 09:00. Note: from stores')).toBe('Found 0, the minimum is 6.');
    expect(latestFound('')).toBe('');
  });
  it('restockNote: the note typed at restock, or empty', () => {
    expect(restockNote(first + '\n\nRestocked by Ann Lee on 07/11/2026 09:00. Note: New box from stores. Two sets.')).toBe('New box from stores. Two sets.');
    expect(restockNote(first + '\n\nRestocked by Ann Lee on 07/11/2026 09:00.')).toBe('');
    expect(restockNote(first)).toBe('');
  });
});
describe('busCheckRestock permission', () => {
  const actor = (role: string, baseIds: string[] = []) => ({ id: 'u', role, baseIds, email: '', name: '', mechanicId: null, agencyId: 'A', homeAgencyId: 'A' }) as any as Actor;
  it('defaults: base supervisor (own bases only), fleet manager and system admin; nobody else', async () => {
    const { can } = await import('../../src/shared/perm');
    for (const r of ['base_supervisor', 'fleet_manager', 'system_admin']) expect(can({ role: r }, 'busCheckRestock'), r).toBe(true);
    for (const r of ['crew', 'mechanic', 'viewer', 'dispatcher']) expect(can({ role: r }, 'busCheckRestock'), r).toBe(false);
    expect(baseScope(actor('base_supervisor', ['b1']), 'busCheckRestock')).toEqual(['b1']);
    expect(vehicleInScope(actor('base_supervisor', ['b1']), 'busCheckRestock', 'b2')).toBe(false);
    expect(baseScope(actor('fleet_manager'), 'busCheckRestock')).toBeNull();
  });
  it('is in the Bus checks group of the permission editors, once', async () => {
    const { PERM_GROUPS, EDITABLE_KEYS } = await import('../../src/shared/perm');
    const g = PERM_GROUPS.find((x) => x.title === 'Bus checks')!;
    expect(g.items.find(([k]) => k === 'busCheckRestock')).toEqual(['busCheckRestock', 'Mark equipment restocked']);
    expect(EDITABLE_KEYS).toContain('busCheckRestock');
    expect(PERM_GROUPS.flatMap((x) => x.items).filter(([k]) => k === 'busCheckRestock')).toHaveLength(1);
  });
});
