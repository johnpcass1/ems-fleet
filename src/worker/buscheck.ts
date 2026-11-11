/**
 * Bus checks: the start-of-shift ambulance inspection. See docs/HANDOVER.md, "Bus checks".
 *
 *  - Requirement lists (what a crew checks, for which unit types): create / update / duplicate / start from the standard list. busCheckEdit.
 *  - Submit a check: ONE write that saves the check (with a copy of the list), the meter reading, the problems the crew reported and one problem
 *    for each shortage. busCheck, on units the person may act on.
 *  - Reports: today's status by shift, shortages, history (paged), one full check, CSV. busCheckReports, supervisors only for their bases.
 *
 *  - Equipment shortages (the open ones, restock, CSV) and the crew's "Known shortages" panel. A shortage is stored in `issues` (source 'bus_check') but is not a vehicle problem.
 *
 * Every query here starts with agency_id = the caller's agency (from the session, see requireAuth). Every id that arrives from the browser
 * (unit, base, list, person, check) is looked up inside that agency first; another agency's id behaves exactly like one that does not exist.
 */
import { z } from 'zod';
import type { Env } from './env';
import { Tx, SEQ, all, first, agencyRow, inAgency } from './db';
import { bad, forbidden, notFound, conflict, uid, zId, zDate, zText, parse } from './http';
import { loadDocs } from './docs';
import { addReading, getSettings, readingFields, vehicleRow, writeStatus } from './rules';
import { baseScope, can, canOnVehicle, vehicleInScope, type Actor } from '../shared/perm';
import { isAvail } from '../shared/constants';
import {
  ATTESTATION, ITEM_KINDS, MAX_ITEMS, MAX_SECTIONS, NOTE_MAX, REPORT_SOURCE, RESTOCKED, RESTOCK_NOTE_MAX, RESTOCK_RECENT_DAYS, SHORTAGE_SOURCE, latestFound, restockNote, cellState, checkAnswers, cleanAnswer, flatItems, isRealDate, listClash, pickList, shiftFor, shiftMinutes, shiftsOnDate, hhmm,
  type BusAnswers, type BusItem, type BusSection, type Shortage,
} from '../shared/buscheck';
import { STARTER_LIST_NAME, STARTER_SECTIONS } from '../shared/busCheckStarter';
import { dmyHM, dmy, csvSafe, gyDayEndISO, gyDayStartISO } from '../shared/activity';
import { addDays, gyDate, toCsv } from '../shared/pure';

const j = (s: any, d: any) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const iso = (ms: number) => new Date(ms).toISOString();
export const PAGE = 50;
export const EXPORT_MAX = 5000;

/* ====================================================================== requirement lists */

const itemId = z.string().trim().regex(/^[A-Za-z0-9._()-]{1,40}$/, 'An item id can only use letters, numbers and . _ - ( ).');
const itemIn = z.object({
  id: itemId.nullish(), code: zText(20).default(''), name: zText(160).min(1, 'Every item needs a name.'),
  kind: z.enum(ITEM_KINDS), min: z.number().finite().min(0).max(1e9).nullish(), unit: zText(20).default(''), note: zText(160).default(''),
});
const sectionIn = z.object({ id: itemId.nullish(), title: zText(120).min(1, 'Every section needs a title.'), items: z.array(itemIn).max(MAX_ITEMS) });
const listIn = z.object({
  name: zText(80).min(1, 'Give the list a name.'),
  unitTypes: z.array(zText(60).min(1)).max(20).default([]),
  active: z.boolean().default(true),
  sections: z.array(sectionIn).min(1, 'Add at least one section.').max(MAX_SECTIONS),
  /** The updated_at of the list the person was editing: refused if someone else saved it since. */
  updatedAt: z.string().max(40).nullish(),
});

/** Turn what the browser sent into the stored shape: ids filled in and checked for repeats, only the fields that belong to each kind of item. */
export function normalizeSections(input: z.infer<typeof sectionIn>[]): BusSection[] {
  const seen = new Set<string>(), seenSec = new Set<string>();
  let n = 0;
  const out = input.map((s) => {
    const sid = s.id || uid('bs');
    if (seenSec.has(sid)) throw bad('Two sections have the same id.');
    seenSec.add(sid);
    const items: BusItem[] = s.items.map((it) => {
      const id = it.id || uid('bi');
      if (seen.has(id)) throw bad(`Two items have the same id (${id}).`);
      seen.add(id);
      n++;
      const o: BusItem = { id, name: it.name, kind: it.kind };
      if (it.code) o.code = it.code;
      if (it.kind === 'count') {
        if (it.min == null || !Number.isInteger(it.min) || it.min < 1) throw bad(`"${it.name}" needs a minimum quantity of 1 or more (a whole number).`);
        o.min = it.min;
        if (it.unit) o.unit = it.unit;
      } else if (it.kind === 'number') {
        if (it.min == null) throw bad(`"${it.name}" needs a minimum reading.`);
        o.min = it.min;
        if (it.unit) o.unit = it.unit;
      }
      if (it.note) o.note = it.note;
      return o;
    });
    return { id: sid, title: s.title, items };
  });
  if (n < 1) throw bad('Add at least one item.');
  if (n > MAX_ITEMS) throw bad(`A list can have at most ${MAX_ITEMS} items.`);
  return out;
}
const cleanTypes = (ts: string[]) => {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of ts) { const k = t.replace(/\s+/g, ' ').trim(); const key = k.toLowerCase(); if (k && !seen.has(key)) { seen.add(key); out.push(k); } }
  return out;
};
const listSummary = (name: string, unitTypes: string[], sections: BusSection[], active: boolean) => ({ name, unitTypes, active, sections: sections.length, items: flatItems(sections).length });

async function agencyLists(env: Env, agency: string) { return (await loadDocs(env.DB, agency, 'busCheckLists')) as any[]; }
async function needList(env: Env, agency: string, id: string) {
  const r = await agencyRow<any>(env.DB, 'bus_check_lists', agency, id); // another agency's list is simply not found
  if (!r) throw notFound('That list does not exist.');
  return r;
}
const needEdit = (actor: Actor) => { if (!can(actor, 'busCheckEdit')) throw forbidden(); };

function insertList(tx: Tx, id: string, name: string, unitTypes: string[], active: boolean, sections: BusSection[]) {
  tx.run(
    `INSERT INTO bus_check_lists (id, name, unit_types, active, sections, seq, created_at, updated_at, agency_id) VALUES (?,?,?,?,?,${SEQ},?,?,?)`,
    id, name, JSON.stringify(unitTypes), active ? 1 : 0, JSON.stringify(sections), tx.at, tx.at, tx.agency,
  );
}

/** POST /api/bus-check-lists */
export async function createList(env: Env, actor: Actor, body: unknown) {
  needEdit(actor);
  const i = parse(listIn, body);
  const sections = normalizeSections(i.sections), unitTypes = cleanTypes(i.unitTypes);
  const clash = listClash({ id: '', name: i.name, unitTypes, active: i.active }, await agencyLists(env, actor.agencyId));
  if (clash) throw conflict(clash, 'list_clash');
  const id = uid('bl');
  const tx = new Tx(env.DB, actor);
  insertList(tx, id, i.name, unitTypes, i.active, sections);
  tx.audit('buschecklist.create', 'bus_check_list', id, null, listSummary(i.name, unitTypes, sections, i.active));
  await tx.commit();
  return { ok: true, id };
}

/** POST /api/bus-check-lists/standard: the starter list, for an agency that has no list yet. */
export async function createStandardList(env: Env, actor: Actor) {
  needEdit(actor);
  if ((await agencyLists(env, actor.agencyId)).length) throw conflict('This agency already has a bus check list.', 'lists_exist');
  const id = uid('bl');
  const sections = JSON.parse(JSON.stringify(STARTER_SECTIONS)) as BusSection[];
  const tx = new Tx(env.DB, actor);
  insertList(tx, id, STARTER_LIST_NAME, [], true, sections);
  tx.audit('buschecklist.create', 'bus_check_list', id, null, { ...listSummary(STARTER_LIST_NAME, [], sections, true), starter: true });
  await tx.commit();
  return { ok: true, id };
}

/** PUT /api/bus-check-lists/:id: the whole list (name, unit types, active, sections). Reordering, adding and removing items is just sending the new order. */
export async function updateList(env: Env, actor: Actor, id: string, body: unknown) {
  needEdit(actor);
  const i = parse(listIn, body);
  const cur = await needList(env, actor.agencyId, id);
  if (i.updatedAt && i.updatedAt !== cur.updated_at) throw conflict('Someone else changed this list while you were editing. Reload the page and try again.', 'stale');
  const sections = normalizeSections(i.sections), unitTypes = cleanTypes(i.unitTypes);
  const clash = listClash({ id, name: i.name, unitTypes, active: i.active }, await agencyLists(env, actor.agencyId));
  if (clash) throw conflict(clash, 'list_clash');
  const before = { name: cur.name, unitTypes: j(cur.unit_types, []), active: !!cur.active, sections: j(cur.sections, []) as BusSection[] };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const onlyActive = before.name === i.name && same(before.unitTypes, unitTypes) && same(before.sections, sections) && before.active !== i.active;
  const unchanged = before.name === i.name && same(before.unitTypes, unitTypes) && same(before.sections, sections) && before.active === i.active;
  if (unchanged) return { ok: true, id };
  const action = onlyActive ? (i.active ? 'buschecklist.activate' : 'buschecklist.deactivate') : 'buschecklist.update';
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT updated_at FROM bus_check_lists WHERE id = ? AND agency_id = ?) = ?', id, tx.agency, cur.updated_at);
  tx.run(
    `UPDATE bus_check_lists SET name=?, unit_types=?, active=?, sections=?, seq=${SEQ}, updated_at=? WHERE id=? AND agency_id=?`,
    i.name, JSON.stringify(unitTypes), i.active ? 1 : 0, JSON.stringify(sections), tx.at, id, tx.agency,
  );
  tx.audit(action, 'bus_check_list', id, listSummary(before.name, before.unitTypes, before.sections, before.active), listSummary(i.name, unitTypes, sections, i.active));
  await tx.commit();
  return { ok: true, id };
}

/** POST /api/bus-check-lists/:id/duplicate: a copy, named "... (copy)", with no unit types and inactive until someone sets them (so it cannot clash). */
export async function duplicateList(env: Env, actor: Actor, id: string) {
  needEdit(actor);
  const cur = await needList(env, actor.agencyId, id);
  const nid = uid('bl'), name = (cur.name + ' (copy)').slice(0, 80), sections = j(cur.sections, []) as BusSection[];
  const tx = new Tx(env.DB, actor);
  insertList(tx, nid, name, [], false, sections);
  tx.audit('buschecklist.duplicate', 'bus_check_list', nid, { name: cur.name }, { ...listSummary(name, [], sections, false), copiedFrom: id });
  await tx.commit();
  return { ok: true, id: nid };
}

/* ====================================================================== submitting a check */

const personIn = z.object({ userId: zId.nullish(), name: zText(80).default('') });
const answerIn = z.object({
  status: z.enum(['ok', 'short', 'pass', 'fail', 'present', 'absent']).optional(),
  qty: z.number().finite().optional(), value: z.number().finite().optional(), date: z.string().max(10).optional(), note: zText(NOTE_MAX).optional(),
});
const submitIn = z.object({
  vehicleId: zId, listId: zId, baseId: zId,
  clientRef: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/).nullish(),
  crew: z.object({ emt1: personIn, emt2: personIn, driver: personIn.nullish() }),
  km: readingFields.km, hours: readingFields.hours, accept: z.boolean().optional(),
  answers: z.record(z.string().max(60), answerIn).refine((a) => Object.keys(a).length <= MAX_ITEMS, 'Too many answers.'),
  problems: z.array(z.object({ title: zText(120).min(1, 'Say what is wrong.'), description: zText(4000).default(''), severity: z.enum(['critical', 'major', 'minor']) })).max(10).default([]),
  attested: z.boolean().refine((v) => v === true, 'Tick the box to confirm the check before sending it.'),
});

async function person(env: Env, agency: string, p: { userId?: string | null; name: string } | null | undefined, label: string, required: boolean) {
  if (p?.userId) {
    const u = await agencyRow<any>(env.DB, 'users', agency, p.userId);
    if (!u || !u.active) throw bad(`${label} is not an active person in this agency.`);
    return { userId: u.id as string, name: u.name as string };
  }
  const name = (p?.name || '').replace(/\s+/g, ' ').trim();
  if (!name) { if (required) throw bad(`Say who ${label} is.`); return null; }
  return { userId: null, name };
}

/** The shape of what a submit answers with. */
export interface SubmitResult { ok: true; id: string; at: string; shortages: number; newShortages: number; joined: number; reported: number; flagged: boolean; warnings: string[]; shift: string; duplicate?: boolean }

/** POST /api/bus-checks. One database batch: the check, the meter reading, reported problems and one problem per shortage (or a note on the open one). */
export async function submitCheck(env: Env, actor: Actor, body: unknown): Promise<SubmitResult> {
  if (!can(actor, 'busCheck')) throw forbidden();
  const i = parse(submitIn, body);
  const ag = actor.agencyId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await vehicleRow(env.DB, ag, i.vehicleId); // another agency's unit is "does not exist"
    if (!canOnVehicle(actor, 'busCheck', v.base_id)) throw forbidden();
    if (v.status === 'decommissioned') throw bad('This unit is decommissioned, so it cannot be checked.');
    if (i.clientRef) {
      const dup = await first<any>(env.DB, 'SELECT id, vehicle_id, submitted_at, shortages, problems, reading_flagged FROM bus_checks WHERE agency_id = ? AND client_ref = ?', ag, i.clientRef);
      if (dup) {
        if (dup.vehicle_id !== v.id) throw conflict('That check reference was already used.', 'duplicate_ref');
        const ps = j(dup.problems, []) as any[];
        return { ok: true, id: dup.id, at: dup.submitted_at, shortages: dup.shortages, newShortages: ps.filter((p) => p.kind === 'new').length, joined: ps.filter((p) => p.kind === 'existing').length, reported: ps.filter((p) => p.kind === 'reported').length, flagged: !!dup.reading_flagged, warnings: [], shift: '', duplicate: true };
      }
    }
    if (!(await inAgency(env.DB, 'bases', ag, i.baseId))) throw bad('That base does not exist.');
    const listRow = await agencyRow<any>(env.DB, 'bus_check_lists', ag, i.listId);
    if (!listRow) throw bad('That list does not exist.');
    const lists = await agencyLists(env, ag);
    const applies = pickList(lists, v.type);
    if (!applies) throw bad('No bus check list applies to this unit. A fleet manager needs to set one up first.', 'no_list');
    if (applies.id !== listRow.id) throw conflict('The list for this unit has changed. Reload the page and start the check again.', 'stale_list');
    const sections = j(listRow.sections, []) as BusSection[];

    const emt1 = await person(env, ag, i.crew.emt1, 'EMT 1', true), emt2 = await person(env, ag, i.crew.emt2, 'EMT 2', true), driver = await person(env, ag, i.crew.driver, 'the driver', false);
    if (emt1!.userId && emt1!.userId === emt2!.userId) throw bad('EMT 1 and EMT 2 must be two different people.');

    const now = Date.now(), today = gyDate(now);
    const report = checkAnswers(sections, i.answers as BusAnswers, today);
    if (report.errors.length) throw bad(`${report.errors[0].name}: ${report.errors[0].error}`);
    if (report.unanswered.length) {
      const names = flatItems(sections).filter((it) => report.unanswered.includes(it.id)).map((it) => it.name);
      throw bad(`${report.unanswered.length} ${report.unanswered.length === 1 ? 'item is' : 'items are'} not answered yet: ${names.slice(0, 3).join('; ')}${names.length > 3 ? '...' : ''}`, 'unanswered');
    }
    const answers: BusAnswers = {};
    for (const it of flatItems(sections)) { const a = i.answers[it.id]; if (a) answers[it.id] = cleanAnswer(it, a as any); }

    // Open problems this unit already has from earlier checks, for the same items: this check joins them instead of adding another.
    const refs = report.shortages.map((s) => s.itemId);
    const open = refs.length
      ? await all<any>(env.DB, `SELECT id, source_ref, description FROM issues WHERE agency_id = ? AND vehicle_id = ? AND source = '${SHORTAGE_SOURCE}' AND status IN ('open', 'in_work_order') AND source_ref IN (SELECT value FROM json_each(?))`, ag, v.id, JSON.stringify(refs))
      : [];
    const openBy = new Map<string, any>(open.map((r) => [r.source_ref, r]));

    const tx = new Tx(env.DB, actor);
    const checkId = uid('bc');
    const accept = !!i.accept && canOnVehicle(actor, 'confirmReading', v.base_id);
    tx.guard('(SELECT engine_hours FROM vehicles WHERE id = ? AND agency_id = ?) = ?', v.id, tx.agency, v.engine_hours);
    const reading = await addReading(tx, env.DB, v, i.hours, i.km, 'bus_check', accept);

    const when = dmyHM(tx.at);
    const newIssues: any[] = [], joins: any[] = [], problems: any[] = [], audits: any[] = [];
    const shortageItems: (Shortage & { problemId: string; joined: boolean })[] = [];
    for (const s of report.shortages) {
      const ex = openBy.get(s.itemId);
      const ref = `${s.section ? s.section + ': ' : ''}${s.code ? s.code + ' ' : ''}${s.name}`;
      if (ex) {
        const add = `\n\nFound again by a bus check on ${when}: ${s.found}${s.note ? ' Note: ' + s.note : ''}`;
        joins.push({ id: ex.id, add });
        problems.push({ issueId: ex.id, kind: 'existing', itemId: s.itemId });
        shortageItems.push({ ...s, problemId: ex.id, joined: true });
        audits.push({ action: 'issue.buscheck_link', entityType: 'issue', entityId: ex.id, after: { vehicleId: v.id, title: s.title, busCheckId: checkId, shortage: true } });
      } else {
        const id = uid('is');
        const description = `Found by a bus check on ${when}.\n${ref}\n${s.found}${s.note ? '\nNote: ' + s.note : ''}`.slice(0, 4000);
        newIssues.push({ id, title: s.title, description, severity: s.severity, source: SHORTAGE_SOURCE, ref: s.itemId });
        problems.push({ issueId: id, kind: 'new', itemId: s.itemId });
        shortageItems.push({ ...s, problemId: id, joined: false });
        audits.push({ action: 'issue.report', entityType: 'issue', entityId: id, after: { vehicleId: v.id, title: s.title, severity: s.severity, busCheckId: checkId, shortage: true } });
      }
    }
    for (const p of i.problems) {
      const id = uid('is');
      newIssues.push({ id, title: p.title, description: p.description, severity: p.severity, source: REPORT_SOURCE, ref: null });
      problems.push({ issueId: id, kind: 'reported', itemId: null });
      audits.push({ action: 'issue.report', entityType: 'issue', entityId: id, after: { vehicleId: v.id, title: p.title, severity: p.severity, busCheckId: checkId } });
    }
    // A critical problem takes an available unit out of service straight away, exactly as when it is reported on its own.
    const crit = i.problems.find((p) => p.severity === 'critical');
    if (crit && isAvail(v.status)) writeStatus(tx, v, 'oos_repair', 'Critical problem: ' + crit.title, null, null);

    if (newIssues.length) {
      tx.run(
        `INSERT INTO issues (id, vehicle_id, title, description, severity, status, reported_at, by_user, wo_id, hours, sample, seq, created_at, updated_at, agency_id, bus_check_id, source, source_ref)
         SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.title'), json_extract(j.value, '$.description'), json_extract(j.value, '$.severity'), 'open', ?, ?, NULL, ?, 0, ${SEQ}, ?, ?, ?, ?,
                json_extract(j.value, '$.source'), json_extract(j.value, '$.ref') FROM json_each(?) j`,
        v.id, tx.at, actor.id, i.hours, tx.at, tx.at, tx.agency, checkId, JSON.stringify(newIssues),
      );
    }
    if (joins.length) {
      const js = JSON.stringify(joins);
      tx.run(
        `UPDATE issues SET description = CASE WHEN length(description) + length(x.add_text) <= 4000 THEN description || x.add_text ELSE description END, seq = ${SEQ}, updated_at = ?
         FROM (SELECT json_extract(j.value, '$.id') AS iid, json_extract(j.value, '$.add') AS add_text FROM json_each(?) j) x
         WHERE issues.agency_id = ? AND issues.id = x.iid`,
        tx.at, js, tx.agency,
      );
    }
    const crew = { emt1, emt2, driver };
    tx.run(
      `INSERT INTO bus_checks (id, vehicle_id, list_id, list_name, base_id, submitted_at, submitted_by, crew, mileage_km, engine_hours, reading_id, reading_flagged, shortages, snapshot, answers, shortage_items, problems, attestation, client_ref, seq, created_at, updated_at, agency_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${SEQ},?,?,?)`,
      checkId, v.id, listRow.id, listRow.name, i.baseId, tx.at, actor.id, JSON.stringify(crew), i.km, i.hours, reading.id, reading.flagged ? 1 : 0, report.shortages.length,
      JSON.stringify({ name: listRow.name, sections }), JSON.stringify(answers), JSON.stringify(shortageItems), JSON.stringify(problems), ATTESTATION, i.clientRef ?? null, tx.at, tx.at, tx.agency,
    );
    tx.audit('buscheck.submit', 'bus_check', checkId, null, {
      vehicleId: v.id, unit: v.unit, list: listRow.name, baseId: i.baseId, shortages: report.shortages.length, problems: i.problems.length, km: i.km, hours: i.hours,
      emt1: emt1!.name, emt2: emt2!.name, ...(driver ? { driver: driver.name } : {}),
    });
    tx.auditMany([{ action: 'reading.log', entityType: 'vehicle', entityId: v.id, before: { engineHours: v.engine_hours }, after: { hours: i.hours, km: i.km, flagged: reading.flagged, source: 'bus_check' } }, ...audits]);
    try {
      await tx.commit();
    } catch (e: any) {
      const msg = String(e?.message || e) + String(e?.cause?.message || '');
      // Someone else changed the unit, or found the same shortage, at the same moment: read everything again and retry.
      if ((e?.status === 409 && e.code === 'stale') || /UNIQUE constraint failed: issues\./i.test(msg) || /UNIQUE constraint failed: bus_checks\./i.test(msg)) { if (attempt < 2) continue; throw conflict('Several people are sending checks for this unit at once. Please try again.', 'busy'); }
      throw e;
    }
    const w = shiftFor(Date.parse(tx.at), shiftMinutes((await getSettings(env.DB, ag)).busCheckShifts));
    return {
      ok: true, id: checkId, at: tx.at, shortages: report.shortages.length, newShortages: newIssues.length - i.problems.length, joined: joins.length, reported: i.problems.length,
      flagged: reading.flagged, warnings: reading.warnings, shift: `${hhmm(shiftMinutes((await getSettings(env.DB, ag)).busCheckShifts)[w.index])} shift on ${dmy(w.date)}`,
    };
  }
  throw conflict('Please try again.');
}

/* ====================================================================== reports */

const needReports = (actor: Actor) => { if (!can(actor, 'busCheckReports')) throw forbidden(); };
/** `AND <alias>.base_id IN (...)` for a supervisor (only units at their bases), nothing for people who reach every unit, `AND 0` when they have no bases. Same rule as vehicleInScope. */
function scopeSql(actor: Actor, alias: string): { sql: string; params: unknown[] } {
  const b = baseScope(actor, 'busCheckReports');
  if (b === null) return { sql: '', params: [] };
  if (!b.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${alias}.base_id IN (${b.map(() => '?').join(',')})`, params: b };
}
/** A unit named in a filter must be in the agency and in the person's scope; otherwise it is "not found". */
async function scopedVehicle(env: Env, actor: Actor, id: string) {
  const v = await agencyRow<any>(env.DB, 'vehicles', actor.agencyId, id);
  if (!v || !vehicleInScope(actor, 'busCheckReports', v.base_id)) throw notFound('That unit does not exist.');
  return v;
}

const rangeIn = z.object({ from: zDate.optional(), to: zDate.optional() });
const blank = (v: string | null) => (v == null || v.trim() === '' ? undefined : v);
/** Dates are Guyana calendar days, both ends included. Default: the last 30 days. */
function dayRange(sp: URLSearchParams, defaultDays: number | null) {
  const r = rangeIn.safeParse({ from: blank(sp.get('from')), to: blank(sp.get('to')) });
  if (!r.success) throw bad(`${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`);
  let { from, to } = r.data;
  if (defaultDays != null) { to ??= gyDate(Date.now()); from ??= addDays(to, -(defaultDays - 1)); }
  if (from && to && from > to) throw bad('The From date is after the To date.');
  if (from && to && (Date.parse(to) - Date.parse(from)) / 864e5 > 400) throw bad('Pick a range of at most 13 months.');
  return { from, to };
}

const filterIn = z.object({ vehicleId: zId.optional(), baseId: zId.optional(), userId: zId.optional(), shortages: z.enum(['1']).optional() });
async function historyWhere(env: Env, actor: Actor, sp: URLSearchParams) {
  const f = filterIn.safeParse(Object.fromEntries(['vehicleId', 'baseId', 'userId', 'shortages'].map((k) => [k, blank(sp.get(k))])));
  if (!f.success) throw bad(`${f.error.issues[0].path.join('.')}: ${f.error.issues[0].message}`);
  const { from, to } = dayRange(sp, null);
  const sc = scopeSql(actor, 'v');
  const w: string[] = ['c.agency_id = ?'], p: unknown[] = [actor.agencyId];
  const i = f.data;
  if (i.vehicleId) { await scopedVehicle(env, actor, i.vehicleId); w.push('c.vehicle_id = ?'); p.push(i.vehicleId); }
  if (i.baseId) { if (!(await inAgency(env.DB, 'bases', actor.agencyId, i.baseId))) throw notFound('That base does not exist.'); w.push('c.base_id = ?'); p.push(i.baseId); }
  if (i.userId) {
    if (!(await inAgency(env.DB, 'users', actor.agencyId, i.userId))) throw notFound('That person does not exist.');
    w.push("(c.submitted_by = ? OR json_extract(c.crew, '$.emt1.userId') = ? OR json_extract(c.crew, '$.emt2.userId') = ? OR json_extract(c.crew, '$.driver.userId') = ?)");
    p.push(i.userId, i.userId, i.userId, i.userId);
  }
  if (i.shortages) w.push('c.shortages > 0');
  if (from) { w.push('c.submitted_at >= ?'); p.push(gyDayStartISO(from)); }
  if (to) { w.push('c.submitted_at < ?'); p.push(gyDayEndISO(to)); }
  return { where: w.join(' AND ') + sc.sql, params: [...p, ...sc.params] };
}
const HISTORY_FROM = `FROM bus_checks c JOIN vehicles v ON v.agency_id = c.agency_id AND v.id = c.vehicle_id
  LEFT JOIN bases b ON b.agency_id = c.agency_id AND b.id = c.base_id LEFT JOIN users u ON u.agency_id = c.agency_id AND u.id = c.submitted_by`;
const HISTORY_COLS = `c.id, c.vehicle_id, v.unit, c.base_id, b.name AS base_name, c.list_name, c.submitted_at, c.submitted_by, u.name AS by_name, c.crew, c.mileage_km, c.engine_hours, c.shortages, c.reading_flagged, (SELECT COUNT(*) FROM json_each(c.problems) q WHERE json_extract(q.value, '$.kind') = 'reported') AS problem_count`;
function historyRow(r: any) {
  const crew = j(r.crew, {});
  return {
    id: r.id, vehicleId: r.vehicle_id, unit: r.unit, baseId: r.base_id, base: r.base_name ?? '', list: r.list_name, at: r.submitted_at, by: r.submitted_by, byName: r.by_name ?? '',
    emt1: crew.emt1?.name ?? '', emt2: crew.emt2?.name ?? '', driver: crew.driver?.name ?? '', km: r.mileage_km, hours: r.engine_hours, shortages: r.shortages, problems: r.problem_count, flagged: !!r.reading_flagged,
  };
}

/** GET /api/bus-checks: newest first, 50 at a time. `before` is the `nextBefore` of the previous page. */
export async function listChecks(env: Env, actor: Actor, sp: URLSearchParams) {
  needReports(actor);
  const { where, params } = await historyWhere(env, actor, sp);
  const lim = Math.min(100, Math.max(1, Number(sp.get('limit') || PAGE) || PAGE));
  const w = [where], p = [...params];
  const b = blank(sp.get('before'));
  if (b !== undefined) {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)~([A-Za-z0-9-]{1,80})$/.exec(b);
    if (!m) throw bad('before is not a valid page marker.');
    w.push('(c.submitted_at < ? OR (c.submitted_at = ? AND c.id < ?))');
    p.push(m[1], m[1], m[2]);
  }
  const rows = await all<any>(env.DB, `SELECT ${HISTORY_COLS} ${HISTORY_FROM} WHERE ${w.join(' AND ')} ORDER BY c.submitted_at DESC, c.id DESC LIMIT ?`, ...p, lim + 1);
  const more = rows.length > lim, page = rows.slice(0, lim).map(historyRow);
  return { rows: page, hasMore: more, nextBefore: more && page.length ? `${page[page.length - 1].at}~${page[page.length - 1].id}` : null };
}

const csvHeaders = (name: string, extra: Record<string, string> = {}) => ({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
/** GET /api/bus-checks/export: the same filters as the history, as CSV (newest 5,000). */
export async function checksCsv(env: Env, actor: Actor, sp: URLSearchParams) {
  needReports(actor);
  const { where, params } = await historyWhere(env, actor, sp);
  const raw = await all<any>(env.DB, `SELECT ${HISTORY_COLS} ${HISTORY_FROM} WHERE ${where} ORDER BY c.submitted_at DESC, c.id DESC LIMIT ?`, ...params, EXPORT_MAX + 1);
  const truncated = raw.length > EXPORT_MAX, rows = raw.slice(0, EXPORT_MAX).map(historyRow);
  const head = ['When (Guyana time)', 'Unit', 'Station', 'List', 'EMT 1', 'EMT 2', 'Driver', 'Mileage (km)', 'Engine hours', 'Shortages', 'Problems reported', 'Submitted by', 'Check id'];
  const body = '﻿' + toCsv([head, ...rows.map((r) => [dmyHM(r.at), r.unit, r.base, r.list, r.emt1, r.emt2, r.driver, r.km, r.hours, r.shortages, r.problems, r.byName, r.id].map(csvSafe))]);
  return new Response(body, { headers: csvHeaders(`bus-checks-${actor.agencyId.toLowerCase()}-${gyDate(Date.now())}.csv`, { 'X-Rows': String(rows.length), 'X-Truncated': truncated ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Rows, X-Truncated' }) });
}

/** GET /api/bus-checks/:id: one full check, read-only. A check of another agency, or of a unit outside a supervisor's bases, is "not found". */
export async function getCheck(env: Env, actor: Actor, id: string) {
  needReports(actor);
  const r = await first<any>(env.DB, `SELECT c.*, v.unit, v.base_id AS unit_base_id, b.name AS base_name, u.name AS by_name FROM bus_checks c JOIN vehicles v ON v.agency_id = c.agency_id AND v.id = c.vehicle_id
    LEFT JOIN bases b ON b.agency_id = c.agency_id AND b.id = c.base_id LEFT JOIN users u ON u.agency_id = c.agency_id AND u.id = c.submitted_by WHERE c.agency_id = ? AND c.id = ?`, actor.agencyId, id);
  if (!r || !vehicleInScope(actor, 'busCheckReports', r.unit_base_id)) throw notFound('That bus check does not exist.');
  const problems = j(r.problems, []) as { issueId: string; kind: string; itemId: string | null }[];
  const issues = problems.length
    ? await all<any>(env.DB, `SELECT id, title, severity, status FROM issues WHERE agency_id = ? AND id IN (SELECT json_extract(value, '$.issueId') FROM json_each(?))`, actor.agencyId, JSON.stringify(problems))
    : [];
  const byId = new Map(issues.map((x) => [x.id, x]));
  const settings = await getSettings(env.DB, actor.agencyId);
  const w = shiftFor(Date.parse(r.submitted_at), shiftMinutes(settings.busCheckShifts));
  return {
    check: {
      id: r.id, vehicleId: r.vehicle_id, unit: r.unit, listId: r.list_id, list: r.list_name, baseId: r.base_id, base: r.base_name ?? '', at: r.submitted_at, by: r.submitted_by, byName: r.by_name ?? '',
      crew: j(r.crew, {}), km: r.mileage_km, hours: r.engine_hours, readingId: r.reading_id, flagged: !!r.reading_flagged, shortages: r.shortages, snapshot: j(r.snapshot, { sections: [] }), answers: j(r.answers, {}),
      shortageItems: j(r.shortage_items, []), attestation: r.attestation, shift: `${hhmm(shiftMinutes(settings.busCheckShifts)[w.index] ?? 0)} shift on ${dmy(w.date)}`,
      problems: problems.map((p) => ({ ...p, title: byId.get(p.issueId)?.title ?? '', severity: byId.get(p.issueId)?.severity ?? '', status: byId.get(p.issueId)?.status ?? '' })),
    },
  };
}

/** GET /api/bus-checks/today?date=YYYY-MM-DD: every unit that is expected to be checked, with the state of each shift of that day. `nowMs` is only changed by tests. */
export async function todayReport(env: Env, actor: Actor, sp: URLSearchParams, nowMs = Date.now()) {
  needReports(actor);
  const today = gyDate(nowMs);
  const d = blank(sp.get('date')) ?? today;
  if (!isRealDate(d) || d < addDays(today, -400) || d > addDays(today, 31)) throw bad('Pick a date within the last 13 months and the next month.');
  const minutes = shiftMinutes((await getSettings(env.DB, actor.agencyId)).busCheckShifts);
  return buildToday(env, actor, d, minutes, nowMs);
}
export async function buildToday(env: Env, actor: Actor, date: string, minutes: number[], nowMs: number) {
  const ag = actor.agencyId;
  const wins = shiftsOnDate(date, minutes);
  const sc = scopeSql(actor, 'v');
  const statusCols = wins.map((_, k) => `COALESCE((SELECT e.to_status FROM status_events e WHERE e.agency_id = v.agency_id AND e.vehicle_id = v.id AND e.at <= ? ORDER BY e.at DESC LIMIT 1),
      (SELECT e.from_status FROM status_events e WHERE e.agency_id = v.agency_id AND e.vehicle_id = v.id AND e.at > ? ORDER BY e.at ASC LIMIT 1), v.status) AS st${k}`).join(', ');
  const vehicles = await all<any>(env.DB, `SELECT v.id, v.unit, v.type, v.status, v.base_id, v.created_at, ${statusCols} FROM vehicles v WHERE v.agency_id = ? AND v.status <> 'decommissioned'${sc.sql} ORDER BY v.unit`,
    ...wins.flatMap((w) => [iso(w.startMs), iso(w.startMs)]), ag, ...sc.params);
  const checks = await all<any>(env.DB, `SELECT c.id, c.vehicle_id, c.submitted_at, c.shortages, u.name AS by_name FROM bus_checks c JOIN vehicles v ON v.agency_id = c.agency_id AND v.id = c.vehicle_id
    LEFT JOIN users u ON u.agency_id = c.agency_id AND u.id = c.submitted_by WHERE c.agency_id = ? AND c.submitted_at >= ? AND c.submitted_at < ?${sc.sql} ORDER BY c.submitted_at, c.id`,
    ag, iso(wins[0].openMs), iso(wins[wins.length - 1].closeMs), ...sc.params);
  const byVeh = new Map<string, any[]>();
  for (const c of checks) (byVeh.get(c.vehicle_id) ?? byVeh.set(c.vehicle_id, []).get(c.vehicle_id)!).push(c);
  const bases = await all<any>(env.DB, 'SELECT id, name FROM bases WHERE agency_id = ?', ag);
  const baseName = new Map(bases.map((b) => [b.id, b.name]));
  const totals = { expected: 0, checked: 0, missed: 0, due: 0, withShortages: 0 };
  const units = vehicles.map((v) => {
    const cells = wins.map((w, k) => {
      const mine = (byVeh.get(v.id) ?? []).filter((c) => Date.parse(c.submitted_at) >= w.openMs && Date.parse(c.submitted_at) < w.closeMs);
      const first = mine[0];
      const notInFleet = Date.parse(v.created_at) >= w.closeMs;
      const expected = isAvail(v[`st${k}`]) && !notInFleet;
      const state = cellState(w, nowMs, expected, !!first);
      if (state === 'checked') { totals.checked++; if (first.shortages > 0) totals.withShortages++; }
      if (state === 'missed') totals.missed++;
      if (state === 'due') totals.due++;
      if (expected || first) totals.expected++;
      return {
        shift: k, state,
        ...(state === 'not_expected' ? { reason: notInFleet ? 'Not in the fleet yet' : 'Out of service' } : {}),
        ...(first ? { check: { id: first.id, at: first.submitted_at, by: first.by_name ?? '', shortages: first.shortages, count: mine.length } } : {}),
      };
    });
    return { vehicleId: v.id, unit: v.unit, type: v.type, status: v.status, baseId: v.base_id, cells };
  });
  const groups = new Map<string, { id: string; name: string; units: typeof units }>();
  for (const u of units) {
    const key = u.baseId && baseName.has(u.baseId) ? u.baseId : '';
    if (!groups.has(key)) groups.set(key, { id: key, name: key ? baseName.get(key)! : 'Unassigned', units: [] });
    groups.get(key)!.units.push(u);
  }
  const out = [...groups.values()].sort((a, b) => (a.name === 'HQ' ? -1 : b.name === 'HQ' ? 1 : a.name.localeCompare(b.name)));
  return {
    date, now: iso(nowMs), today: gyDate(nowMs),
    shifts: wins.map((w) => ({ index: w.index, label: w.label, startAt: iso(w.startMs), closeAt: iso(w.closeMs), state: nowMs < w.startMs ? 'upcoming' : nowMs < w.closeMs ? 'current' : 'past' })),
    bases: out, totals,
  };
}

/** GET /api/bus-checks/shortages?from&to (default: the last 30 days): the items most often short, and the units with the most shortages. */
export async function shortagesReport(env: Env, actor: Actor, sp: URLSearchParams) {
  needReports(actor);
  const { from, to } = dayRange(sp, 30);
  const sc = scopeSql(actor, 'v');
  const where = `c.agency_id = ? AND c.submitted_at >= ? AND c.submitted_at < ?${sc.sql}`;
  const p = [actor.agencyId, gyDayStartISO(from!), gyDayEndISO(to!), ...sc.params];
  const base = `FROM bus_checks c JOIN vehicles v ON v.agency_id = c.agency_id AND v.id = c.vehicle_id`;
  const [items, units, tot] = await Promise.all([
    all<any>(env.DB, `SELECT json_extract(s.value, '$.itemId') AS item_id, MAX(json_extract(s.value, '$.code')) AS code, MAX(json_extract(s.value, '$.name')) AS name, MAX(json_extract(s.value, '$.kind')) AS kind,
      COUNT(*) AS times, COUNT(DISTINCT c.vehicle_id) AS units, MAX(c.submitted_at) AS last_at ${base}, json_each(c.shortage_items) s WHERE ${where} AND c.shortages > 0 GROUP BY item_id ORDER BY times DESC, last_at DESC, name LIMIT 500`, ...p),
    all<any>(env.DB, `SELECT c.vehicle_id, v.unit, COUNT(DISTINCT c.id) AS checks, COUNT(*) AS shortages, MAX(c.submitted_at) AS last_at ${base}, json_each(c.shortage_items) s WHERE ${where} AND c.shortages > 0 GROUP BY c.vehicle_id ORDER BY shortages DESC, last_at DESC LIMIT 500`, ...p),
    first<any>(env.DB, `SELECT COUNT(*) AS checks, COALESCE(SUM(c.shortages > 0), 0) AS with_shortages, COALESCE(SUM(c.shortages), 0) AS shortages ${base} WHERE ${where}`, ...p),
  ]);
  return {
    from, to, totals: { checks: tot?.checks ?? 0, withShortages: tot?.with_shortages ?? 0, shortages: tot?.shortages ?? 0 },
    items: items.map((r) => ({ itemId: r.item_id, code: r.code ?? '', name: r.name ?? '', kind: r.kind ?? '', times: r.times, units: r.units, lastAt: r.last_at })),
    units: units.map((r) => ({ vehicleId: r.vehicle_id, unit: r.unit, checks: r.checks, shortages: r.shortages, lastAt: r.last_at })),
  };
}

/** GET /api/bus-checks/shortages/export: every shortage found in the range, one row each, as CSV (newest 5,000). */
export async function shortagesCsv(env: Env, actor: Actor, sp: URLSearchParams) {
  needReports(actor);
  const { from, to } = dayRange(sp, 30);
  const sc = scopeSql(actor, 'v');
  const raw = await all<any>(env.DB, `SELECT c.submitted_at, c.id, v.unit, b.name AS base_name, s.value AS s FROM bus_checks c JOIN vehicles v ON v.agency_id = c.agency_id AND v.id = c.vehicle_id
    LEFT JOIN bases b ON b.agency_id = c.agency_id AND b.id = c.base_id, json_each(c.shortage_items) s WHERE c.agency_id = ? AND c.shortages > 0 AND c.submitted_at >= ? AND c.submitted_at < ?${sc.sql}
    ORDER BY c.submitted_at DESC, c.id DESC, s.key LIMIT ?`, actor.agencyId, gyDayStartISO(from!), gyDayEndISO(to!), ...sc.params, EXPORT_MAX + 1);
  const truncated = raw.length > EXPORT_MAX;
  const head = ['When (Guyana time)', 'Unit', 'Station', 'Section', 'Item code', 'Item', 'What was found', 'Severity', 'Added to an open shortage', 'Check id'];
  const rows = raw.slice(0, EXPORT_MAX).map((r) => { const s = j(r.s, {}); return [dmyHM(r.submitted_at), r.unit, r.base_name ?? '', s.section ?? '', s.code ?? '', s.name ?? '', s.found ?? '', s.severity ?? '', s.joined ? 'Yes' : 'No', r.id].map(csvSafe); });
  return new Response('﻿' + toCsv([head, ...rows]), { headers: csvHeaders(`bus-check-shortages-${actor.agencyId.toLowerCase()}-${gyDate(Date.now())}.csv`, { 'X-Rows': String(rows.length), 'X-Truncated': truncated ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Rows, X-Truncated' }) });
}

/* ====================================================================== equipment shortages */
// A shortage is a row in `issues` with source 'bus_check' (so the de-duplication, the link to the check and the history keep working), but it is NOT a
// vehicle problem: it never reaches the Problems page, a work order, a count or a unit's status. It is closed by "Mark restocked" (status 'restocked').

/** The Equipment tab needs the reports right (a supervisor's is limited to their bases) or the restock right. */
const needEquipment = (actor: Actor) => { if (!can(actor, 'busCheckReports') && !can(actor, 'busCheckRestock')) throw forbidden(); };
const OPEN_SQL = `i.status IN ('open', 'in_work_order')`;
const SHORTAGE_COLS = `i.id, i.vehicle_id, v.unit, v.base_id, b.name AS base_name, i.source_ref, i.title, i.description, i.status, i.reported_at, i.restocked_at, i.restocked_by, ru.name AS restocked_by_name,
  (SELECT s.value FROM bus_checks c0, json_each(c0.shortage_items) s WHERE c0.agency_id = i.agency_id AND c0.id = i.bus_check_id AND json_extract(s.value, '$.itemId') = i.source_ref LIMIT 1) AS item`;
const SHORTAGE_FROM = `FROM issues i JOIN vehicles v ON v.agency_id = i.agency_id AND v.id = i.vehicle_id LEFT JOIN bases b ON b.agency_id = i.agency_id AND b.id = v.base_id
  LEFT JOIN users ru ON ru.agency_id = i.agency_id AND ru.id = i.restocked_by`;
const SHORTAGE_MAX = 1000;

export interface ShortageRow {
  id: string; vehicleId: string; unit: string; baseId: string | null; base: string; itemId: string; code: string; name: string; section: string;
  title: string; found: string; firstAt: string; checks: number; lastAt: string; lastCheckId: string | null; status: string;
  restockedAt: string | null; restockedBy: string | null; restockedByName: string; restockNote: string;
}
/** Shortages of one agency (the caller adds the status and any unit or base conditions), with how many checks found each and the last of them. */
async function shortageRows(env: Env, agency: string, where: string, params: unknown[], order: 'unit' | 'restocked'): Promise<ShortageRow[]> {
  const raw = await all<any>(env.DB, `SELECT ${SHORTAGE_COLS} ${SHORTAGE_FROM} WHERE i.agency_id = ? AND i.source = '${SHORTAGE_SOURCE}' AND ${where}
    ORDER BY ${order === 'unit' ? 'v.unit, i.reported_at, i.id' : 'i.restocked_at DESC, i.id'} LIMIT ?`, agency, ...params, SHORTAGE_MAX);
  if (!raw.length) return [];
  const stats = await all<any>(env.DB, `SELECT json_extract(p.value, '$.issueId') AS iid, COUNT(*) AS n, MAX(c.submitted_at || '~' || c.id) AS last
    FROM bus_checks c, json_each(c.problems) p WHERE c.agency_id = ? AND c.vehicle_id IN (SELECT value FROM json_each(?)) AND json_extract(p.value, '$.issueId') IN (SELECT value FROM json_each(?)) GROUP BY iid`,
    agency, JSON.stringify([...new Set(raw.map((r) => r.vehicle_id))]), JSON.stringify(raw.map((r) => r.id)));
  const byIssue = new Map(stats.map((s) => [s.iid, s]));
  return raw.map((r) => {
    const it = j(r.item, {}), st = byIssue.get(r.id), last = String(st?.last ?? ''), k = last.indexOf('~');
    return {
      id: r.id, vehicleId: r.vehicle_id, unit: r.unit, baseId: r.base_id, base: r.base_name ?? '', itemId: r.source_ref ?? '', code: it.code ?? '', name: it.name ?? String(r.title).replace(/^Bus check: /, ''), section: it.section ?? '',
      title: r.title, found: latestFound(r.description), firstAt: r.reported_at, checks: st?.n ?? 1, lastAt: k > 0 ? last.slice(0, k) : r.reported_at, lastCheckId: k > 0 ? last.slice(k + 1) : null, status: r.status,
      restockedAt: r.restocked_at ?? null, restockedBy: r.restocked_by ?? null, restockedByName: r.restocked_by_name ?? '', restockNote: r.status === RESTOCKED ? restockNote(r.description) : '',
    };
  });
}
const byBaseThenUnit = (a: ShortageRow, b: ShortageRow) => (a.base === 'HQ' ? -1 : b.base === 'HQ' ? 1 : (a.base || '~').localeCompare(b.base || '~')) || a.unit.localeCompare(b.unit, undefined, { numeric: true }) || a.firstAt.localeCompare(b.firstAt);

const equipFilterIn = z.object({ vehicleId: zId.optional(), baseId: zId.optional() });
/** The conditions for the Equipment list: the person's bases, plus a unit and/or a base (the unit's current base). A unit or base outside the agency or the person's bases is "not found". */
async function equipmentWhere(env: Env, actor: Actor, sp: URLSearchParams) {
  const f = equipFilterIn.safeParse({ vehicleId: blank(sp.get('vehicleId')), baseId: blank(sp.get('baseId')) });
  if (!f.success) throw bad(`${f.error.issues[0].path.join('.')}: ${f.error.issues[0].message}`);
  const sc = scopeSql(actor, 'v');
  const w: string[] = [], p: unknown[] = [];
  if (f.data.vehicleId) { await scopedVehicle(env, actor, f.data.vehicleId); w.push('i.vehicle_id = ?'); p.push(f.data.vehicleId); }
  if (f.data.baseId) { if (!(await inAgency(env.DB, 'bases', actor.agencyId, f.data.baseId))) throw notFound('That base does not exist.'); w.push('v.base_id = ?'); p.push(f.data.baseId); }
  return { sql: w.map((x) => ' AND ' + x).join('') + sc.sql, params: [...p, ...sc.params] };
}

/** GET /api/bus-checks/equipment?baseId&vehicleId&recent=1: the open equipment shortages, and with recent=1 those restocked in the last 30 days. */
export async function equipmentList(env: Env, actor: Actor, sp: URLSearchParams) {
  needEquipment(actor);
  const c = await equipmentWhere(env, actor, sp);
  const open = (await shortageRows(env, actor.agencyId, OPEN_SQL + c.sql, c.params, 'unit')).sort(byBaseThenUnit);
  const since = iso(Date.now() - RESTOCK_RECENT_DAYS * 864e5);
  const recent = sp.get('recent') === '1' ? await shortageRows(env, actor.agencyId, `i.status = '${RESTOCKED}' AND i.restocked_at >= ?` + c.sql, [since, ...c.params], 'restocked') : [];
  return { open, recent, recentDays: RESTOCK_RECENT_DAYS };
}

/** GET /api/bus-checks/equipment/export: the open shortages (same filters), as CSV. */
export async function equipmentCsv(env: Env, actor: Actor, sp: URLSearchParams) {
  needEquipment(actor);
  const c = await equipmentWhere(env, actor, sp);
  const rows = (await shortageRows(env, actor.agencyId, OPEN_SQL + c.sql, c.params, 'unit')).sort(byBaseThenUnit);
  const head = ['Station', 'Unit', 'Section', 'Item code', 'Item', 'What was found', 'First found (Guyana time)', 'Checks that found it', 'Last check (Guyana time)', 'Last check id'];
  const body = '﻿' + toCsv([head, ...rows.map((r) => [r.base, r.unit, r.section, r.code, r.name, r.found, dmyHM(r.firstAt), r.checks, dmyHM(r.lastAt), r.lastCheckId ?? ''].map(csvSafe))]);
  return new Response(body, { headers: csvHeaders(`bus-check-equipment-${actor.agencyId.toLowerCase()}-${gyDate(Date.now())}.csv`, { 'X-Rows': String(rows.length), 'X-Truncated': '0', 'Access-Control-Expose-Headers': 'X-Rows, X-Truncated' }) });
}

/** GET /api/bus-checks/equipment/known?vehicleId=: what is already reported short on a unit, for the crew's check screen. The right to do bus checks on that unit is enough. */
export async function knownShortages(env: Env, actor: Actor, sp: URLSearchParams) {
  if (!can(actor, 'busCheck')) throw forbidden();
  const vehicleId = blank(sp.get('vehicleId'));
  if (!vehicleId || !zId.safeParse(vehicleId).success) throw bad('vehicleId: Choose a unit.');
  const v = await agencyRow<any>(env.DB, 'vehicles', actor.agencyId, vehicleId); // another agency's unit is "does not exist"
  if (!v || !canOnVehicle(actor, 'busCheck', v.base_id)) throw notFound('That unit does not exist.');
  const rows = await shortageRows(env, actor.agencyId, OPEN_SQL + ' AND i.vehicle_id = ?', [v.id], 'unit');
  return { shortages: rows.map((r) => ({ itemId: r.itemId, code: r.code, name: r.name, section: r.section, found: r.found, firstAt: r.firstAt, checks: r.checks, lastAt: r.lastAt })) };
}

const restockIn = z.object({ ids: z.array(zId).min(1, 'Choose at least one shortage.').max(100), note: zText(RESTOCK_NOTE_MAX).default('') });
/**
 * POST /api/bus-checks/equipment/restock { ids, note? }: closes the shortages (status 'restocked'), records who and when, appends the note to each one's description
 * and writes one `issue.restock` audit row each, in one batch. An id that is not a shortage of this agency, or is on a unit outside the person's bases, is "not found"
 * (and then nothing is changed). A shortage that is already restocked answers 409.
 */
export async function restockShortages(env: Env, actor: Actor, body: unknown) {
  if (!can(actor, 'busCheckRestock')) throw forbidden();
  const i = parse(restockIn, body);
  const ids = [...new Set(i.ids)], ag = actor.agencyId;
  const rows = await all<any>(env.DB, `SELECT i.id, i.vehicle_id, i.title, i.status, v.base_id FROM issues i JOIN vehicles v ON v.agency_id = i.agency_id AND v.id = i.vehicle_id
    WHERE i.agency_id = ? AND i.source = '${SHORTAGE_SOURCE}' AND i.id IN (SELECT value FROM json_each(?))`, ag, JSON.stringify(ids));
  if (rows.length !== ids.length || rows.some((r) => !vehicleInScope(actor, 'busCheckRestock', r.base_id))) throw notFound('One of those shortages does not exist.');
  if (rows.some((r) => r.status !== 'open' && r.status !== 'in_work_order')) throw conflict('Some of these shortages were already marked restocked. The list has been refreshed.', 'already_restocked');
  const tx = new Tx(env.DB, actor), js = JSON.stringify(ids);
  tx.guard(`(SELECT COUNT(*) FROM issues WHERE agency_id = ? AND source = '${SHORTAGE_SOURCE}' AND status IN ('open', 'in_work_order') AND id IN (SELECT value FROM json_each(?))) = ?`, ag, js, ids.length);
  const add = `\n\nRestocked by ${actor.name} on ${dmyHM(tx.at)}.${i.note ? ' Note: ' + i.note : ''}`;
  tx.run(
    `UPDATE issues SET status = '${RESTOCKED}', restocked_at = ?, restocked_by = ?, description = CASE WHEN length(description) + length(?) <= 4000 THEN description || ? ELSE description END, seq = ${SEQ}, updated_at = ?
     WHERE agency_id = ? AND source = '${SHORTAGE_SOURCE}' AND id IN (SELECT value FROM json_each(?))`,
    tx.at, actor.id, add, add, tx.at, ag, js,
  );
  tx.auditMany(rows.map((r) => ({ action: 'issue.restock', entityType: 'issue', entityId: r.id as string, before: { status: r.status }, after: { status: RESTOCKED, vehicleId: r.vehicle_id, title: r.title, ...(i.note ? { note: i.note } : {}) } })));
  await tx.commit();
  return { ok: true, restocked: ids.length };
}
