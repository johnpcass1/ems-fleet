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
  /** Which screens each role may open. */
};
export const hasPerm = (role: string, key: string) => (PERM[key] || []).includes(role as Role);

/** Roles that may read the full fleet data. The dispatcher gets a reduced read-only copy. */
export const FULL_READ: Role[] = ['system_admin', 'fleet_manager', 'base_supervisor', 'mechanic', 'crew', 'viewer'];

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  baseIds: string[];
  mechanicId: string | null;
}

/**
 * Vehicle scoping.
 *  - Base supervisors: only vehicles at their bases (no bases = nothing).
 *  - Crew: units at their bases; if they have no bases set, all units.
 *  - Fleet manager / system admin: everything.
 *  - Mechanics log readings and report problems on any unit.
 */
export function vehicleInScope(actor: Actor, key: string, baseId: string | null | undefined): boolean {
  if (actor.role === 'system_admin' || actor.role === 'fleet_manager') return true;
  if (actor.role === 'base_supervisor') return !!baseId && actor.baseIds.includes(baseId);
  if (actor.role === 'crew') return actor.baseIds.length === 0 || (!!baseId && actor.baseIds.includes(baseId));
  if (actor.role === 'mechanic') return key === 'reading' || key === 'report';
  return false;
}

/** Can this actor do `key` on a vehicle currently at `baseId`? */
export function canOnVehicle(actor: Actor, key: string, baseId: string | null | undefined): boolean {
  return hasPerm(actor.role, key) && vehicleInScope(actor, key, baseId);
}

/** Work order work (lines, notes, start, hold, resume, complete): mechanics only on WOs assigned to them. */
export function canWorkWO(actor: Actor, wo: { mechanicId?: string | null }, vehicleBaseId: string | null | undefined): boolean {
  if (!hasPerm(actor.role, 'workWO')) return false;
  if (actor.role === 'mechanic') return !!actor.mechanicId && wo.mechanicId === actor.mechanicId;
  return vehicleInScope(actor, 'workWO', vehicleBaseId);
}
