export interface StatusInfo { label: string; kind: string; avail?: boolean }
export const STATUS: Record<string, StatusInfo> = {
  in_service: { label: 'In service', kind: 'ok', avail: true },
  limited: { label: 'Limited', kind: 'warn', avail: true },
  reserve: { label: 'Reserve', kind: 'res', avail: true },
  oos_pm: { label: 'Out: scheduled service', kind: 'bad' },
  oos_repair: { label: 'Out: repair', kind: 'bad' },
  oos_parts: { label: 'Out: waiting for parts', kind: 'bad' },
  oos_accident: { label: 'Out: accident', kind: 'bad' },
  decommissioned: { label: 'Decommissioned', kind: 'off' },
};
export const isAvail = (s: string) => !!STATUS[s]?.avail;
export const isOos = (s: string) => String(s).startsWith('oos_');

export const WO_STATUS: Record<string, string> = { open: 'Open', approved: 'Approved', scheduled: 'Scheduled', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled' };
export const WO_KIND: Record<string, string> = { open: 'res', approved: 'acc', scheduled: 'acc', in_progress: 'warn', on_hold: 'bad', completed: 'ok', closed: 'off', cancelled: 'off' };
export const WO_TYPES: Record<string, string> = { preventive: 'Preventive', corrective: 'Corrective', accident: 'Accident', warranty: 'Warranty', inspection: 'Inspection' };
export const PRIO: Record<string, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export const SEV: Record<string, string> = { critical: 'Critical', major: 'Major', minor: 'Minor' };
export const ISSUE_ST: Record<string, string> = { open: 'Open', in_work_order: 'In a work order', resolved: 'Resolved', dismissed: 'Dismissed' };
export const HOLD: Record<string, string> = { parts: 'Waiting for parts', approval: 'Waiting for approval', mechanic: 'Waiting for a mechanic' };
export const WO_ACTIVE = ['open', 'approved', 'scheduled', 'in_progress', 'on_hold'];
export const REPAIR_CODES = ['Engine', 'Transmission', 'Brakes', 'Tires', 'Electrical', 'Lights & siren', 'Suspension', 'HVAC', 'Body', 'Patient compartment', 'Other'];
export const LINE_KINDS = ['labor', 'part', 'outside'] as const;

export const ROLE_LIST = ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer'] as const;
export type Role = (typeof ROLE_LIST)[number];
export const ROLES: Record<Role, string> = {
  system_admin: 'System administrator',
  fleet_manager: 'Fleet manager',
  base_supervisor: 'Base supervisor',
  mechanic: 'Mechanic',
  crew: 'Crew',
  dispatcher: 'Dispatcher',
  viewer: 'Viewer',
};

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const FM_OR_ADMIN: Role[] = ['system_admin', 'fleet_manager'];
