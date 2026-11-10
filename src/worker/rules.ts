/**
 * Business rules. This is the single source of truth: the browser only asks, the Worker decides.
 * Each function reads what it needs, decides, then writes everything in ONE D1 batch (atomic).
 */
import { z } from 'zod';
import type { Env } from './env';
import { Tx, SEQ, all, first, b2i } from './db';
import { bad, forbidden, notFound, conflict, uid, zId, zDate, zText, parse } from './http';
import { loadDoc } from './docs';
import { canOnVehicle, canWorkWO, can, type Actor } from '../shared/perm';
import { checkReading, gyDate, pmTaskStatus, woTotal, needsApproval, weightedAvgCost } from '../shared/pure';
import { HOLD, REPAIR_CODES, WO_TYPES, PRIO, STATUS, isAvail, isOos, LINE_KINDS } from '../shared/constants';

/* ---------- settings ---------- */
export const DEFAULT_SETTINGS = { approvalThresholdGYD: 150000, dueSoonHours: 25, dueSoonDays: 14, comebackDays: 30, dueSoonKm: 1000, features: { uploads: false } };
export async function getSettings(db: D1Database) {
  const r = await first<any>(db, "SELECT data FROM settings WHERE id = 'main'");
  let d = {};
  try { d = r ? JSON.parse(r.data) : {}; } catch { /* ignore */ }
  const s = { ...DEFAULT_SETTINGS, ...d } as typeof DEFAULT_SETTINGS;
  // Site-wide features live under `features` and are changed only by the super user. A missing or odd value always means OFF.
  s.features = { uploads: (s.features as any)?.uploads === true };
  return s;
}
const todayGY = () => gyDate(Date.now());

/* ---------- small loaders ---------- */
async function vehicleRow(db: D1Database, id: string) {
  const v = await first<any>(db, 'SELECT * FROM vehicles WHERE id = ?', id);
  if (!v) throw notFound('That unit does not exist.');
  return v;
}
const vSnap = (v: any) => ({ id: v.id, unit: v.unit, status: v.status, statusReason: v.status_reason, baseId: v.base_id, engineHours: v.engine_hours, odometerKm: v.odometer_km });

/* ---------- status ---------- */
function writeStatus(tx: Tx, v: any, to: string, reason: string, expectedReturn: string | null, woId: string | null) {
  const at = tx.at;
  tx.run(
    `INSERT INTO status_events (id, vehicle_id, from_status, to_status, reason, at, by_user, wo_id, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,${SEQ},?,?)`,
    uid('se'), v.id, v.status, to, reason || '', at, tx.actor?.id ?? null, woId, at, at,
  );
  tx.run(
    `UPDATE vehicles SET status=?, status_reason=?, status_since=?, expected_return=?, seq=${SEQ}, updated_at=? WHERE id=?`,
    to, to === 'in_service' ? '' : reason || '', at, to === 'in_service' ? null : expectedReturn || null, at, v.id,
  );
  v.status = to;
}

const statusIn = z.object({ to: z.enum(Object.keys(STATUS) as [string, ...string[]]), reason: zText(160).default(''), expectedReturn: zDate.nullish() });
export async function changeStatus(env: Env, actor: Actor, vehicleId: string, body: unknown) {
  const i = parse(statusIn, body);
  const v = await vehicleRow(env.DB, vehicleId);
  if (!canOnVehicle(actor, 'status', v.base_id)) throw forbidden();
  if (i.to === v.status) throw bad('The unit already has that status.');
  if (i.to !== 'in_service' && !i.reason) throw bad('Add a reason so the crews know why.');
  const before = vSnap(v);
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT status FROM vehicles WHERE id = ?) = ?', v.id, v.status);
  writeStatus(tx, v, i.to, i.reason, i.expectedReturn ?? null, null);
  tx.audit('vehicle.status', 'vehicle', v.id, before, { status: i.to, reason: i.reason });
  await tx.commit();
  return { ok: true };
}

/* ---------- meter readings ---------- */
const readingIn = z.object({ hours: z.number().finite().min(0).max(10_000_000), km: z.number().finite().min(0).max(100_000_000).nullish(), accept: z.boolean().optional(), source: z.enum(['manual', 'inspection']).optional() });

/** Adds statements for one reading. Suspicious readings are saved flagged and do NOT change the vehicle until a supervisor accepts them. */
async function addReading(tx: Tx, db: D1Database, v: any, hours: number, km: number | null, source: string, accept: boolean) {
  const last = await first<any>(db, 'SELECT hours, at FROM meter_readings WHERE vehicle_id = ? AND flagged = 0 ORDER BY at DESC LIMIT 1', v.id);
  const warn = checkReading(v.engine_hours || 0, last, hours, Date.now(), v.odometer_km, km);
  const flagged = warn.length > 0 && !accept;
  const id = uid('mr');
  tx.run(
    `INSERT INTO meter_readings (id, vehicle_id, at, hours, km, source, by_user, flagged, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,${SEQ},?,?)`,
    id, v.id, tx.at, hours, km ?? null, source, tx.actor?.id ?? null, b2i(flagged), tx.at, tx.at,
  );
  if (!flagged) {
    tx.run(`UPDATE vehicles SET engine_hours=?, odometer_km=COALESCE(?, odometer_km), seq=${SEQ}, updated_at=? WHERE id=?`, hours, km ?? null, tx.at, v.id);
    v.engine_hours = hours;
    if (km != null) v.odometer_km = km;
  }
  return { id, flagged, warnings: warn };
}

export async function logReading(env: Env, actor: Actor, vehicleId: string, body: unknown) {
  const i = parse(readingIn, body);
  const v = await vehicleRow(env.DB, vehicleId);
  if (!canOnVehicle(actor, 'reading', v.base_id)) throw forbidden();
  const accept = !!i.accept && canOnVehicle(actor, 'confirmReading', v.base_id);
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT engine_hours FROM vehicles WHERE id = ?) = ?', v.id, v.engine_hours);
  const res = await addReading(tx, env.DB, v, i.hours, i.km ?? null, i.source ?? 'manual', accept);
  tx.audit('reading.log', 'vehicle', v.id, { engineHours: vSnap(v).engineHours }, { hours: i.hours, km: i.km ?? null, flagged: res.flagged });
  await tx.commit();
  return { ok: true, flagged: res.flagged, warnings: res.warnings };
}

export async function acceptReading(env: Env, actor: Actor, readingId: string) {
  const r = await first<any>(env.DB, 'SELECT * FROM meter_readings WHERE id = ?', readingId);
  if (!r) throw notFound();
  const v = await vehicleRow(env.DB, r.vehicle_id);
  if (!canOnVehicle(actor, 'confirmReading', v.base_id)) throw forbidden();
  if (!r.flagged) throw conflict('That reading is already accepted.');
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT flagged FROM meter_readings WHERE id = ?) = 1', r.id);
  tx.run(`UPDATE meter_readings SET flagged=0, seq=${SEQ}, updated_at=? WHERE id=?`, tx.at, r.id);
  tx.run(`UPDATE vehicles SET engine_hours=?, odometer_km=COALESCE(?, odometer_km), seq=${SEQ}, updated_at=? WHERE id=?`, r.hours, r.km, tx.at, v.id);
  tx.audit('reading.accept', 'meter_reading', r.id, { flagged: true, vehicleHours: v.engine_hours }, { flagged: false, vehicleHours: r.hours });
  await tx.commit();
  return { ok: true };
}

/* ---------- issues ---------- */
const issueIn = z.object({
  vehicleId: zId, title: zText(120).min(1, 'Say what is wrong.'), description: zText(4000).default(''),
  severity: z.enum(['critical', 'major', 'minor']), hours: z.number().finite().min(0).max(10_000_000).nullish(),
});
export async function reportIssue(env: Env, actor: Actor, body: unknown) {
  const i = parse(issueIn, body);
  const v = await vehicleRow(env.DB, i.vehicleId);
  if (!canOnVehicle(actor, 'report', v.base_id)) throw forbidden();
  const id = uid('is');
  const tx = new Tx(env.DB, actor);
  const hoursAt = i.hours ?? v.engine_hours;
  tx.run(
    `INSERT INTO issues (id, vehicle_id, title, description, severity, status, reported_at, by_user, wo_id, hours, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,'open',?,?,NULL,?,0,${SEQ},?,?)`,
    id, v.id, i.title, i.description, i.severity, tx.at, actor.id, hoursAt, tx.at, tx.at,
  );
  // Hours typed with the report are logged as an inspection reading (and flagged if suspicious), as in the prototype.
  if (i.hours != null && i.hours !== v.engine_hours) await addReading(tx, env.DB, v, i.hours, null, 'inspection', false);
  // A critical problem takes an available unit out of service straight away.
  if (i.severity === 'critical' && isAvail(v.status)) writeStatus(tx, v, 'oos_repair', 'Critical problem: ' + i.title, null, null);
  tx.audit('issue.report', 'issue', id, null, { vehicleId: v.id, title: i.title, severity: i.severity });
  await tx.commit();
  const issue = await loadDoc(env.DB, 'issues', id);
  return { ok: true, id, issue, vehicle: v };
}

export async function dismissIssue(env: Env, actor: Actor, issueId: string) {
  const is = await first<any>(env.DB, 'SELECT * FROM issues WHERE id = ?', issueId);
  if (!is) throw notFound();
  const v = await vehicleRow(env.DB, is.vehicle_id);
  if (!canOnVehicle(actor, 'issues', v.base_id)) throw forbidden();
  if (is.status !== 'open') throw conflict('Only open problems can be dismissed.');
  const tx = new Tx(env.DB, actor);
  tx.guard("(SELECT status FROM issues WHERE id = ?) = 'open'", is.id);
  tx.run(`UPDATE issues SET status='dismissed', seq=${SEQ}, updated_at=? WHERE id=?`, tx.at, is.id);
  tx.audit('issue.dismiss', 'issue', is.id, { status: 'open' }, { status: 'dismissed' });
  await tx.commit();
  return { ok: true };
}

/* ---------- work orders ---------- */
const woIn = z.object({
  vehicleId: zId, type: z.enum(Object.keys(WO_TYPES) as [string, ...string[]]), priority: z.enum(Object.keys(PRIO) as [string, ...string[]]).default('normal'),
  mechanicId: zId.nullish(), scheduledFor: zDate.nullish(), notes: zText(4000).default(''),
  pmTaskIds: z.array(zId).max(100).default([]), issueIds: z.array(zId).max(100).default([]),
});
async function nextNumber(db: D1Database) {
  const r = await first<any>(db, "SELECT MAX(CAST(SUBSTR(number, 4) AS INTEGER)) AS m FROM work_orders");
  return 'WO-' + String((r?.m || 0) + 1).padStart(4, '0');
}
export async function createWorkOrder(env: Env, actor: Actor, body: unknown) {
  const i = parse(woIn, body);
  const v = await vehicleRow(env.DB, i.vehicleId);
  if (!canOnVehicle(actor, 'createWO', v.base_id)) throw forbidden();
  if (i.type === 'preventive' && !i.pmTaskIds.length) throw bad('Pick at least one PM task for a preventive work order.');
  if (i.mechanicId && !(await first(env.DB, 'SELECT 1 FROM mechanics WHERE id = ?', i.mechanicId))) throw bad('That mechanic does not exist.');
  // PM tasks must belong to the unit's program; problems must be open problems on this unit.
  const vdoc = await loadDoc(env.DB, 'vehicles', v.id);
  const prog = v.pm_program_id ? await loadDoc(env.DB, 'pmPrograms', v.pm_program_id) : null;
  const tasks: any[] = prog?.tasks || [];
  for (const t of i.pmTaskIds) if (!tasks.find((x) => x.id === t)) throw bad('One of the PM tasks does not belong to this unit.');
  for (const iid of i.issueIds) {
    const is = await first<any>(env.DB, 'SELECT vehicle_id, status FROM issues WHERE id = ?', iid);
    if (!is || is.vehicle_id !== v.id) throw bad('One of the problems is not on this unit.');
    if (is.status !== 'open') throw conflict('One of the problems already has a work order.');
  }
  const S = await getSettings(env.DB);
  const cur = { hours: v.engine_hours || 0, km: v.odometer_km || 0, date: todayGY() };
  const overdue = i.pmTaskIds.filter((t) => { const task = tasks.find((x) => x.id === t); return task && pmTaskStatus(task, vdoc.pm?.[t], cur, S).state === 'overdue'; }).length;

  for (let attempt = 0; attempt < 4; attempt++) {
    const id = uid('wo');
    const number = await nextNumber(env.DB);
    const tx = new Tx(env.DB, actor);
    tx.run(
      `INSERT INTO work_orders (id, number, vehicle_id, type, priority, status, hold_reason, mechanic_id, opened_at, scheduled_for, started_at, completed_at, closed_at, hours_at_open, hours_at_complete, km_at_complete, notes, approval_needed, approved_by, by_user, overdue_at_open, hold_log, sample, seq, created_at, updated_at)
       VALUES (?,?,?,?,?,'open',NULL,?,?,?,NULL,NULL,NULL,?,NULL,NULL,?,0,NULL,?,?,'[]',0,${SEQ},?,?)`,
      id, number, v.id, i.type, i.priority, i.mechanicId ?? null, tx.at, i.scheduledFor ?? null, v.engine_hours, i.notes, actor.id, overdue, tx.at, tx.at,
    );
    for (const t of i.pmTaskIds) tx.run('INSERT INTO wo_pm_tasks (wo_id, task_id, created_at) VALUES (?,?,?)', id, t, tx.at);
    for (const iid of i.issueIds) {
      tx.run('INSERT INTO wo_issue_links (wo_id, issue_id, created_at) VALUES (?,?,?)', id, iid, tx.at);
      tx.run(`UPDATE issues SET status='in_work_order', wo_id=?, seq=${SEQ}, updated_at=? WHERE id=? AND status='open'`, id, tx.at, iid);
    }
    tx.audit('wo.create', 'work_order', id, null, { number, vehicleId: v.id, type: i.type, issueIds: i.issueIds, pmTaskIds: i.pmTaskIds });
    try { await tx.commit(); return { ok: true, id, number }; }
    catch (e: any) { if (e?.status === 409 && e.code === 'wo_number_taken') continue; throw e; }
  }
  throw conflict('Please try again.');
}

async function woContext(env: Env, id: string) {
  const wo = await loadDoc(env.DB, 'workOrders', id);
  if (!wo) throw notFound('That work order no longer exists.');
  const v = await vehicleRow(env.DB, wo.vehicleId);
  return { wo, v };
}
const woEditable = (w: any) => w.status !== 'closed' && w.status !== 'cancelled';

const lineIn = z.object({
  kind: z.enum(LINE_KINDS), description: zText(140).min(1, 'Describe the work.'), repairCode: z.enum(REPAIR_CODES as [string, ...string[]]).default('Other'),
  qty: z.number().finite().gt(0).max(1_000_000), unitCost: z.number().finite().min(0).max(1_000_000_000), partId: zId.nullish(), warranty: z.boolean().default(false),
});
export async function addLine(env: Env, actor: Actor, woId: string, body: unknown) {
  const i = parse(lineIn, body);
  const { wo, v } = await woContext(env, woId);
  if (!canWorkWO(actor, wo, v.base_id)) throw forbidden();
  if (!woEditable(wo)) throw conflict('This work order is locked. Lines cannot be changed.');
  if (i.kind === 'part') {
    if (!i.partId) throw bad('Pick the part used.');
    if (!(await first(env.DB, 'SELECT 1 FROM parts WHERE id = ?', i.partId))) throw bad('That part does not exist.');
  }
  const S = await getSettings(env.DB);
  const line = { id: uid('l'), ...i, partId: i.kind === 'part' ? i.partId ?? null : null };
  const total = woTotal({ lines: [...wo.lines, line] });
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT status FROM work_orders WHERE id = ?) = ?', wo.id, wo.status);
  tx.run(
    'INSERT INTO work_order_lines (wo_id, id, kind, description, repair_code, qty, unit_cost, part_id, warranty, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    wo.id, line.id, line.kind, line.description, line.repairCode, line.qty, line.unitCost, line.partId, b2i(line.warranty), wo.lines.length, tx.at, tx.at,
  );
  tx.run(`UPDATE work_orders SET approval_needed=?, seq=${SEQ}, updated_at=? WHERE id=?`, wo.status === 'open' ? b2i(needsApproval(total, S.approvalThresholdGYD)) : b2i(wo.approvalNeeded), tx.at, wo.id);
  tx.audit('wo.line.add', 'work_order', wo.id, null, line);
  await tx.commit();
  return { ok: true, lineId: line.id };
}
export async function removeLine(env: Env, actor: Actor, woId: string, lineId: string) {
  const { wo, v } = await woContext(env, woId);
  if (!canWorkWO(actor, wo, v.base_id)) throw forbidden();
  if (!woEditable(wo)) throw conflict('This work order is locked. Lines cannot be changed.');
  const line = wo.lines.find((l: any) => l.id === lineId);
  if (!line) throw notFound('That line is already gone.');
  const S = await getSettings(env.DB);
  const total = woTotal({ lines: wo.lines.filter((l: any) => l.id !== lineId) });
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT status FROM work_orders WHERE id = ?) = ?', wo.id, wo.status);
  tx.run('DELETE FROM work_order_lines WHERE wo_id = ? AND id = ?', wo.id, lineId);
  tx.run(`UPDATE work_orders SET approval_needed=?, seq=${SEQ}, updated_at=? WHERE id=?`, wo.status === 'open' ? b2i(needsApproval(total, S.approvalThresholdGYD)) : b2i(wo.approvalNeeded), tx.at, wo.id);
  tx.audit('wo.line.remove', 'work_order', wo.id, line, null);
  await tx.commit();
  return { ok: true };
}

const woPatchIn = z.object({ priority: z.enum(Object.keys(PRIO) as [string, ...string[]]).optional(), mechanicId: zId.nullable().optional(), notes: zText(4000).optional() });
export async function patchWorkOrder(env: Env, actor: Actor, woId: string, body: unknown) {
  const i = parse(woPatchIn, body);
  const { wo, v } = await woContext(env, woId);
  if (!woEditable(wo)) throw conflict('This work order is locked.');
  const planner = canOnVehicle(actor, 'createWO', v.base_id);
  const worker = canWorkWO(actor, wo, v.base_id);
  if ((i.priority !== undefined || i.mechanicId !== undefined) && !planner) throw forbidden();
  if (i.notes !== undefined && !(worker || planner)) throw forbidden();
  if (i.mechanicId && !(await first(env.DB, 'SELECT 1 FROM mechanics WHERE id = ?', i.mechanicId))) throw bad('That mechanic does not exist.');
  const sets: string[] = [], ps: unknown[] = [];
  if (i.priority !== undefined) { sets.push('priority=?'); ps.push(i.priority); }
  if (i.mechanicId !== undefined) { sets.push('mechanic_id=?'); ps.push(i.mechanicId); }
  if (i.notes !== undefined) { sets.push('notes=?'); ps.push(i.notes); }
  if (!sets.length) return { ok: true };
  const tx = new Tx(env.DB, actor);
  tx.run(`UPDATE work_orders SET ${sets.join(', ')}, seq=${SEQ}, updated_at=? WHERE id=?`, ...ps, tx.at, wo.id);
  tx.audit('wo.update', 'work_order', wo.id, { priority: wo.priority, mechanicId: wo.mechanicId, notes: wo.notes }, i);
  await tx.commit();
  return { ok: true };
}

const defaultOos = (wo: any) => (wo.type === 'preventive' ? 'oos_pm' : 'oos_repair');
const transitionIn = z.object({
  action: z.enum(['approve', 'schedule', 'start', 'hold', 'resume', 'complete', 'close', 'cancel']),
  date: zDate.nullish(), expectedReturn: zDate.nullish(), reason: z.enum(Object.keys(HOLD) as [string, ...string[]]).nullish(),
  hours: z.number().finite().min(0).max(10_000_000).nullish(), km: z.number().finite().min(0).max(100_000_000).nullish(),
});
export async function transitionWorkOrder(env: Env, actor: Actor, woId: string, body: unknown) {
  const i = parse(transitionIn, body);
  const { wo, v } = await woContext(env, woId);
  const base = v.base_id;
  const tx = new Tx(env.DB, actor);
  const need = (status: string | string[]) => {
    const ok = Array.isArray(status) ? status.includes(wo.status) : wo.status === status;
    if (!ok) throw conflict(`This work order is ${wo.status.replace('_', ' ')}, so that step is not possible. Refresh and try again.`, 'stale');
  };
  const setWo = (sets: string, ...ps: unknown[]) => tx.run(`UPDATE work_orders SET ${sets}, seq=${SEQ}, updated_at=? WHERE id=?`, ...ps, tx.at, wo.id);
  tx.guard('(SELECT status FROM work_orders WHERE id = ?) = ?', wo.id, wo.status);
  const before = { status: wo.status };
  let after: any;

  switch (i.action) {
    case 'approve':
      if (!can(actor, 'approve')) throw forbidden();
      need('open');
      if (!wo.approvalNeeded) throw bad('This work order does not need approval.');
      setWo("status='approved', approved_by=?", actor.id);
      after = { status: 'approved' };
      break;
    case 'schedule':
      if (!canOnVehicle(actor, 'createWO', base)) throw forbidden();
      need(['open', 'approved']);
      if (wo.status === 'open' && wo.approvalNeeded) throw conflict('This work order needs fleet manager approval first.', 'needs_approval');
      if (!i.date) throw bad('Pick a date to schedule the work.');
      setWo("status='scheduled', scheduled_for=?", i.date);
      after = { status: 'scheduled', scheduledFor: i.date };
      break;
    case 'start':
      if (!canWorkWO(actor, wo, base)) throw forbidden();
      need('scheduled');
      if (!isOos(v.status) && v.status !== 'decommissioned') writeStatus(tx, v, defaultOos(wo), `${wo.number}: work started`, i.expectedReturn ?? null, wo.id);
      setWo("status='in_progress', started_at=?, hold_reason=NULL", wo.startedAt || tx.at);
      after = { status: 'in_progress' };
      break;
    case 'hold': {
      if (!canWorkWO(actor, wo, base)) throw forbidden();
      need('in_progress');
      if (!i.reason) throw bad('Choose why the work order is on hold.');
      const log = [...(wo.holdLog || []), { reason: i.reason, from: tx.at, to: null }];
      if (i.reason === 'parts' && v.status !== 'decommissioned' && v.status !== 'oos_parts') writeStatus(tx, v, 'oos_parts', `Waiting for parts (${wo.number})`, null, wo.id);
      setWo("status='on_hold', hold_reason=?, hold_log=?", i.reason, JSON.stringify(log));
      after = { status: 'on_hold', reason: i.reason };
      break;
    }
    case 'resume': {
      if (!canWorkWO(actor, wo, base)) throw forbidden();
      need('on_hold');
      const log = (wo.holdLog || []).map((h: any, k: number, a: any[]) => (k === a.length - 1 && !h.to ? { ...h, to: tx.at } : h));
      if (v.status === 'oos_parts') writeStatus(tx, v, defaultOos(wo), `Parts arrived (${wo.number})`, null, wo.id);
      setWo("status='in_progress', hold_reason=NULL, hold_log=?", JSON.stringify(log));
      after = { status: 'in_progress' };
      break;
    }
    case 'complete': {
      if (!canWorkWO(actor, wo, base)) throw forbidden();
      need('in_progress');
      const hrs = i.hours, km = i.km ?? null;
      if (hrs == null || !(hrs >= 0)) throw bad('Enter the engine hours at completion.');
      if (hrs < (v.engine_hours || 0)) throw bad(`Hours cannot be lower than the unit's current ${v.engine_hours} h.`);
      if (km != null && km < (v.odometer_km || 0)) throw bad(`Kilometres cannot be lower than the unit's current ${v.odometer_km} km.`);
      // 1. PM tasks done by this job are reset
      for (const t of wo.pmTaskIds || []) {
        tx.run(
          `INSERT INTO vehicle_pm (vehicle_id, task_id, last_hours, last_km, last_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (vehicle_id, task_id) DO UPDATE SET last_hours=excluded.last_hours, last_km=excluded.last_km, last_date=excluded.last_date, updated_at=excluded.updated_at`,
          v.id, t, hrs, km ?? v.odometer_km ?? null, todayGY(), tx.at, tx.at,
        );
      }
      // 2. meter reading + the unit's hours
      tx.run(
        `INSERT INTO meter_readings (id, vehicle_id, at, hours, km, source, by_user, flagged, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,'work_order',?,0,0,${SEQ},?,?)`,
        uid('mr'), v.id, tx.at, hrs, km, actor.id, tx.at, tx.at,
      );
      tx.run(`UPDATE vehicles SET engine_hours=?, odometer_km=COALESCE(?, odometer_km), seq=${SEQ}, updated_at=? WHERE id=?`, hrs, km, tx.at, v.id);
      // 3. stock comes off the shelf (never below zero)
      const use: Record<string, number> = {};
      for (const l of wo.lines || []) if (l.partId) use[l.partId] = (use[l.partId] || 0) + (Number(l.qty) || 0);
      for (const [pid, q] of Object.entries(use)) tx.run(`UPDATE parts SET on_hand = MAX(0, on_hand - ?), seq=${SEQ}, updated_at=? WHERE id=?`, q, tx.at, pid);
      // 4. linked problems are resolved
      for (const iid of wo.issueIds || []) tx.run(`UPDATE issues SET status='resolved', seq=${SEQ}, updated_at=? WHERE id=?`, tx.at, iid);
      // 5. back in service, unless another job on this unit is still going
      const others = await first(env.DB, "SELECT 1 FROM work_orders WHERE vehicle_id = ? AND id <> ? AND status IN ('in_progress','on_hold')", v.id, wo.id);
      if (isOos(v.status) && !others) writeStatus(tx, v, 'in_service', `${wo.number} completed`, null, wo.id);
      setWo("status='completed', completed_at=?, hours_at_complete=?, km_at_complete=?, hold_reason=NULL", tx.at, hrs, km);
      after = { status: 'completed', hours: hrs, km };
      break;
    }
    case 'close':
      if (!canOnVehicle(actor, 'closeWO', base)) throw forbidden();
      need('completed');
      setWo("status='closed', closed_at=?", tx.at);
      after = { status: 'closed' };
      break;
    case 'cancel':
      if (!canOnVehicle(actor, 'cancelWO', base)) throw forbidden();
      need(['open', 'approved', 'scheduled', 'in_progress', 'on_hold', 'completed']);
      for (const iid of wo.issueIds || []) tx.run(`UPDATE issues SET status='open', wo_id=NULL, seq=${SEQ}, updated_at=? WHERE id=? AND status='in_work_order'`, tx.at, iid);
      setWo("status='cancelled', hold_reason=NULL");
      after = { status: 'cancelled' };
      break;
  }
  tx.audit('wo.' + i.action, 'work_order', wo.id, before, after);
  await tx.commit();
  return { ok: true, status: after.status };
}

/* ---------- moves ---------- */
const moveIn = z.object({ vehicleIds: z.array(zId).min(1).max(200), toBaseId: zId, reason: zText(160).default(''), tempUntil: zDate.nullish() });
export async function moveUnits(env: Env, actor: Actor, body: unknown) {
  const i = parse(moveIn, body);
  if (!can(actor, 'move')) throw forbidden();
  if (!(await first(env.DB, 'SELECT 1 FROM bases WHERE id = ?', i.toBaseId))) throw bad('That base does not exist.');
  if (i.tempUntil && i.tempUntil <= todayGY()) throw bad('Pick a date in the future for the temporary move.');
  const ids = [...new Set(i.vehicleIds)];
  const vs: any[] = [];
  for (const id of ids) {
    const v = await vehicleRow(env.DB, id);
    if (!canOnVehicle(actor, 'move', v.base_id)) throw forbidden(`You can only move units from your own base. ${v.unit} is not at your base.`);
    vs.push(v);
  }
  const tx = new Tx(env.DB, actor);
  let n = 0;
  for (const v of vs) {
    if (v.base_id === i.toBaseId) continue;
    const from = v.base_id;
    const home = i.tempUntil ? v.temp_from_base_id || from : i.toBaseId;
    tx.run(
      `INSERT INTO moves (id, vehicle_id, from_base_id, to_base_id, at, by_user, reason, temp_until, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,${SEQ},?,?)`,
      uid('mv'), v.id, from, i.toBaseId, tx.at, actor.id, i.reason, i.tempUntil ?? null, v.sample ? 1 : 0, tx.at, tx.at,
    );
    tx.run(
      `UPDATE vehicles SET base_id=?, home_base_id=?, temp_until=?, temp_from_base_id=?, seq=${SEQ}, updated_at=? WHERE id=?`,
      i.toBaseId, home, i.tempUntil ?? null, i.tempUntil ? home : null, tx.at, v.id,
    );
    tx.audit('vehicle.move', 'vehicle', v.id, { baseId: from }, { baseId: i.toBaseId, tempUntil: i.tempUntil ?? null });
    n++;
  }
  if (n) await tx.commit();
  return { ok: true, moved: n };
}

/* ---------- vehicles ---------- */
const vehicleBase = {
  unit: zText(30).min(1, 'Enter a unit name.'), plate: zText(20).default(''), vin: zText(24).default(''), make: zText(60).min(1, 'Enter the make.'), model: zText(60).min(1, 'Enter the model.'),
  year: z.number().int().min(1950).max(2100).nullish(), type: zText(60).default(''), baseId: zId, inServiceDate: zDate.nullish(), warrantyEnd: zDate.nullish(),
  engineHours: z.number().finite().min(0).max(10_000_000).default(0), odometerKm: z.number().finite().min(0).max(100_000_000).default(0),
  pmProgramId: zId.nullish(), notes: zText(2000).default(''),
};
const vehicleCreateIn = z.object({ ...vehicleBase, pmStart: z.enum(['today', 'never']).default('today') });
const vehicleEditIn = z.object(vehicleBase);
async function checkUnitFree(db: D1Database, unit: string, exceptId?: string) {
  const r = await first<any>(db, 'SELECT id FROM vehicles WHERE lower(unit) = lower(?)', unit);
  if (r && r.id !== exceptId) throw conflict('Another unit already uses that name.', 'duplicate_unit');
}
export async function createVehicle(env: Env, actor: Actor, body: unknown) {
  if (!can(actor, 'editVehicle')) throw forbidden();
  const i = parse(vehicleCreateIn, body);
  await checkUnitFree(env.DB, i.unit);
  if (!(await first(env.DB, 'SELECT 1 FROM bases WHERE id = ?', i.baseId))) throw bad('Pick a base for the unit.');
  const prog = i.pmProgramId ? await loadDoc(env.DB, 'pmPrograms', i.pmProgramId) : null;
  if (i.pmProgramId && !prog) throw bad('That PM program does not exist.');
  const id = uid('v');
  const tx = new Tx(env.DB, actor);
  tx.run(
    `INSERT INTO vehicles (id, unit, plate, vin, make, model, year, type, base_id, home_base_id, in_service_date, status, status_reason, status_since, expected_return, engine_hours, odometer_km, pm_program_id, warranty_end, notes, sample, seq, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,'in_service','',?,NULL,?,?,?,?,?,0,${SEQ},?,?)`,
    id, i.unit, i.plate, i.vin, i.make, i.model, i.year ?? null, i.type, i.baseId, i.inServiceDate ?? null, tx.at, i.engineHours, i.odometerKm, i.pmProgramId ?? null, i.warrantyEnd ?? null, i.notes, tx.at, tx.at,
  );
  if (prog && i.pmStart === 'today') for (const t of prog.tasks) tx.run('INSERT INTO vehicle_pm (vehicle_id, task_id, last_hours, last_km, last_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, t.id, i.engineHours, i.odometerKm, todayGY(), tx.at, tx.at);
  tx.run(
    `INSERT INTO meter_readings (id, vehicle_id, at, hours, km, source, by_user, flagged, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,'manual',?,0,0,${SEQ},?,?)`,
    uid('mr'), id, tx.at, i.engineHours, i.odometerKm, actor.id, tx.at, tx.at,
  );
  tx.audit('vehicle.create', 'vehicle', id, null, { unit: i.unit, baseId: i.baseId });
  await tx.commit();
  return { ok: true, id };
}
export async function editVehicle(env: Env, actor: Actor, id: string, body: unknown) {
  if (!can(actor, 'editVehicle')) throw forbidden();
  const i = parse(vehicleEditIn, body);
  const v = await vehicleRow(env.DB, id);
  await checkUnitFree(env.DB, i.unit, id);
  if (!(await first(env.DB, 'SELECT 1 FROM bases WHERE id = ?', i.baseId))) throw bad('Pick a base for the unit.');
  if (i.pmProgramId && !(await first(env.DB, 'SELECT 1 FROM pm_programs WHERE id = ?', i.pmProgramId))) throw bad('That PM program does not exist.');
  const tx = new Tx(env.DB, actor);
  tx.run(
    `UPDATE vehicles SET unit=?, plate=?, vin=?, make=?, model=?, year=?, type=?, base_id=?, in_service_date=?, warranty_end=?, engine_hours=?, odometer_km=?, pm_program_id=?, notes=?, seq=${SEQ}, updated_at=? WHERE id=?`,
    i.unit, i.plate, i.vin, i.make, i.model, i.year ?? null, i.type, i.baseId, i.inServiceDate ?? null, i.warrantyEnd ?? null, i.engineHours, i.odometerKm, i.pmProgramId ?? null, i.notes, tx.at, id,
  );
  tx.audit('vehicle.update', 'vehicle', id, vSnap(v), { unit: i.unit, baseId: i.baseId, engineHours: i.engineHours, odometerKm: i.odometerKm });
  await tx.commit();
  return { ok: true };
}

/* ---------- parts, mechanics, bases, programs, settings ---------- */
const partIn = z.object({
  number: zText(40).min(1), description: zText(200).min(1), fits: zText(200).default(''),
  onHand: z.number().finite().min(0).max(1e9).default(0), reorderPoint: z.number().finite().min(0).max(1e9).default(0), unitCost: z.number().finite().min(0).max(1e10).default(0),
});
export async function savePart(env: Env, actor: Actor, id: string | null, body: unknown) {
  if (!can(actor, 'parts')) throw forbidden();
  const i = parse(partIn, body);
  const tx = new Tx(env.DB, actor);
  if (id) {
    const old = await first<any>(env.DB, 'SELECT * FROM parts WHERE id = ?', id);
    if (!old) throw notFound();
    tx.run(`UPDATE parts SET number=?, description=?, fits=?, on_hand=?, reorder_point=?, unit_cost=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.number, i.description, i.fits, i.onHand, i.reorderPoint, i.unitCost, tx.at, id);
    tx.audit('part.update', 'part', id, { onHand: old.on_hand, unitCost: old.unit_cost, number: old.number }, i);
  } else {
    id = uid('p');
    tx.run(`INSERT INTO parts (id, number, description, fits, on_hand, reorder_point, unit_cost, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,${SEQ},?,?)`, id, i.number, i.description, i.fits, i.onHand, i.reorderPoint, i.unitCost, tx.at, tx.at);
    tx.audit('part.create', 'part', id, null, i);
  }
  await tx.commit();
  return { ok: true, id };
}
const receiveIn = z.object({ qty: z.number().finite().gt(0).max(1e9), cost: z.number().finite().min(0).max(1e10) });
export async function receivePart(env: Env, actor: Actor, id: string, body: unknown) {
  if (!can(actor, 'parts')) throw forbidden();
  const i = parse(receiveIn, body);
  const p = await first<any>(env.DB, 'SELECT * FROM parts WHERE id = ?', id);
  if (!p) throw notFound();
  const avg = weightedAvgCost(p.on_hand || 0, p.unit_cost || 0, i.qty, i.cost);
  const tx = new Tx(env.DB, actor);
  tx.guard('(SELECT on_hand FROM parts WHERE id = ?) = ?', id, p.on_hand);
  tx.run(`UPDATE parts SET on_hand = on_hand + ?, unit_cost=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.qty, avg, tx.at, id);
  tx.audit('part.receive', 'part', id, { onHand: p.on_hand, unitCost: p.unit_cost }, { onHand: p.on_hand + i.qty, unitCost: avg, received: i.qty, cost: i.cost });
  await tx.commit();
  return { ok: true, unitCost: avg };
}
const mechIn = z.object({ name: zText(120).min(1), shop: zText(160).default(''), phone: zText(40).default(''), region: zText(80).default('') });
export async function saveMechanic(env: Env, actor: Actor, id: string | null, body: unknown) {
  if (!can(actor, 'mechanics')) throw forbidden();
  const i = parse(mechIn, body);
  const tx = new Tx(env.DB, actor);
  if (id) {
    const old = await first<any>(env.DB, 'SELECT * FROM mechanics WHERE id = ?', id);
    if (!old) throw notFound();
    tx.run(`UPDATE mechanics SET name=?, shop=?, phone=?, region=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.name, i.shop, i.phone, i.region, tx.at, id);
    tx.audit('mechanic.update', 'mechanic', id, { name: old.name, shop: old.shop }, i);
  } else {
    id = uid('m');
    tx.run(`INSERT INTO mechanics (id, name, shop, phone, region, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,0,${SEQ},?,?)`, id, i.name, i.shop, i.phone, i.region, tx.at, tx.at);
    tx.audit('mechanic.create', 'mechanic', id, null, i);
  }
  await tx.commit();
  return { ok: true, id };
}
const baseIn = z.object({ name: zText(80).min(1), region: zText(80).default(''), minUnits: z.number().int().min(0).max(1000).default(0) });
export async function saveBase(env: Env, actor: Actor, id: string | null, body: unknown) {
  if (!can(actor, 'setup')) throw forbidden();
  const i = parse(baseIn, body);
  const tx = new Tx(env.DB, actor);
  if (id) {
    const old = await first<any>(env.DB, 'SELECT * FROM bases WHERE id = ?', id);
    if (!old) throw notFound();
    tx.run(`UPDATE bases SET name=?, region=?, min_units=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.name, i.region, i.minUnits, tx.at, id);
    tx.audit('base.update', 'base', id, { name: old.name, region: old.region, minUnits: old.min_units }, i);
  } else {
    id = uid('b');
    tx.run(`INSERT INTO bases (id, name, region, min_units, sample, seq, created_at, updated_at) VALUES (?,?,?,?,0,${SEQ},?,?)`, id, i.name, i.region, i.minUnits, tx.at, tx.at);
    tx.audit('base.create', 'base', id, null, i);
  }
  await tx.commit();
  return { ok: true, id };
}
const taskIn = z.object({
  id: zId.nullish(), name: zText(120).min(1, 'Every task needs a name.'), group: zText(60).default('General'),
  intervalHours: z.number().finite().positive().max(1e7).nullish(), intervalDays: z.number().finite().positive().max(1e5).nullish(), intervalKm: z.number().finite().positive().max(1e8).nullish(),
});
const programIn = z.object({ name: zText(120).min(1), appliesTo: zText(80).default(''), tasks: z.array(taskIn).min(1, 'Add at least one task.').max(200) });
export async function saveProgram(env: Env, actor: Actor, id: string | null, body: unknown) {
  if (!can(actor, 'setup')) throw forbidden();
  const i = parse(programIn, body);
  for (const t of i.tasks) if (!t.intervalHours && !t.intervalDays && !t.intervalKm) throw bad(`"${t.name}" needs an interval in hours, days or km.`);
  const tx = new Tx(env.DB, actor);
  let before: any = null;
  if (id) {
    before = await loadDoc(env.DB, 'pmPrograms', id);
    if (!before) throw notFound();
    tx.run(`UPDATE pm_programs SET name=?, applies_to=?, seq=${SEQ}, updated_at=? WHERE id=?`, i.name, i.appliesTo, tx.at, id);
  } else {
    id = uid('pm');
    tx.run(`INSERT INTO pm_programs (id, name, applies_to, sample, seq, created_at, updated_at) VALUES (?,?,?,0,${SEQ},?,?)`, id, i.name, i.appliesTo, tx.at, tx.at);
  }
  const keep = new Set<string>();
  const existing = new Set<string>((before?.tasks || []).map((t: any) => t.id));
  let sort = 0;
  for (const t of i.tasks) {
    const tid = t.id || uid('t');
    if (t.id && !existing.has(t.id)) throw bad('A task does not belong to this program.');
    keep.add(tid);
    tx.run(
      `INSERT INTO pm_tasks (id, program_id, name, grp, interval_hours, interval_days, interval_km, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET name=excluded.name, grp=excluded.grp, interval_hours=excluded.interval_hours, interval_days=excluded.interval_days, interval_km=excluded.interval_km, sort=excluded.sort, updated_at=excluded.updated_at`,
      tid, id, t.name, t.group || 'General', t.intervalHours ?? null, t.intervalDays ?? null, t.intervalKm ?? null, sort++, tx.at, tx.at,
    );
  }
  for (const old of existing) {
    if (keep.has(old)) continue;
    tx.run('DELETE FROM pm_tasks WHERE id = ?', old);
    tx.run('DELETE FROM vehicle_pm WHERE task_id = ?', old);
  }
  // Units on this program changed (PM records may have lost rows): make browsers re-read them.
  tx.run(`UPDATE vehicles SET seq=${SEQ}, updated_at=? WHERE pm_program_id=?`, tx.at, id);
  tx.audit(before ? 'program.update' : 'program.create', 'pm_program', id, before ? { name: before.name, tasks: before.tasks.length } : null, { name: i.name, tasks: i.tasks.length });
  await tx.commit();
  return { ok: true, id };
}
const settingsIn = z.object({
  approvalThresholdGYD: z.number().finite().min(0).max(1e12), dueSoonHours: z.number().finite().min(0).max(1e6), dueSoonDays: z.number().finite().min(0).max(1e5),
  comebackDays: z.number().finite().min(0).max(1e5),
});
export async function saveSettings(env: Env, actor: Actor, body: unknown) {
  if (!can(actor, 'setup')) throw forbidden();
  const i = parse(settingsIn, body);
  const old = await first<any>(env.DB, "SELECT data, sample FROM settings WHERE id = 'main'");
  let merged: any = i;
  try { merged = { ...(old ? JSON.parse(old.data) : {}), ...i }; } catch { /* ignore */ }
  const tx = new Tx(env.DB, actor);
  tx.run(
    `INSERT INTO settings (id, data, sample, seq, created_at, updated_at) VALUES ('main', ?, 0, ${SEQ}, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data=excluded.data, seq=excluded.seq, updated_at=excluded.updated_at`,
    JSON.stringify(merged), tx.at, tx.at,
  );
  tx.audit('settings.update', 'settings', 'main', old ? JSON.parse(old.data) : null, merged);
  await tx.commit();
  return { ok: true };
}

/** Site-wide switches. Super user only (set in code: SUPERUSER_EMAILS). The ordinary settings save above never touches `features`. */
const featuresIn = z.object({ uploads: z.boolean() });
export async function saveFeatures(env: Env, actor: Actor, body: unknown) {
  if (!actor.isSuper) throw forbidden('Only the super user can change features.');
  const i = parse(featuresIn, body);
  const old = await first<any>(env.DB, "SELECT data FROM settings WHERE id = 'main'");
  let cur: any = {};
  try { cur = old ? JSON.parse(old.data) : {}; } catch { /* ignore */ }
  const before = { uploads: cur.features?.uploads === true };
  const merged = { ...cur, features: { ...(cur.features || {}), uploads: i.uploads } };
  const tx = new Tx(env.DB, actor);
  tx.run(
    `INSERT INTO settings (id, data, sample, seq, created_at, updated_at) VALUES ('main', ?, 0, ${SEQ}, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data=excluded.data, seq=excluded.seq, updated_at=excluded.updated_at`,
    JSON.stringify(merged), tx.at, tx.at,
  );
  tx.audit('features.update', 'settings', 'main', before, { uploads: i.uploads });
  await tx.commit();
  return { ok: true };
}

/* ---------- remove sample data ---------- */
const REMOVE: [string, string][] = [
  ['meterReadings', 'meter_readings'], ['statusEvents', 'status_events'], ['moves', 'moves'], ['issues', 'issues'], ['workOrders', 'work_orders'],
  ['vehicles', 'vehicles'], ['parts', 'parts'], ['mechanics', 'mechanics'], ['pmPrograms', 'pm_programs'], ['bases', 'bases'], ['settings', 'settings'],
];
export async function removeSample(env: Env, actor: Actor) {
  if (!can(actor, 'setup')) throw forbidden();
  // Records that hang off a sample unit go with it (they would show as "Unknown unit" otherwise).
  const sv = "SELECT id FROM vehicles WHERE sample = 1";
  const where: Record<string, string> = {
    meter_readings: `sample = 1 OR vehicle_id IN (${sv})`, status_events: `sample = 1 OR vehicle_id IN (${sv})`, moves: `sample = 1 OR vehicle_id IN (${sv})`,
    issues: `sample = 1 OR vehicle_id IN (${sv})`, work_orders: `sample = 1 OR vehicle_id IN (${sv})`,
  };
  const w = (t: string) => where[t] || 'sample = 1';
  // attachments of removed issues / work orders (files must be deleted from R2 after the batch commits)
  const atts = await all<any>(env.DB, `SELECT id, r2_key FROM attachments WHERE (entity_type='issue' AND entity_id IN (SELECT id FROM issues WHERE ${w('issues')})) OR (entity_type='work_order' AND entity_id IN (SELECT id FROM work_orders WHERE ${w('work_orders')}))`);
  const tx = new Tx(env.DB, actor);
  let total = 0;
  for (const [coll, table] of REMOVE) {
    const cnt = await first<any>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${w(table)}`);
    total += cnt?.n || 0;
    tx.run(`INSERT OR REPLACE INTO tombstones (coll, id, seq) SELECT '${coll}', id, ${SEQ} FROM ${table} WHERE ${w(table)}`);
  }
  tx.run(`DELETE FROM attachments WHERE id IN (${atts.map(() => '?').join(',') || "''"})`, ...atts.map((a) => a.id));
  for (const [, table] of REMOVE) tx.run(`DELETE FROM ${table} WHERE ${w(table)}`);
  tx.audit('sample.remove', 'sample', null, null, { rows: total });
  await tx.commit();
  for (const a of atts) { try { await env.FILES.delete(a.r2_key); } catch { /* ignore */ } }
  return { ok: true, removed: total };
}

