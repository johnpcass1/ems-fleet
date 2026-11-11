/** Everything that changes data. The server decides; these functions ask and then refresh the local copy. */
import { api, syncNow } from './api';
import { D } from './state';
import { uerr } from './util';

const after = async <T>(p: Promise<T>) => { const r = await p; await syncNow(); return r; };

export const setVehicleStatus = (v: any, to: string, reason: string, expectedReturn: string | null) =>
  after(api('POST', `/vehicles/${v.id}/status`, { to, reason: reason || '', expectedReturn: expectedReturn || null }));
export const recordReading = (v: any, hours: number, km: number | null, accept: boolean) =>
  after(api<{ flagged: boolean; warnings: string[] }>('POST', `/vehicles/${v.id}/readings`, { hours, km, accept }));
export const acceptReading = (r: any) => after(api('POST', `/readings/${r.id}/accept`));
export async function submitIssue(f: any): Promise<string> {
  if (!D.vehicles[f.vehicleId]) throw uerr('Pick a unit first.');
  const r = await after(api<{ id: string }>('POST', '/issues', { vehicleId: f.vehicleId, title: f.title, description: f.description, severity: f.severity, hours: f.hours ?? null }));
  return r.id;
}
export const dismissIssue = (i: any) => after(api('POST', `/issues/${i.id}/dismiss`));
export async function createWorkOrder(f: any) {
  if (!D.vehicles[f.vehicleId]) throw uerr('Pick a unit first.');
  return after(api<{ id: string; number: string }>('POST', '/work-orders', f));
}
export const addLine = (woId: string, line: any) => after(api('POST', `/work-orders/${woId}/lines`, line));
export const removeLine = (woId: string, lineId: string) => after(api('DELETE', `/work-orders/${woId}/lines/${lineId}`));
export const patchWo = (woId: string, patch: any) => after(api('PATCH', `/work-orders/${woId}`, patch));
export const woAction = (id: string, action: string, p: any = {}) => after(api('POST', `/work-orders/${id}/transition`, { action, ...p }));
export const moveUnits = async (ids: string[], toBaseId: string, reason: string, tempUntil: string | null) =>
  (await after(api<{ moved: number }>('POST', '/moves', { vehicleIds: ids, toBaseId, reason, tempUntil: tempUntil || null }))).moved;
export const removeSample = () => after(api('POST', '/admin/sample/remove'));

export const saveVehicle = (id: string | null, o: any) => after(id ? api('PATCH', `/vehicles/${id}`, o) : api<{ id: string }>('POST', '/vehicles', o));
export const savePart = (id: string | null, o: any) => after(id ? api('PUT', `/parts/${id}`, o) : api('POST', '/parts', o));
export const receivePart = (id: string, qty: number, cost: number) => after(api<{ unitCost: number }>('POST', `/parts/${id}/receive`, { qty, cost }));
export const saveMech = (id: string | null, o: any) => after(id ? api('PUT', `/mechanics/${id}`, o) : api('POST', '/mechanics', o));
export const saveBase = (id: string | null, o: any) => after(id ? api('PUT', `/bases/${id}`, o) : api('POST', '/bases', o));
export const saveProgram = (id: string | null, o: any) => after(id ? api('PUT', `/pm-programs/${id}`, o) : api('POST', '/pm-programs', o));
export const saveSettings = (o: any) => after(api('PUT', '/settings', o));
export const saveFeatures = (o: { uploads: boolean }) => after(api('PUT', '/features', o));

/* users and backups */
export const listUsers = () => api<{ users: any[] }>('GET', '/users');
export interface EmailResult { emailSent?: boolean; email?: string; emailError?: string }
export const createUser = (o: any) => after(api<{ id: string } & EmailResult>('POST', '/users', o));
export const updateUser = (id: string, o: any) => after(api('PUT', `/users/${id}`, o));
export const setUserPassword = (id: string, password: string) => api('POST', `/users/${id}/password`, { password });
export const resendInvite = (id: string) => api<EmailResult>('POST', `/users/${id}/invite`);
export const sendResetLink = (id: string) => api<EmailResult>('POST', `/users/${id}/reset-link`);
export const saveUserPermissions = (id: string, overrides: Record<string, boolean>) => api<{ ok: boolean; overrides: Record<string, boolean> }>('POST', `/users/${id}/permissions`, { overrides });
export const saveRolePermissions = (role: string, overrides: Record<string, boolean>) => after(api('PUT', `/roles/${role}/permissions`, { overrides }));
export const saveAllRolePermissions = (roles: Record<string, Record<string, boolean>>) => after(api('PUT', '/roles/permissions', { roles }));
export const resetRolePermissions = (role: string) => after(api('POST', `/roles/${role}/reset`));
export const setUserActive = (id: string, active: boolean) => api('POST', `/users/${id}/${active ? 'reactivate' : 'deactivate'}`);
export const listBackups = () => api<{ backups: any[] }>('GET', '/admin/backups');
export const backupStep = (force: boolean) => api<{ status: string; step?: number; of?: number }>('POST', '/admin/backups/step', { force });
