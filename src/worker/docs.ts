/**
 * Row <-> document mapping. The browser works with the same document shapes as the approved prototype
 * (camelCase, nested `pm`, `lines`, `tasks`, `attachments`), while the database is relational.
 */
import { all, sampleCol } from './db';

const j = (s: any, d: any) => {
  try { return s == null ? d : JSON.parse(s); } catch { return d; }
};

export interface CollSpec {
  coll: string;
  table: string;
  /** SELECT ... FROM <table> alias (no WHERE). */
  select: string;
  map: (r: any) => any;
  /** Synced collections have a `seq` column. */
}

const ATT_SUB = (type: string) => `(SELECT json_group_array(json_object('assetId', a.id, 'name', a.name, 'type', a.content_type, 'size', a.size, 'at', a.created_at, 'by', a.created_by))
  FROM (SELECT * FROM attachments WHERE agency_id = X.agency_id AND entity_type = '${type}' AND entity_id = X.id ORDER BY created_at, id) a)`;

export const SPECS: Record<string, CollSpec> = {
  bases: {
    coll: 'bases', table: 'bases', select: 'SELECT * FROM bases X',
    map: (r) => ({ id: r.id, name: r.name, region: r.region, minUnits: r.min_units, ...sampleCol(r) }),
  },
  pmPrograms: {
    coll: 'pmPrograms', table: 'pm_programs',
    select: `SELECT X.*, (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'group', t.grp, 'intervalHours', t.interval_hours, 'intervalDays', t.interval_days, 'intervalKm', t.interval_km))
       FROM (SELECT * FROM pm_tasks WHERE agency_id = X.agency_id AND program_id = X.id ORDER BY sort, id) t) AS tasks FROM pm_programs X`,
    map: (r) => ({ id: r.id, name: r.name, appliesTo: r.applies_to, tasks: j(r.tasks, []), ...sampleCol(r) }),
  },
  vehicles: {
    coll: 'vehicles', table: 'vehicles',
    select: `SELECT X.*, (SELECT json_group_array(json_object('t', p.task_id, 'h', p.last_hours, 'k', p.last_km, 'd', p.last_date)) FROM vehicle_pm p WHERE p.agency_id = X.agency_id AND p.vehicle_id = X.id) AS pm FROM vehicles X`,
    map: (r) => {
      const pm: Record<string, any> = {};
      for (const p of j(r.pm, [])) pm[p.t] = { lastHours: p.h, lastKm: p.k, lastDate: p.d };
      const d: any = {
        id: r.id, unit: r.unit, plate: r.plate, vin: r.vin, make: r.make, model: r.model, year: r.year, type: r.type, baseId: r.base_id,
        inServiceDate: r.in_service_date, status: r.status, statusReason: r.status_reason, statusSince: r.status_since, expectedReturn: r.expected_return,
        engineHours: r.engine_hours, odometerKm: r.odometer_km, pmProgramId: r.pm_program_id, pm, warrantyEnd: r.warranty_end, notes: r.notes, ...sampleCol(r),
      };
      if (r.home_base_id) d.homeBaseId = r.home_base_id;
      if (r.temp_until) { d.tempUntil = r.temp_until; d.tempFromBaseId = r.temp_from_base_id; }
      return d;
    },
  },
  meterReadings: {
    coll: 'meterReadings', table: 'meter_readings', select: 'SELECT * FROM meter_readings X',
    map: (r) => ({ id: r.id, vehicleId: r.vehicle_id, at: r.at, hours: r.hours, km: r.km, source: r.source, by: r.by_user, flagged: !!r.flagged, ...sampleCol(r) }),
  },
  statusEvents: {
    coll: 'statusEvents', table: 'status_events', select: 'SELECT * FROM status_events X',
    map: (r) => ({ id: r.id, vehicleId: r.vehicle_id, from: r.from_status, to: r.to_status, reason: r.reason, at: r.at, by: r.by_user, woId: r.wo_id, ...sampleCol(r) }),
  },
  moves: {
    coll: 'moves', table: 'moves', select: 'SELECT * FROM moves X',
    map: (r) => ({ id: r.id, vehicleId: r.vehicle_id, fromBaseId: r.from_base_id, toBaseId: r.to_base_id, at: r.at, by: r.by_user, reason: r.reason, tempUntil: r.temp_until, ...sampleCol(r) }),
  },
  issues: {
    coll: 'issues', table: 'issues',
    select: `SELECT X.*, ${ATT_SUB('issue')} AS atts FROM issues X`,
    map: (r) => {
      const d: any = { id: r.id, vehicleId: r.vehicle_id, title: r.title, description: r.description, severity: r.severity, status: r.status, reportedAt: r.reported_at, by: r.by_user, woId: r.wo_id, hours: r.hours, ...sampleCol(r) };
      if (r.source) { d.source = r.source; d.busCheckId = r.bus_check_id; d.sourceRef = r.source_ref; }
      const a = j(r.atts, []);
      if (a.length) d.attachments = a;
      return d;
    },
  },
  workOrders: {
    coll: 'workOrders', table: 'work_orders',
    select: `SELECT X.*,
      (SELECT json_group_array(issue_id) FROM wo_issue_links WHERE agency_id = X.agency_id AND wo_id = X.id) AS issue_ids,
      (SELECT json_group_array(task_id) FROM wo_pm_tasks WHERE agency_id = X.agency_id AND wo_id = X.id) AS pm_task_ids,
      (SELECT json_group_array(json_object('id', l.id, 'kind', l.kind, 'description', l.description, 'repairCode', l.repair_code, 'qty', l.qty, 'unitCost', l.unit_cost, 'partId', l.part_id, 'warranty', l.warranty))
         FROM (SELECT * FROM work_order_lines WHERE agency_id = X.agency_id AND wo_id = X.id ORDER BY sort, id) l) AS lines,
      ${ATT_SUB('work_order')} AS atts
      FROM work_orders X`,
    map: (r) => {
      const d: any = {
        id: r.id, number: r.number, vehicleId: r.vehicle_id, type: r.type, priority: r.priority, status: r.status, holdReason: r.hold_reason, mechanicId: r.mechanic_id,
        issueIds: j(r.issue_ids, []), pmTaskIds: j(r.pm_task_ids, []), openedAt: r.opened_at, scheduledFor: r.scheduled_for, startedAt: r.started_at, completedAt: r.completed_at, closedAt: r.closed_at,
        hoursAtOpen: r.hours_at_open, hoursAtComplete: r.hours_at_complete, kmAtComplete: r.km_at_complete,
        lines: j(r.lines, []).map((l: any) => ({ ...l, warranty: !!l.warranty })),
        notes: r.notes, approvalNeeded: !!r.approval_needed, approvedBy: r.approved_by, by: r.by_user, overdueAtOpen: r.overdue_at_open, holdLog: j(r.hold_log, []), ...sampleCol(r),
      };
      const a = j(r.atts, []);
      if (a.length) d.attachments = a;
      return d;
    },
  },
  parts: {
    coll: 'parts', table: 'parts', select: 'SELECT * FROM parts X',
    map: (r) => ({ id: r.id, number: r.number, description: r.description, fits: r.fits, onHand: r.on_hand, reorderPoint: r.reorder_point, unitCost: r.unit_cost, ...sampleCol(r) }),
  },
  mechanics: {
    coll: 'mechanics', table: 'mechanics', select: 'SELECT * FROM mechanics X',
    map: (r) => ({ id: r.id, name: r.name, shop: r.shop, phone: r.phone, region: r.region, ...sampleCol(r) }),
  },
  settings: {
    coll: 'settings', table: 'settings', select: 'SELECT * FROM settings X',
    map: (r) => ({ ...j(r.data, {}), id: r.id, ...sampleCol(r) }),
  },
  // Names only: lets the browser show who did what. No emails, roles or hashes. `active` lets the bus check crew pickers offer current staff only.
  people: {
    coll: 'people', table: 'users', select: 'SELECT id, name, active, seq FROM users X',
    map: (r) => ({ id: r.id, name: r.name, active: !!r.active }),
  },
  // The bus check requirement lists (small). Submitted checks are NOT here: they are read through the paged /api/bus-checks calls.
  busCheckLists: {
    coll: 'busCheckLists', table: 'bus_check_lists', select: 'SELECT * FROM bus_check_lists X',
    map: (r) => ({ id: r.id, name: r.name, unitTypes: j(r.unit_types, []), active: !!r.active, sections: j(r.sections, []), createdAt: r.created_at, updatedAt: r.updated_at }),
  },
};

export const FULL_COLLS = ['bases', 'pmPrograms', 'vehicles', 'meterReadings', 'statusEvents', 'moves', 'issues', 'workOrders', 'parts', 'mechanics', 'settings', 'people', 'busCheckLists'];
/** The dispatcher sees status, base, PM state and open work, but no costs, notes, parts or attachments. */
export const DISPATCH_COLLS = ['bases', 'pmPrograms', 'vehicles', 'meterReadings', 'statusEvents', 'moves', 'issues', 'workOrders', 'mechanics', 'settings', 'people'];

/**
 * Documents of one collection, ALWAYS limited to one agency (the first condition of every query here is X.agency_id = ?).
 * `where` (optional) is an extra condition on top; every SPECS select aliases its table as X.
 */
export async function loadDocs(db: D1Database, agency: string, coll: string, where = '', ...params: unknown[]) {
  const s = SPECS[coll];
  const rows = await all(db, `${s.select} WHERE X.agency_id = ?${where ? ' AND (' + where + ')' : ''}`, agency, ...params);
  return rows.map(s.map);
}
export async function loadDoc(db: D1Database, agency: string, coll: string, id: string) {
  return (await loadDocs(db, agency, coll, 'X.id = ?', id))[0] ?? null;
}

/** Strip fields the dispatcher must not see. */
export function redactForDispatch(coll: string, d: any) {
  if (coll === 'workOrders') return { ...d, lines: [], notes: '', attachments: undefined, approvedBy: null };
  if (coll === 'issues') return { ...d, description: '', attachments: undefined };
  if (coll === 'settings') return { id: d.id, dueSoonHours: d.dueSoonHours, dueSoonDays: d.dueSoonDays, dueSoonKm: d.dueSoonKm, comebackDays: d.comebackDays, features: { uploads: d.features?.uploads === true } };
  return d;
}
