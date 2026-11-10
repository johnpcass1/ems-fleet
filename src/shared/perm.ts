import type { Role } from './constants';

/**
 * Permission matrix. Same keys as the prototype's PERM table.
 * Fleet manager rights are shared with the system administrator. The dispatcher has no entries:
 * a dispatcher only sees the Dispatch screen and the read-only unit details.
 */
const FM: Role[] = ['fleet_manager', 'system_admin'];
const FM_SUP: Role[] = [...FM, 'base_supervisor'];
export const PERM: Record<string, Role[]> = {
  move: FM_SUP,
  delAttach: FM,
  editVehicle: FM,
  status: FM_SUP,
  reading: [...FM_SUP, 'mechanic', 'crew'],
  confirmReading: FM_SUP,
  report: [...FM_SUP, 'mechanic', 'crew'],
  issues: FM_SUP,
  createWO: FM_SUP,
  workWO: [...FM_SUP, 'mechanic'],
  approve: FM,
  closeWO: FM_SUP,
  cancelWO: FM_SUP,
  parts: FM_SUP,
  mechanics: FM_SUP,
  setup: FM,
  users: FM,
  backups: ['system_admin'],
  /** Photos and PDFs. Also needs the site-wide Features switch (super user only) to be on. */
  upload: [...FM_SUP, 'mechanic', 'crew'],
  /** The Reports screen (a screen setting: the figures come from data the person can already read). */
  viewReports: ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'viewer'],
};
export const PERM_KEYS = Object.keys(PERM);
/** Keys that only the super user can grant to someone. */
export const SUPER_ONLY_KEYS = ['users', 'setup', 'backups'];
/** What a role may do with no per-person changes. */
export const hasPerm = (role: string, key: string) => (PERM[key] || []).includes(role as Role);

/** Groups and labels for the Permissions drawer. Every key in PERM appears exactly once. */
export const PERM_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: 'Units', items: [['move', 'Move units between bases'], ['status', 'Change unit status'], ['reading', 'Log engine hours'], ['confirmReading', 'Confirm flagged engine-hour readings'], ['editVehicle', 'Add and edit vehicles']] },
  { title: 'Problems', items: [['report', 'Report problems'], ['issues', 'Manage problems (create work orders, dismiss)'], ['upload', 'Upload photos and PDFs'], ['delAttach', 'Remove photos and PDFs']] },
  { title: 'Work orders', items: [['createWO', 'Create work orders'], ['workWO', 'Work on work orders'], ['approve', 'Approve costly work orders'], ['closeWO', 'Close work orders'], ['cancelWO', 'Cancel work orders']] },
  { title: 'Parts and mechanics', items: [['parts', 'Manage parts and stock'], ['mechanics', 'Manage the mechanics list']] },
  { title: 'Admin', items: [['setup', 'Change setup (bases, PM programs, settings)'], ['users', 'Manage people'], ['backups', 'Backups'], ['viewReports', 'View reports']] },
];

/**
 * Effective permission = super user: yes; else the person's own override if there is one; else the role's default.
 * `perms` (the finished map, sent to the browser) wins when present so both sides decide the same way.
 */
export function can(actor: { role: string; isSuper?: boolean; permOverrides?: Record<string, boolean>; perms?: Record<string, boolean> }, key: string): boolean {
  if (actor.perms) return actor.perms[key] === true;
  if (actor.isSuper) return true;
  const o = actor.permOverrides?.[key];
  if (typeof o === 'boolean') return o;
  return hasPerm(actor.role, key);
}
export function effectivePerms(actor: { role: string; isSuper?: boolean; permOverrides?: Record<string, boolean> }): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of PERM_KEYS) out[k] = can({ role: actor.role, isSuper: actor.isSuper, permOverrides: actor.permOverrides }, k);
  return out;
}
/** Keep only keys we know with true/false values. */
export function cleanOverrides(o: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as any)) if (PERM_KEYS.includes(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/** Roles from most to least senior. Nobody manages their own level or above. */
const RANK: Role[] = ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer'];
/** Roles whose accounts and permissions this actor may create or change: the super user all, everyone else only roles below their own. */
export function manageableRoles(actor: { role: string; isSuper?: boolean }): Role[] {
  if (actor.isSuper) return [...RANK];
  const i = RANK.indexOf(actor.role as Role);
  return i < 0 ? [] : RANK.slice(i + 1);
}
/** May this actor edit the role and permissions of `target`? Never themselves, never a super user unless they are one. */
export function canManageUser(actor: { id: string; role: string; isSuper?: boolean }, target: { id: string; role: string; isSuper?: boolean }): boolean {
  if (target.id === actor.id) return false;
  if (target.isSuper) return !!actor.isSuper;
  return manageableRoles(actor).includes(target.role as Role);
}

/** Roles that may read the full fleet data. The dispatcher gets a reduced read-only copy. */
export const FULL_READ: Role[] = ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'viewer'];

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  baseIds: string[];
  mechanicId: string | null;
  /** True when the email is in SUPERUSER_EMAILS (set in code, see docs/HANDOVER.md). */
  isSuper?: boolean;
  /** This person's own changes to what their role allows (key -> true/false). */
  permOverrides?: Record<string, boolean>;
  /** Finished effective permissions (sent to the browser). */
  perms?: Record<string, boolean>;
}

/**
 * Vehicle scoping.
 *  - Base supervisors: only vehicles at their bases (no bases = nothing).
 *  - Crew: units at their bases; if they have no bases set, all units.
 *  - Fleet manager / system admin: everything.
 *  - Mechanics log readings and report problems on any unit.
 */
export function vehicleInScope(actor: Actor, key: string, baseId: string | null | undefined): boolean {
  if (actor.isSuper || actor.role === 'system_admin' || actor.role === 'fleet_manager') return true;
  if (actor.role === 'base_supervisor') return !!baseId && actor.baseIds.includes(baseId);
  if (actor.role === 'mechanic' && (key === 'reading' || key === 'report')) return true;
  // crew, and any other role that was given a permission by hand: their bases, or every unit if they have no bases set
  return actor.baseIds.length === 0 || (!!baseId && actor.baseIds.includes(baseId));
}

/** Can this actor do `key` on a vehicle currently at `baseId`? */
export function canOnVehicle(actor: Actor, key: string, baseId: string | null | undefined): boolean {
  return can(actor, key) && vehicleInScope(actor, key, baseId);
}

/** Work order work (lines, notes, start, hold, resume, complete): mechanics only on WOs assigned to them. */
export function canWorkWO(actor: Actor, wo: { mechanicId?: string | null }, vehicleBaseId: string | null | undefined): boolean {
  if (!can(actor, 'workWO')) return false;
  if (actor.role === 'mechanic' && !actor.isSuper) return !!actor.mechanicId && wo.mechanicId === actor.mechanicId;
  return vehicleInScope(actor, 'workWO', vehicleBaseId);
}
