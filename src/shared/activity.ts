/**
 * Activity history: everything that turns an audit_log row into something a person can read.
 * Shared by the Worker (filters, CSV export, the sanitiser) and the browser (sentences, "What changed"), so both agree.
 * No DOM, no globals.
 */
import { ROLES, STATUS, WO_STATUS, WO_TYPES, PRIO, SEV, ISSUE_ST, HOLD } from './constants';
import { PERM_GROUPS } from './perm';
import { TZ_OFFSET_H, gyParts, p2 } from './pure';

/* ---------------------------------------------------------------- categories */

export const ACTIVITY_CATEGORIES = [
  { key: 'vehicles', label: 'Vehicles' },
  { key: 'problems', label: 'Problems' },
  { key: 'work_orders', label: 'Work orders' },
  { key: 'pm', label: 'Preventive maintenance' },
  { key: 'parts_mechanics', label: 'Parts & mechanics' },
  { key: 'people', label: 'People & permissions' },
  { key: 'settings', label: 'Settings & features' },
  { key: 'sign_ins', label: 'Sign-ins' },
  { key: 'backups', label: 'Backups' },
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]['key'];
export const CATEGORY_KEYS: string[] = ACTIVITY_CATEGORIES.map((c) => c.key);
export const categoryLabel = (key: string) => ACTIVITY_CATEGORIES.find((c) => c.key === key)?.label ?? 'Other';

export interface CategoryRule { prefix: string; category: ActivityCategory; entityType?: string }
/**
 * THE one table that maps an action (the text before the first "." decides, e.g. "wo.approve" -> "wo.") to a category.
 * Attachments belong to whatever they are attached to. An action no rule matches shows as "Other" and can still be found with search.
 * Prefixes contain only letters and ".", so the Worker can use them in LIKE without escaping.
 */
export const CATEGORY_RULES: CategoryRule[] = [
  { prefix: 'vehicle.', category: 'vehicles' },
  { prefix: 'reading.', category: 'vehicles' },
  { prefix: 'issue.', category: 'problems' },
  { prefix: 'attachment.', category: 'problems', entityType: 'issue' },
  { prefix: 'attachment.', category: 'work_orders', entityType: 'work_order' },
  { prefix: 'wo.', category: 'work_orders' },
  { prefix: 'program.', category: 'pm' },
  { prefix: 'part.', category: 'parts_mechanics' },
  { prefix: 'mechanic.', category: 'parts_mechanics' },
  { prefix: 'user.', category: 'people' },
  { prefix: 'role.', category: 'people' },
  { prefix: 'settings.', category: 'settings' },
  { prefix: 'features.', category: 'settings' },
  { prefix: 'base.', category: 'settings' },
  { prefix: 'sample.', category: 'settings' },
  { prefix: 'agency.', category: 'settings' },
  { prefix: 'auth.', category: 'sign_ins' },
  { prefix: 'backup.', category: 'backups' },
];
export function categoryOf(action: string, entityType?: string | null): ActivityCategory | 'other' {
  const a = String(action || '');
  for (const r of CATEGORY_RULES) if (a.startsWith(r.prefix) && (!r.entityType || r.entityType === entityType)) return r.category;
  return 'other';
}
export const rulesFor = (category: string) => CATEGORY_RULES.filter((r) => r.category === category);

/* ---------------------------------------------------------------- the sanitiser */

/** Keys that must never be written to the audit log, whatever the caller passes. Compared case-insensitively, anywhere in the key. */
const SECRET_KEY = /pass(word|wd|phrase)|^pwd?$|token|secret|session|hash|cookie|authorization|credential|api[-_]?key/i;
const LINK_SECRET = /#t=[A-Za-z0-9_-]+/g;
/** Returns a copy of `v` with every secret-looking key removed (recursively, through arrays too) and link secrets in text blanked out. */
export function sanitizeAudit(v: unknown, depth = 0): any {
  if (v == null) return v;
  if (typeof v === 'string') return v.replace(LINK_SECRET, '#t=[removed]');
  if (typeof v !== 'object') return v;
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.map((x) => sanitizeAudit(x, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeAudit(x, depth + 1);
  }
  return out;
}

/* ---------------------------------------------------------------- dates and times (Guyana) */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The instant (ISO, UTC) at which this Guyana calendar day starts. America/Guyana is UTC-4 all year. */
export function gyDayStartISO(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - TZ_OFFSET_H * 36e5).toISOString();
}
/** The instant at which the day AFTER this Guyana day starts (the exclusive end of the day). */
export function gyDayEndISO(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - TZ_OFFSET_H * 36e5).toISOString();
}
export const timeHM = (iso: string) => { const p = gyParts(Date.parse(iso)); return `${p2(p.hh)}:${p2(p.mm)}`; };
/** DD/MM/YYYY (from a date or a timestamp), or the original text when it is not a date. */
export function dmy(x: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)}`;
  const ms = Date.parse(x);
  if (Number.isNaN(ms)) return x;
  const p = gyParts(ms);
  return `${p2(p.d)}/${p2(p.m)}/${p.y}`;
}
export const dmyHM = (iso: string) => `${dmy(iso)} ${timeHM(iso)}`;
/** "Today", "Yesterday" or "Mon 9 Nov 2026". Both arguments are Guyana dates (YYYY-MM-DD). */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d), [ty, tm, td] = today.split('-').map(Number);
  if (t === Date.UTC(ty, tm - 1, td - 1)) return 'Yesterday';
  return `${WEEKDAYS[new Date(t).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/* ---------------------------------------------------------------- lookups the describer needs */

export interface Lookup {
  unit(id: string): string | null;
  wo(id: string): string | null;
  base(id: string): string | null;
  person(id: string): string | null;
  mechanic(id: string): string | null;
  part(id: string): string | null;
  issue(id: string): { title: string; vehicleId: string | null } | null;
}
export const NO_LOOKUP: Lookup = { unit: () => null, wo: () => null, base: () => null, person: () => null, mechanic: () => null, part: () => null, issue: () => null };

/** A piece of a sentence. Pieces with an `id` name something that still exists, so the screen can link to it. */
export interface Seg { k: 't' | 'unit' | 'wo' | 'user'; v: string; id?: string }
export interface ActivityLike {
  action: string; entityType: string; entityId: string | null; before?: any; after?: any;
  /** The email stored on the row: the address tried, for a failed sign-in. */
  email?: string | null;
}
export const plain = (segs: Seg[]) => segs.map((s) => s.v).join('');

/* ---------------------------------------------------------------- small formatting helpers */

const isObj = (x: any) => x != null && typeof x === 'object' && !Array.isArray(x);
const gyd = (n: any) => 'G$ ' + Math.round(Number(n) || 0).toLocaleString('en-US');
const num = (n: any) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
const roleLabel = (r: any) => (ROLES as Record<string, string>)[r] || String(r ?? '');
const permLabel = new Map<string, string>(PERM_GROUPS.flatMap((g) => g.items));
export const PERM_LABEL = (key: string) => permLabel.get(key) ?? key;
const humanise = (k: string) => { const s = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]+/g, ' ').trim().toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const aOrAn = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);

/* ---------------------------------------------------------------- describers: one sentence per action */

type Parts = (string | Seg)[];
const S = (...parts: Parts): Seg[] => parts.map((p) => (typeof p === 'string' ? { k: 't' as const, v: p } : p));
type Describer = (r: ActivityLike, L: Lookup) => Seg[];

const unitSeg = (L: Lookup, id: any, snapshot?: any): Seg => {
  const n = id ? L.unit(String(id)) : null;
  if (n) return { k: 'unit', v: n, id: String(id) };
  return { k: 't', v: snapshot ? String(snapshot) : 'a unit' };
};
const woSeg = (L: Lookup, id: any, snapshot?: any): Seg => {
  const n = id ? L.wo(String(id)) : null;
  if (n) return { k: 'wo', v: n, id: String(id) };
  return { k: 't', v: snapshot ? String(snapshot) : 'a work order' };
};
/** "work order WO-0012" (linked), or "a work order" when it no longer exists. */
const woRef = (L: Lookup, id: any, snapshot?: any): Parts => { const s = woSeg(L, id, snapshot); return s.k === 'wo' || snapshot ? ['work order ', s] : [s]; };
const userSeg = (L: Lookup, id: any, snapshot?: any): Seg => {
  const n = id ? L.person(String(id)) : null;
  if (n) return { k: 'user', v: n, id: String(id) };
  return { k: 't', v: snapshot ? String(snapshot) : 'a person' };
};
const baseName = (L: Lookup, id: any) => (id ? L.base(String(id)) ?? 'an unknown base' : 'no base');
const keysChanged = (b: any, a: any, keys: string[]) => keys.filter((k) => a && k in a && JSON.stringify(b?.[k] ?? null) !== JSON.stringify(a[k] ?? null));
const withKeys = (head: Parts, labels: string[]): Seg[] => S(...head, ...(labels.length ? [` (${labels.join(', ')})`] : []));

/** Permission changes between two override maps: [{ key, to }] where `to` is true, false or undefined (back to the default). */
function permChanges(before: any, after: any): { key: string; to: boolean | undefined }[] {
  const b = isObj(before?.overrides) ? before.overrides : {}, a = isObj(after?.overrides) ? after.overrides : {};
  const out: { key: string; to: boolean | undefined }[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (b[k] !== a[k]) out.push({ key: k, to: a[k] });
  return out;
}
function permSentence(ch: { key: string; to: boolean | undefined }[], who: Parts, whoIsRole: boolean): Seg[] {
  if (ch.length === 1) {
    const c = ch[0], l = `'${PERM_LABEL(c.key)}'`;
    if (c.to === true) return S(`Turned on ${l} for `, ...who);
    if (c.to === false) return S(`Turned off ${l} for `, ...who);
    return S(`Put ${l} back to the default for `, ...who);
  }
  if (!ch.length) return S(whoIsRole ? 'Saved permissions for ' : 'Saved permissions for ', ...who, ' (nothing changed)');
  return S(`Changed ${ch.length} permissions for `, ...who);
}

const DESCRIBE: Record<string, Describer> = {
  /* sign-ins */
  'auth.login': () => S('Signed in'),
  'auth.logout': () => S('Signed out'),
  'auth.login_failed': (r) => S('Failed sign-in for ', r.email || 'an unknown address'),
  'auth.locked': (r) => S('Locked ', r.email || 'an account', ` for ${r.after?.minutes ?? 15} minutes after too many wrong passwords`),
  'auth.change_password': () => S('Changed their own password'),
  'auth.set_password': (r) => S(r.after?.how === 'invite' ? 'Chose a password from an invite link' : 'Chose a new password from a reset link'),
  'auth.forgot_password': () => S('Asked for a password reset link'),

  /* agencies (super user) */
  'agency.create': (r) => S('Added the agency ', r.after?.name || r.entityId || ''),
  'agency.rename': (r) => S('Renamed the agency ', r.before?.name || '', ' to ', r.after?.name || ''),
  'agency.deactivate': () => S('Deactivated this agency'),
  'agency.reactivate': () => S('Reactivated this agency'),
  'agency.open': () => S('Opened this agency as the super user'),
  'agency.close': () => S('Went back to their own agency'),

  /* people and permissions */
  'user.create': (r, L) => S('Added ', userSeg(L, r.entityId, r.after?.name), r.after?.role ? ` as ${roleLabel(r.after.role)}` : ''),
  'user.update': (r, L) => {
    const b = r.before, a = r.after, ch = keysChanged(b, a, ['name', 'role', 'baseIds', 'mechanicId']);
    const who = userSeg(L, r.entityId, a?.name ?? b?.name);
    if (ch.length === 1 && ch[0] === 'role') return S('Changed ', who, "'s role from ", roleLabel(b?.role), ' to ', roleLabel(a.role));
    if (ch.length === 1 && ch[0] === 'name') return S('Renamed ', String(b?.name ?? 'a person'), ' to ', who);
    if (ch.length === 1 && ch[0] === 'baseIds') return S('Changed ', who, "'s bases to ", (a.baseIds || []).map((x: string) => baseName(L, x)).join(', ') || 'none');
    if (ch.length === 1 && ch[0] === 'mechanicId') return S('Changed the mechanic linked to ', who);
    const labels = ch.map((k) => ({ name: 'name', role: 'role', baseIds: 'bases', mechanicId: 'linked mechanic' } as any)[k]);
    return withKeys(['Updated ', who], labels);
  },
  'user.deactivate': (r, L) => S('Deactivated ', userSeg(L, r.entityId, r.after?.email)),
  'user.reactivate': (r, L) => S('Reactivated ', userSeg(L, r.entityId)),
  'user.set_password': (r, L) => S('Set a new password for ', userSeg(L, r.entityId, r.after?.email)),
  'user.invite_resend': (r, L) => S('Sent a new invite email to ', userSeg(L, r.entityId, r.after?.email)),
  'user.reset_link': (r, L) => S('Sent a password reset link to ', userSeg(L, r.entityId, r.after?.email)),
  'user.permissions': (r, L) => permSentence(permChanges(r.before, r.after), [userSeg(L, r.entityId, r.after?.email)], false),
  'role.permissions': (r) => permSentence(permChanges(r.before, r.after), [roleLabel(r.entityId)], true),
  'role.reset': (r) => S('Put ', roleLabel(r.entityId), ' permissions back to the defaults'),

  /* vehicles */
  'vehicle.move': (r, L) => S('Moved ', unitSeg(L, r.entityId, r.before?.unit), ' from ', baseName(L, r.before?.baseId), ' to ', baseName(L, r.after?.baseId), r.after?.tempUntil ? ` until ${dmy(r.after.tempUntil)}` : ''),
  'vehicle.status': (r, L) => S('Changed ', unitSeg(L, r.entityId, r.before?.unit), ' from ', STATUS[r.before?.status]?.label ?? String(r.before?.status ?? 'unknown'), ' to ', STATUS[r.after?.status]?.label ?? String(r.after?.status ?? 'unknown'), r.after?.reason ? ` (${r.after.reason})` : ''),
  'vehicle.create': (r, L) => S('Added unit ', unitSeg(L, r.entityId, r.after?.unit), r.after?.baseId ? ` at ${baseName(L, r.after.baseId)}` : ''),
  'vehicle.update': (r, L) => {
    const names: Record<string, string> = { unit: 'unit name', baseId: 'base', engineHours: 'engine hours', odometerKm: 'odometer' };
    return withKeys(['Edited ', unitSeg(L, r.entityId, r.before?.unit)], keysChanged(r.before, r.after, Object.keys(names)).map((k) => names[k]));
  },
  'reading.log': (r, L) => S('Logged ', num(r.after?.hours ?? 0), ' engine hours on ', unitSeg(L, r.entityId), r.after?.flagged ? ' (flagged for a supervisor to check)' : ''),
  'reading.accept': (r) => S('Accepted a flagged engine-hour reading', r.after?.vehicleHours != null ? ` of ${num(r.after.vehicleHours)} hours` : ''),

  /* problems */
  'issue.report': (r, L) => {
    const sev = String(r.after?.severity || 'major').toLowerCase();
    return S(`Reported ${aOrAn(sev)} ${sev} problem on `, unitSeg(L, r.after?.vehicleId), r.after?.title ? `: ${r.after.title}` : '');
  },
  'issue.dismiss': (r, L) => {
    const i = r.entityId ? L.issue(r.entityId) : null;
    return i ? S(`Dismissed the problem '${i.title}'`, ...(i.vehicleId ? [' on ', unitSeg(L, i.vehicleId)] : [])) : S('Dismissed a problem');
  },

  /* work orders */
  'wo.create': (r, L) => S('Opened ', ...woRef(L, r.entityId, r.after?.number), ' for ', unitSeg(L, r.after?.vehicleId)),
  'wo.update': (r, L) => {
    const names: Record<string, string> = { priority: 'priority', mechanicId: 'mechanic', notes: 'notes' };
    return withKeys(['Updated ', ...woRef(L, r.entityId)], keysChanged(r.before, r.after, Object.keys(names)).map((k) => names[k]));
  },
  'wo.line.add': (r, L) => S('Added a line to ', ...woRef(L, r.entityId), r.after?.description ? `: ${r.after.description}` : ''),
  'wo.line.remove': (r, L) => S('Removed a line from ', ...woRef(L, r.entityId), r.before?.description ? `: ${r.before.description}` : ''),
  'wo.approve': (r, L) => S('Approved ', ...woRef(L, r.entityId)),
  'wo.schedule': (r, L) => S('Scheduled ', ...woRef(L, r.entityId), r.after?.scheduledFor ? ` for ${dmy(r.after.scheduledFor)}` : ''),
  'wo.start': (r, L) => S('Started work on ', ...woRef(L, r.entityId)),
  'wo.hold': (r, L) => S('Put ', ...woRef(L, r.entityId), ' on hold', r.after?.reason ? ` (${HOLD[r.after.reason] ?? r.after.reason})` : ''),
  'wo.resume': (r, L) => S('Resumed work on ', ...woRef(L, r.entityId)),
  'wo.complete': (r, L) => S('Completed ', ...woRef(L, r.entityId), r.after?.hours != null ? ` at ${num(r.after.hours)} engine hours` : ''),
  'wo.close': (r, L) => S('Closed ', ...woRef(L, r.entityId)),
  'wo.cancel': (r, L) => S('Cancelled ', ...woRef(L, r.entityId)),

  /* parts, mechanics, PM, setup */
  'part.create': (r) => S('Added part ', String(r.after?.number ?? ''), r.after?.description ? ` (${r.after.description})` : ''),
  'part.update': (r, L) => S('Updated part ', (r.entityId && L.part(r.entityId)) || String(r.after?.number ?? r.before?.number ?? 'a part')),
  'part.receive': (r, L) => S('Received ', num(r.after?.received ?? 0), ' of part ', (r.entityId && L.part(r.entityId)) || 'a part', r.after?.cost != null ? ` at ${gyd(r.after.cost)} each` : ''),
  'mechanic.create': (r) => S('Added mechanic ', String(r.after?.name ?? '')),
  'mechanic.update': (r, L) => S('Updated mechanic ', (r.entityId && L.mechanic(r.entityId)) || String(r.after?.name ?? 'a mechanic')),
  'base.create': (r) => S('Added base ', String(r.after?.name ?? '')),
  'base.update': (r, L) => S('Updated base ', (r.entityId && L.base(r.entityId)) || String(r.after?.name ?? 'a base')),
  'program.create': (r) => S('Added PM program ', String(r.after?.name ?? '')),
  'program.update': (r) => S('Updated PM program ', String(r.after?.name ?? r.before?.name ?? '')),
  'settings.update': (r) => withKeys(['Changed settings'], diffFields('settings', r.before, r.after, NO_LOOKUP).map((c) => c.label.toLowerCase())),
  'features.update': (r) => S(`Turned photo and PDF uploads ${r.after?.uploads ? 'on' : 'off'}`),
  'sample.remove': (r) => S('Removed sample data', r.after?.rows != null ? ` (${num(r.after.rows)} records)` : ''),
  'backup.run': () => S('Ran a backup'),
  'attachment.add': (r, L) => S('Attached ', String(r.after?.name ?? 'a file'), ' to ', ...attachedTo(r, L)),
  'attachment.delete': (r, L) => S('Removed ', String(r.before?.name ?? 'a file'), ' from ', ...attachedTo(r, L)),
};
function attachedTo(r: ActivityLike, L: Lookup): Parts {
  if (r.entityType === 'work_order') return woRef(L, r.entityId);
  const i = r.entityId ? L.issue(r.entityId) : null;
  return i?.vehicleId ? ['a problem on ', unitSeg(L, i.vehicleId)] : ['a problem'];
}

/** What a row is about, for the generic sentence: "work order WO-0012", "unit GEMA-03", "part P-1001"... */
function subjectOf(r: ActivityLike, L: Lookup): Parts {
  const id = r.entityId;
  switch (r.entityType) {
    case 'work_order': return woRef(L, id);
    case 'vehicle': { const s = unitSeg(L, id, r.before?.unit ?? r.after?.unit); return s.k === 'unit' ? ['unit ', s] : [s]; }
    case 'user': return [userSeg(L, id, r.after?.name ?? r.before?.name)];
    case 'issue': { const i = id ? L.issue(id) : null; return [i ? `the problem '${i.title}'` : 'a problem']; }
    case 'part': return [(id && L.part(id)) ? `part ${L.part(id)}` : 'a part'];
    case 'mechanic': return [(id && L.mechanic(id)) ? `mechanic ${L.mechanic(id)}` : 'a mechanic'];
    case 'base': return [(id && L.base(id)) ? `base ${L.base(id)}` : 'a base'];
    case 'pm_program': return ['a PM program'];
    case 'role': return [roleLabel(id)];
    case 'settings': return ['settings'];
    default: { const t = String(r.entityType || 'item').replace(/_/g, ' '); return [`${aOrAn(t)} ${t}`]; }
  }
}
/** The sentence for any row. Unknown actions get a sensible generic one ("Updated work order WO-0012"). */
export function describe(r: ActivityLike, L: Lookup = NO_LOOKUP): Seg[] {
  const f = DESCRIBE[r.action];
  if (f) { try { return f(r, L); } catch { /* fall through to the generic sentence */ } }
  const tail = String(r.action || '').split('.').pop() || '';
  const verb = /^(create|add|new)/.test(tail) ? 'Added' : /^(delete|remove)/.test(tail) ? 'Removed' : 'Updated';
  return S(verb + ' ', ...subjectOf(r, L));
}
export const describePlain = (r: ActivityLike, L: Lookup = NO_LOOKUP) => plain(describe(r, L));

/* ---------------------------------------------------------------- "What changed": before -> after, field by field */

export interface FieldChange { key: string; label: string; from: string; to: string }
export const EMPTY = '—';

const LABELS: Record<string, string> = {
  baseId: 'Base', fromBaseId: 'From base', toBaseId: 'To base', baseIds: 'Bases', engineHours: 'Engine hours', odometerKm: 'Odometer (km)', unit: 'Unit name', status: 'Status', statusReason: 'Reason', reason: 'Reason',
  mechanicId: 'Mechanic', priority: 'Priority', notes: 'Notes', name: 'Name', role: 'Role', tempUntil: 'Temporary until', onHand: 'On hand', unitCost: 'Unit cost', number: 'Number', description: 'Description',
  approvalThresholdGYD: 'Approval threshold', dueSoonHours: 'Due-soon window (hours)', dueSoonDays: 'Due-soon window (days)', dueSoonKm: 'Due-soon window (km)', comebackDays: 'Comeback window (days)',
  'features.uploads': 'Photo and PDF uploads', uploads: 'Photo and PDF uploads', active: 'Active', hours: 'Engine hours', km: 'Kilometres', flagged: 'Flagged for review', email: 'Email', fits: 'Fits', reorderPoint: 'Reorder point',
  region: 'Region', minUnits: 'Minimum units', shop: 'Location', severity: 'How serious', title: 'Title', vehicleId: 'Unit', type: 'Type', how: 'How', received: 'Quantity received', cost: 'Cost per unit',
  scheduledFor: 'Scheduled for', vehicleHours: 'Unit hours', mechanicName: 'Mechanic', phone: 'Phone', size: 'Size', tasks: 'Tasks', rows: 'Records removed', qty: 'Quantity',
};
const MONEY = new Set(['unitCost', 'cost', 'approvalThresholdGYD', 'total', 'price', 'amount']);
const HOURS = new Set(['engineHours', 'hours', 'vehicleHours']);
const KM = new Set(['odometerKm', 'km']);

const isEmpty = (v: any) => v == null || v === '' || (Array.isArray(v) && !v.length);
/** Flatten nested objects to dotted paths. Permission override maps (`overrides`) become `perm.<key>`. */
function flat(o: any, prefix = '', out: Map<string, any> = new Map(), depth = 0): Map<string, any> {
  if (!isObj(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'id') continue;
    if (k === 'overrides' && isObj(v) && !prefix) { for (const [pk, pv] of Object.entries(v as object)) out.set(`perm.${pk}`, pv); if (!Object.keys(v as object).length) out.set('perm', undefined); continue; }
    if (isObj(v) && depth < 3) flat(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    else out.set(prefix ? `${prefix}.${k}` : k, v);
  }
  return out;
}
const lastKey = (path: string) => path.split('.').pop() || path;

export function fieldLabel(path: string): string {
  if (path.startsWith('perm.')) return PERM_LABEL(path.slice(5));
  return LABELS[path] ?? LABELS[lastKey(path)] ?? humanise(lastKey(path));
}
/** One value, formatted for people: names instead of ids, DD/MM/YYYY dates, G$ amounts, yes/no, role and status labels. */
export function formatValue(path: string, v: any, entityType: string, L: Lookup = NO_LOOKUP): string {
  const key = lastKey(path);
  if (path.startsWith('perm.')) return v === undefined ? 'Role default' : v ? 'Yes' : 'No';
  if (isEmpty(v)) return EMPTY;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    if (/baseIds$/i.test(key)) return v.map((x) => L.base(String(x)) ?? String(x)).join(', ');
    if (v.every((x) => x == null || typeof x !== 'object')) return v.map(String).join(', ');
    return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  }
  if (isObj(v)) return Object.keys(v).length ? `${Object.keys(v).length} ${Object.keys(v).length === 1 ? 'setting' : 'settings'}` : EMPTY;
  const s = String(v);
  if (/^(from|to)?baseid$/i.test(key)) return L.base(s) ?? s;
  if (/^vehicleid$/i.test(key)) return L.unit(s) ?? s;
  if (/^mechanicid$/i.test(key)) return L.mechanic(s) ?? s;
  if (/^partid$/i.test(key)) return L.part(s) ?? s;
  if (/^(userid|byuser|by)$/i.test(key)) return L.person(s) ?? s;
  if (/^woid$/i.test(key)) return L.wo(s) ?? s;
  if (key === 'role') return roleLabel(s);
  if (key === 'status' || key === 'statusReason') {
    if (key === 'status') return (entityType === 'work_order' ? WO_STATUS[s] : entityType === 'issue' ? ISSUE_ST[s] : STATUS[s]?.label ?? WO_STATUS[s]) ?? s;
    return s;
  }
  if (key === 'priority') return PRIO[s] ?? s;
  if (key === 'severity') return SEV[s] ?? s;
  if (key === 'type' && entityType === 'work_order') return WO_TYPES[s] ?? s;
  if (key === 'reason') return HOLD[s] ?? s;
  if (typeof v === 'number') {
    if (MONEY.has(key)) return gyd(v);
    if (HOURS.has(key)) return `${num(v)} h`;
    if (KM.has(key)) return `${num(v)} km`;
    return num(v);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dmy(s);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s)) return dmyHM(s);
  return s;
}
const same = (a: any, b: any) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/**
 * The fields that actually differ between `before` and `after`, with readable labels and values.
 * `after` is often a partial update (only the fields that were sent): a field missing from it is left out, not shown as removed.
 * Creates (no before) list every field with "—" as the old value; deletes list every field with "—" as the new one.
 */
export function diffFields(entityType: string, before: any, after: any, L: Lookup = NO_LOOKUP): FieldChange[] {
  const b = flat(before), a = flat(after), out: FieldChange[] = [];
  const partial = isObj(before) && isObj(after);
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const perm = path === 'perm' || path.startsWith('perm.');
    if (path === 'perm') continue;
    if (partial && !perm && !a.has(path)) continue;
    const bv = b.get(path), av = a.get(path);
    if (perm ? bv === av : same(bv, av)) continue;
    out.push({ key: path, label: fieldLabel(path), from: formatValue(path, bv, entityType, L), to: formatValue(path, av, entityType, L) });
  }
  return out;
}
/** Long values are cut with an ellipsis; the screen offers "Show all". */
export function truncate(text: string, max = 120): { text: string; cut: boolean } {
  const t = String(text);
  return t.length > max ? { text: t.slice(0, max).trimEnd() + '…', cut: true } : { text: t, cut: false };
}

/* ---------------------------------------------------------------- CSV */

/** Text that starts with = + - @ is read as a formula by spreadsheet programs; a leading apostrophe keeps it as text. */
export const csvSafe = (s: any) => { const t = s == null ? '' : String(s); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; };
export const ACTIVITY_CSV_HEADER = ['When (Guyana time)', 'Person', 'Email', 'Role', 'Type', 'What happened', 'Action code', 'Item type', 'Item id'];
export interface ActivityCsvRow { at: string; action: string; entityType: string; entityId: string | null; before: any; after: any; email: string | null; actor: { name: string | null; email: string | null; role: string | null } | null }
export function activityCsvRow(r: ActivityCsvRow, L: Lookup): string[] {
  return [dmyHM(r.at), r.actor?.name ?? '', r.actor?.email ?? r.email ?? '', r.actor?.role ? roleLabel(r.actor.role) : '', categoryLabel(categoryOf(r.action, r.entityType)), describePlain(r, L), r.action, r.entityType, r.entityId ?? ''].map(csvSafe);
}
