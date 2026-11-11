import { describe, it, expect } from 'vitest';
import { isSuperuserEmail } from '../../src/worker/env';
import { EDITABLE_KEYS, PERM, PERM_GROUPS, PERM_KEYS, can, canManageUser, effectivePerms, manageableRoles } from '../../src/shared/perm';

describe('isSuperuserEmail', () => {
  it('compares trimmed and case-insensitively, supports a list, and is false when unset or empty', () => {
    const env = { SUPERUSER_EMAILS: ' John@Example.com , second@example.org ' };
    expect(isSuperuserEmail(env, 'john@example.com')).toBe(true);
    expect(isSuperuserEmail(env, '  JOHN@EXAMPLE.COM ')).toBe(true);
    expect(isSuperuserEmail(env, 'second@example.org')).toBe(true);
    expect(isSuperuserEmail(env, 'third@example.org')).toBe(false);
    expect(isSuperuserEmail(env, 'example.com')).toBe(false);
    expect(isSuperuserEmail({}, 'john@example.com')).toBe(false);
    expect(isSuperuserEmail({ SUPERUSER_EMAILS: '' }, '')).toBe(false);
    expect(isSuperuserEmail({ SUPERUSER_EMAILS: ' , ' }, '')).toBe(false);
  });
});
describe('permission model', () => {
  it('every key is labelled exactly once', () => {
    const keys = PERM_GROUPS.flatMap((g) => g.items.map((i) => i[0]));
    expect([...keys].sort()).toEqual([...EDITABLE_KEYS].sort());
    expect(keys).not.toContain('backups');
  });
  it('role defaults are unchanged and overrides win; the super user has everything', () => {
    expect(can({ role: 'crew' }, 'report')).toBe(true);
    expect(can({ role: 'crew' }, 'move')).toBe(false);
    expect(can({ role: 'crew', permOverrides: { report: false, move: true } }, 'report')).toBe(false);
    expect(can({ role: 'crew', permOverrides: { move: true } }, 'move')).toBe(true);
    expect(can({ role: 'viewer', isSuper: true }, 'backups')).toBe(true);
    expect(can({ role: 'fleet_manager' }, 'backups')).toBe(false);
    expect(PERM.viewReports).not.toContain('dispatcher');
    expect(effectivePerms({ role: 'viewer' }).upload).toBe(false);
  });
  it('who may manage whom', () => {
    expect(manageableRoles({ role: 'fleet_manager' })).toEqual(['base_supervisor', 'mechanic', 'crew', 'dispatcher', 'viewer']);
    expect(manageableRoles({ role: 'system_admin' })).not.toContain('system_admin');
    expect(manageableRoles({ role: 'system_admin' })).toContain('fleet_manager');
    expect(manageableRoles({ role: 'crew', isSuper: true })).toContain('system_admin');
    expect(manageableRoles({ role: 'crew' })).toEqual(['dispatcher', 'viewer']);
    const me = { id: 'a', role: 'fleet_manager' };
    expect(canManageUser(me, { id: 'a', role: 'crew' })).toBe(false);
    expect(canManageUser(me, { id: 'b', role: 'fleet_manager' })).toBe(false);
    expect(canManageUser(me, { id: 'b', role: 'crew', isSuper: true })).toBe(false);
    expect(canManageUser({ id: 's', role: 'viewer', isSuper: true }, { id: 'b', role: 'system_admin' })).toBe(true);
    expect(canManageUser({ id: 's', role: 'viewer', isSuper: true }, { id: 's', role: 'viewer', isSuper: true })).toBe(false);
  });
});
