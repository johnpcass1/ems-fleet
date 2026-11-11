import { ROLE_LIST, type Role } from './constants';

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
  /** Super user only: no role has it by default and it can never be granted to anyone (see NEVER_GRANTABLE). */
  backups: [],
  /** Photos and PDFs. Also needs the site-wide Features switch (super user only) to be on. */
  upload: [...FM_SUP, 'mechanic', 'crew'],
  /** The Reports screen (a screen setting: the figures come from data the person can already read). */
  viewReports: ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'viewer'],
  /** Bus checks (start-of-shift inspection). Doing one is limited to units the person may act on; reports are limited to a supervisor's own bases. */
  busCheck: [...FM_SUP, 'crew'],
  busCheckReports: FM_SUP,
  /** Change the bus check requirement lists (what is checked, and for which unit types). */
  busCheckEdit: FM,
};
export const PERM_KEYS = Object.keys(PERM);
/** Keys that only the super user can grant, to a role or to a person. */
export const SUPER_ONLY_KEYS = ['users', 'setup'];
/** Keys only the super user ever has. They cannot be granted to a role or a person by anyone, and are not in either permission editor. */
export const NEVER_GRANTABLE = ['backups'];
/** Keys that appear in the permission editors (everything except NEVER_GRANTABLE). */
export const EDITABLE_KEYS = PERM_KEYS.filter((k) => !NEVER_GRANTABLE.includes(k));
/** What a role may do with no per-person changes. */
export const hasPerm = (role: string, key: string) => (PERM[key] || []).includes(role as Role);

/** Groups and labels for the Permissions drawer and the Roles & permissions screen. Every editable key (all but NEVER_GRANTABLE) appears exactly once. */
export const PERM_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: 'Units', items: [['move', 'Move units between bases'], ['status', 'Change unit status'], ['reading', 'Log engine hours'], ['confirmReading', 'Confirm flagged engine-hour readings'], ['editVehicle', 'Add and edit vehicles']] },
  { title: 'Problems', items: [['report', 'Report problems'], ['issues', 'Manage problems (create work orders, dismiss)'], ['upload', 'Upload photos and PDFs'], ['delAttach', 'Remove photos and PDFs']] },
  { title: 'Work orders', items: [['createWO', 'Create work orders'], ['workWO', 'Work on work orders'], ['approve', 'Approve costly work orders'], ['closeWO', 'Close work orders'], ['cancelWO', 'Cancel work orders']] },
  { title: 'Parts and mechanics', items: [['parts', 'Manage parts and stock'], ['mechanics', 'Manage the mechanics list']] },
  { title: 'Bus checks', items: [['busCheck', 'Do bus checks'], ['busCheckReports', 'View bus check reports'], ['busCheckEdit', 'Edit bus check requirements']] },
  { title: 'Admin', items: [['setup', 'Change setup (bases, PM programs, settings)'], ['users', 'Manage people'], ['viewReports', 'View reports']] },
];

/** Role-level changes from the built-in defaults: role -> key -> true/false. Stored in the settings record under `rolePerms`. */
export type RolePerms = Record<string, Record<string, boolean>>;

type PermActor = { role: string; isSuper?: boolean; permOverrides?: Record<string, boolean>; roleOverrides?: Record<string, boolean>; perms?: Record<string, boolean> };
/** What a role can do: its change from the built-in default if there is one, else the built-in default. Never true for NEVER_GRANTABLE. */
export function roleHas(role: string, key: string, roleOverrides?: Record<string, boolean>): boolean {
  if (NEVER_GRANTABLE.includes(key)) return false;
  const o = roleOverrides?.[key];
  return typeof o === 'boolean' ? o : hasPerm(role, key);
}
/**
 * Effective permission = super user: yes; else the person's own override; else the role's change (rolePerms, passed as `roleOverrides`);
 * else the built-in role default. NEVER_GRANTABLE keys (backups) are the super user's alone.
 * `perms` (the finished map, sent to the browser) wins when present so both sides decide the same way.
 */
export function can(actor: PermActor, key: string): boolean {
  if (actor.perms) return actor.perms[key] === true;
  if (NEVER_GRANTABLE.includes(key)) return !!actor.isSuper;
  if (actor.isSuper) return true;
  const o = actor.permOverrides?.[key];
  if (typeof o === 'boolean') return o;
  return roleHas(actor.role, key, actor.roleOverrides);
}
export function effectivePerms(actor: Omit<PermActor, 'perms'>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of PERM_KEYS) out[k] = can({ role: actor.role, isSuper: actor.isSuper, permOverrides: actor.permOverrides, roleOverrides: actor.roleOverrides }, k);
  return out;
}
/** Keep only keys we know with true/false values. Never keeps NEVER_GRANTABLE keys, so a tampered record cannot grant them. */
export function cleanOverrides(o: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as any)) if (EDITABLE_KEYS.includes(k) && typeof v === 'boolean') out[k] = v;
  return out;
}
/** Clean the stored `rolePerms`: known roles and keys only, empty roles dropped. */
export function cleanRolePerms(o: unknown): RolePerms {
  const out: RolePerms = {};
  if (o && typeof o === 'object') for (const r of ROLE_LIST) { const c = cleanOverrides((o as any)[r]); if (Object.keys(c).length) out[r] = c; }
  return out;
}
/** Where a person's current value for `key` comes from: their own change, a change to their role, or the built-in default. */
export function permSource(role: string, key: string, permOverrides?: Record<string, boolean>, roleOverrides?: Record<string, boolean>): 'personal' | 'role' | 'default' {
  if (typeof permOverrides?.[key] === 'boolean') return 'personal';
  if (typeof roleOverrides?.[key] === 'boolean' && roleOverrides[key] !== hasPerm(role, key)) return 'role';
  return 'default';
}

/** Roles from most to least senior. Nobody manages their own level or above. */
const RANK: Role[] = ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer'];
/** Roles whose accounts and permissions this actor may create or change: the super user all, everyone else only roles below their own. */
export function manageableRoles(actor: { role: string; isSuper?: boolean }): Role[] {
  if (actor.isSuper) return [...RANK];
  const i = RANK.indexOf(actor.role as Role);
  return i < 0 ? [] : RANK.slice(i + 1);
}
/** Roles whose default permissions this actor may edit on the Roles & permissions screen: the super user all; a system administrator fleet managers and below; nobody else. */
export function editableRoles(actor: { role: string; isSuper?: boolean }): Role[] {
  if (actor.isSuper) return [...RANK];
  return actor.role === 'system_admin' ? manageableRoles(actor) : [];
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
  /**
   * The agency whose data this request works in. Every query on agency data filters by it. It is the person's own agency, except while
   * the super user is viewing another agency (then it is that agency). Set only by the server from the session, never from the browser.
   */
  agencyId: string;
  /** The agency the account belongs to (users.agency_id). */
  homeAgencyId: string;
  /** True when the email is in SUPERUSER_EMAILS and the account belongs to the home agency (SUPERUSER_AGENCY). See docs/HANDOVER.md. */
  isSuper?: boolean;
  /** This person's own changes to what their role allows (key -> true/false). */
  permOverrides?: Record<string, boolean>;
  /** The changes made to this person's role as a whole (settings `rolePerms[role]`). */
  roleOverrides?: Record<string, boolean>;
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

/**
 * The bases whose units this actor's `key` rights reach, decided exactly as vehicleInScope decides one unit:
 * null = every unit; an array = only units at those bases (an empty array = no unit at all). Used where a list is read from the database
 * (bus check reports), so the query can filter instead of checking rows one by one.
 */
export function baseScope(actor: Actor, key: string): string[] | null {
  if (actor.isSuper || actor.role === 'system_admin' || actor.role === 'fleet_manager') return null;
  if (actor.role === 'base_supervisor') return [...actor.baseIds];
  if (actor.role === 'mechanic' && (key === 'reading' || key === 'report')) return null;
  return actor.baseIds.length === 0 ? null : [...actor.baseIds];
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
