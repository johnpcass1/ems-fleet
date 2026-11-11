/**
 * Turns prototype-style documents (one object per document, grouped by collection) into SQL for the D1 schema.
 * Used by `npm run seed:demo`, `npm run import:prototype` and the tests. Pure: no I/O.
 */
export interface Stmt { sql: string; params: unknown[] }
export type DocMap = Record<string, any[]>;

const SEQ = '(SELECT v FROM counter WHERE id = 1)';
const n = (v: any) => (v === undefined ? null : v);
const bool = (v: any) => (v ? 1 : 0);

export interface ConvertOptions {
  now?: string;
  /** User ids that exist. `by` fields pointing at anyone else become NULL (the prototype's user ids do not exist here). */
  userIds?: Set<string>;
  /** Force every row to be flagged sample = 1 (used by seed:demo). */
  sample?: boolean;
  /** The agency the rows belong to (default 'GEMA'). The agency's settings row has this as its id. */
  agency?: string;
}

/** Order matters: parents before children. */
export const IMPORT_ORDER = ['bases', 'settings', 'pmPrograms', 'mechanics', 'parts', 'vehicles', 'meterReadings', 'statusEvents', 'moves', 'issues', 'workOrders'];

export function docsToStatements(data: DocMap, opts: ConvertOptions = {}): { stmts: Stmt[]; counts: Record<string, number>; skipped: string[] } {
  const now = opts.now ?? new Date().toISOString();
  const by = (v: any) => (v && opts.userIds?.has(v) ? v : null);
  const smp = (d: any) => (opts.sample || d.sample ? 1 : 0);
  const stmts: Stmt[] = [];
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  const agency = (opts.agency ?? 'GEMA').toUpperCase();
  /** Every row is written with its agency_id (appended to the column list and the values). */
  const add = (sql: string, ...params: unknown[]) => {
    const m = /^(\s*INSERT INTO \w+ \([^)]*)\)(\s*VALUES \()([\s\S]*)\)\s*$/.exec(sql);
    if (!m) throw new Error('docsToStatements: unexpected statement ' + sql);
    stmts.push({ sql: `${m[1]}, agency_id)${m[2]}${m[3]}, ?)`, params: [...params.map(n), agency] });
  };
  const bump = (c: string) => (counts[c] = (counts[c] || 0) + 1);

  for (const coll of Object.keys(data)) if (!IMPORT_ORDER.includes(coll)) skipped.push(`collection "${coll}" is not imported`);

  for (const d of data.bases || []) {
    bump('bases');
    add(`INSERT INTO bases (id, name, region, min_units, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,${SEQ},?,?)`, d.id, d.name, d.region ?? '', d.minUnits ?? 0, smp(d), now, now);
  }
  for (const d of data.settings || []) {
    bump('settings');
    const { id: _ignored, sample, ...rest } = d;
    add(`INSERT INTO settings (id, data, sample, seq, created_at, updated_at) VALUES (?,?,?,${SEQ},?,?)`, agency, JSON.stringify(rest), smp(d), now, now); // one row per agency; its id is the agency code
  }
  for (const d of data.pmPrograms || []) {
    bump('pmPrograms');
    add(`INSERT INTO pm_programs (id, name, applies_to, sample, seq, created_at, updated_at) VALUES (?,?,?,?,${SEQ},?,?)`, d.id, d.name, d.appliesTo ?? '', smp(d), now, now);
    (d.tasks || []).forEach((t: any, i: number) =>
      add('INSERT INTO pm_tasks (id, program_id, name, grp, interval_hours, interval_days, interval_km, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', t.id, d.id, t.name, t.group ?? 'General', t.intervalHours, t.intervalDays, t.intervalKm, i, now, now));
  }
  for (const d of data.mechanics || []) {
    bump('mechanics');
    add(`INSERT INTO mechanics (id, name, shop, phone, region, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.name, d.shop ?? '', d.phone ?? '', d.region ?? '', smp(d), now, now);
  }
  for (const d of data.parts || []) {
    bump('parts');
    add(`INSERT INTO parts (id, number, description, fits, on_hand, reorder_point, unit_cost, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.number, d.description, d.fits ?? '', d.onHand ?? 0, d.reorderPoint ?? 0, d.unitCost ?? 0, smp(d), now, now);
  }
  for (const d of data.vehicles || []) {
    bump('vehicles');
    add(
      `INSERT INTO vehicles (id, unit, plate, vin, make, model, year, type, base_id, home_base_id, temp_until, temp_from_base_id, in_service_date, status, status_reason, status_since, expected_return, engine_hours, odometer_km, pm_program_id, warranty_end, notes, sample, seq, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${SEQ},?,?)`,
      d.id, d.unit, d.plate ?? '', d.vin ?? '', d.make ?? '', d.model ?? '', d.year, d.type ?? '', d.baseId, d.homeBaseId, d.tempUntil, d.tempFromBaseId, d.inServiceDate, d.status ?? 'in_service',
      d.statusReason ?? '', d.statusSince, d.expectedReturn, d.engineHours ?? 0, d.odometerKm ?? 0, d.pmProgramId, d.warrantyEnd, d.notes ?? '', smp(d), now, now,
    );
    for (const [taskId, p] of Object.entries<any>(d.pm || {}))
      add('INSERT INTO vehicle_pm (vehicle_id, task_id, last_hours, last_km, last_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', d.id, taskId, p.lastHours, p.lastKm, p.lastDate, now, now);
  }
  for (const d of data.meterReadings || []) {
    bump('meterReadings');
    add(`INSERT INTO meter_readings (id, vehicle_id, at, hours, km, source, by_user, flagged, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.vehicleId, d.at, d.hours, d.km, d.source ?? 'manual', by(d.by), bool(d.flagged), smp(d), now, now);
  }
  for (const d of data.statusEvents || []) {
    bump('statusEvents');
    add(`INSERT INTO status_events (id, vehicle_id, from_status, to_status, reason, at, by_user, wo_id, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.vehicleId, d.from, d.to, d.reason ?? '', d.at, by(d.by), d.woId, smp(d), now, now);
  }
  for (const d of data.moves || []) {
    bump('moves');
    add(`INSERT INTO moves (id, vehicle_id, from_base_id, to_base_id, at, by_user, reason, temp_until, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.vehicleId, d.fromBaseId, d.toBaseId, d.at, by(d.by), d.reason ?? '', d.tempUntil, smp(d), now, now);
  }
  for (const d of data.issues || []) {
    bump('issues');
    add(`INSERT INTO issues (id, vehicle_id, title, description, severity, status, reported_at, by_user, wo_id, hours, sample, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,${SEQ},?,?)`, d.id, d.vehicleId, d.title, d.description ?? '', d.severity, d.status ?? 'open', d.reportedAt, by(d.by), d.woId, d.hours, smp(d), now, now);
    if ((d.attachments || []).length) skipped.push(`issue ${d.id}: ${d.attachments.length} attachment(s) not imported (files cannot be copied automatically)`);
  }
  for (const d of data.workOrders || []) {
    bump('workOrders');
    add(
      `INSERT INTO work_orders (id, number, vehicle_id, type, priority, status, hold_reason, mechanic_id, opened_at, scheduled_for, started_at, completed_at, closed_at, hours_at_open, hours_at_complete, km_at_complete, notes, approval_needed, approved_by, by_user, overdue_at_open, hold_log, sample, seq, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${SEQ},?,?)`,
      d.id, d.number, d.vehicleId, d.type, d.priority ?? 'normal', d.status ?? 'open', d.holdReason, d.mechanicId, d.openedAt, d.scheduledFor, d.startedAt, d.completedAt, d.closedAt, d.hoursAtOpen, d.hoursAtComplete,
      d.kmAtComplete, d.notes ?? '', bool(d.approvalNeeded), by(d.approvedBy), by(d.by), d.overdueAtOpen ?? 0, JSON.stringify(d.holdLog || []), smp(d), now, now,
    );
    (d.lines || []).forEach((l: any, i: number) =>
      add('INSERT INTO work_order_lines (wo_id, id, kind, description, repair_code, qty, unit_cost, part_id, warranty, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', d.id, l.id || 'l' + (i + 1), l.kind, l.description, l.repairCode ?? 'Other', l.qty ?? 0, l.unitCost ?? 0, l.partId, bool(l.warranty), i, now, now));
    for (const iid of d.issueIds || []) add('INSERT INTO wo_issue_links (wo_id, issue_id, created_at) VALUES (?,?,?)', d.id, iid, now);
    for (const t of d.pmTaskIds || []) add('INSERT INTO wo_pm_tasks (wo_id, task_id, created_at) VALUES (?,?,?)', d.id, t, now);
    if ((d.attachments || []).length) skipped.push(`work order ${d.id}: ${d.attachments.length} attachment(s) not imported (files cannot be copied automatically)`);
  }
  return { stmts, counts, skipped };
}

/** Render a statement as plain SQL text (for `wrangler d1 execute --file`). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
export function renderSql(s: Stmt): string {
  let i = 0;
  return s.sql.replace(/\?/g, () => sqlLiteral(s.params[i++])) + ';';
}
