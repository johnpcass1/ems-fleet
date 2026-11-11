/**
 * Bus check (start-of-shift ambulance inspection): the rules both the Worker and the browser use. No DOM, no globals.
 *
 *  - the shape of a requirement list (sections of items) and of a crew's answers
 *  - which list applies to a unit (by its type)
 *  - what counts as a shortage, per kind of item, and the plain-English problem title it becomes
 *  - shifts: the start times setting, which shift a submit time belongs to, and the state of a unit's shift (checked, missed, due...)
 *
 * Times are Guyana time (UTC-4 all year), like the rest of the app (see TZ_OFFSET_H in pure.ts).
 */
import { TZ_OFFSET_H, gyDate, gyParts, p2 } from './pure';

/* ---------------------------------------------------------------- lists and answers */

export const ITEM_KINDS = ['count', 'check', 'number', 'date', 'optional'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const KIND_LABEL: Record<ItemKind, string> = { count: 'Count (minimum quantity)', check: 'Check (pass or fail)', number: 'Reading (minimum)', date: 'Date (must not have passed)', optional: 'Optional (present or not)' };

/** One thing to check. `id` is stable (answers, shortages and the de-duplication of problems use it); `code` is only the small grey label from the paper sheet. */
export interface BusItem { id: string; code?: string; name: string; kind: ItemKind; min?: number; unit?: string; note?: string }
export interface BusSection { id: string; title: string; items: BusItem[] }
/** What the crew answered for one item. count: ok | short (+qty); check: pass | fail; number: value; date: date; optional: present | absent. `note` is free text. */
export interface BusAnswer { status?: 'ok' | 'short' | 'pass' | 'fail' | 'present' | 'absent'; qty?: number; value?: number; date?: string; note?: string }
export type BusAnswers = Record<string, BusAnswer>;

export const MAX_ITEMS = 300;
export const MAX_SECTIONS = 30;
export const NOTE_MAX = 200;
export const ATTESTATION = 'I verify that this unit, its crew and its equipment were checked and meet the requirements, except for the shortages and problems listed above.';

export const flatItems = (sections: BusSection[]): BusItem[] => sections.flatMap((s) => s.items);
/** Items that must be answered before a check can be sent (everything except optional items). */
export const isRequired = (it: BusItem) => it.kind !== 'optional';

/* ---------------------------------------------------------------- which list applies to a unit */

/** Unit types are compared ignoring case and extra spaces. */
export const normType = (t: unknown) => String(t ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export interface ListLike { id: string; name?: string; unitTypes?: string[]; active?: boolean }
/**
 * The list for a unit: the active list that names the unit's type; failing that, the active list with no types (the default).
 * The server refuses to save two active lists that name the same type, or two defaults, so there is never more than one. If it ever happens
 * (an old record), the one with the smallest id wins, so the answer is still the same for everyone.
 */
export function pickList<T extends ListLike>(lists: T[], unitType: unknown): T | null {
  const act = lists.filter((l) => l.active !== false).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const t = normType(unitType);
  if (t) { const hit = act.find((l) => (l.unitTypes || []).some((x) => normType(x) === t)); if (hit) return hit; }
  return act.find((l) => !(l.unitTypes || []).length) ?? null;
}
/** Two active lists must not claim the same unit type, and only one may be the default. Returns a sentence for the first clash, or null. */
export function listClash(a: ListLike & { name: string }, others: (ListLike & { name: string })[]): string | null {
  if (a.active === false) return null;
  for (const o of others) {
    if (o.id === a.id || o.active === false) continue;
    const at = (a.unitTypes || []).map(normType), ot = (o.unitTypes || []).map(normType);
    if (!at.length && !ot.length) return `"${o.name}" is already the default list (the one with no unit types). Give one of them unit types, or make one inactive.`;
    const both = (a.unitTypes || []).find((x) => ot.includes(normType(x)));
    if (both) return `"${o.name}" already covers ${both}. A unit type can only be in one active list.`;
  }
  return null;
}

/* ---------------------------------------------------------------- dates */

export const isRealDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1990 && y <= 2100;
};
const dmy = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/* ---------------------------------------------------------------- answers: validation and shortages */

export interface Shortage {
  itemId: string; code: string; name: string; kind: ItemKind; section: string;
  /** The app's problem severity: failed checks, readings and dates are "major"; a short count is "minor". Never "critical" (that would take the unit out of service). */
  severity: 'major' | 'minor';
  title: string;
  /** One plain sentence about what was found, used in the problem's description. */
  found: string;
  note?: string;
}
const num = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
const TITLE_MAX = 120; // same limit as any problem title
const cut = (s: string) => (s.length <= TITLE_MAX ? s : s.slice(0, TITLE_MAX - 1).trimEnd() + '…');

/** The problem for a shortage (or null when the answer is fine). The answer must already be valid (see answerError). */
export function shortageOf(it: BusItem, a: BusAnswer | undefined, today: string, section = ''): Shortage | null {
  if (!a) return null;
  const base = { itemId: it.id, code: it.code || '', name: it.name, kind: it.kind, section, ...(a.note ? { note: a.note } : {}) };
  switch (it.kind) {
    case 'count': {
      if (a.status !== 'short') return null;
      const u = it.unit ? ` ${it.unit}` : '';
      const each = it.note ? ` (${it.note})` : '';
      if (a.qty == null) return { ...base, severity: 'minor', title: cut(`Bus check: ${it.name} short (need ${num(it.min ?? 0)}${u})`), found: `Marked short; how many were there was not given. The minimum is ${num(it.min ?? 0)}${u}${each}.` };
      return { ...base, severity: 'minor', title: cut(`Bus check: ${it.name} short (${num(a.qty)} of ${num(it.min ?? 0)}${u})`), found: `Found ${num(a.qty)}${u}, the minimum is ${num(it.min ?? 0)}${u}${each}.` };
    }
    case 'check':
      if (a.status !== 'fail') return null;
      return { ...base, severity: 'major', title: cut(`Bus check: ${it.name} failed`), found: 'Marked as failed.' };
    case 'number': {
      if (typeof a.value !== 'number' || a.value >= (it.min ?? 0)) return null;
      const u = it.unit ? ` ${it.unit}` : '';
      return { ...base, severity: 'major', title: cut(`Bus check: ${it.name} ${num(a.value)}${u} (minimum ${num(it.min ?? 0)})`), found: `Reading ${num(a.value)}${u}, the minimum is ${num(it.min ?? 0)}${u}.` };
    }
    case 'date':
      if (!a.date || a.date >= today) return null; // a date is good through the end of that day
      return { ...base, severity: 'major', title: cut(`Bus check: ${it.name} expired ${dmy(a.date)}`), found: `Date entered ${dmy(a.date)}, which has passed.` };
    default:
      return null;
  }
}

/** The reason an answer cannot be accepted, or null. `undefined` (not answered) is "not answered" for required items and fine for optional ones. */
export function answerError(it: BusItem, a: BusAnswer | undefined): string | null {
  if (!a || (a.status == null && a.value == null && a.date == null)) return isRequired(it) ? 'Not answered.' : null;
  if (a.note != null && (typeof a.note !== 'string' || a.note.length > NOTE_MAX)) return `The note is too long (most ${NOTE_MAX} characters).`;
  switch (it.kind) {
    case 'count':
      if (a.status === 'ok') return null;
      if (a.status !== 'short') return 'Answer OK or Short.';
      if (a.qty == null) return null; // how many is optional: Short on its own is a full answer
      if (typeof a.qty !== 'number' || !Number.isInteger(a.qty) || a.qty < 0) return 'Enter how many there are (a whole number, 0 or more), or leave it blank.';
      if (a.qty >= (it.min ?? 0)) return `Short means fewer than ${it.min}. If there are ${it.min} or more, answer OK.`;
      return null;
    case 'check':
      return a.status === 'pass' || a.status === 'fail' ? null : 'Answer Pass or Fail.';
    case 'number':
      return typeof a.value === 'number' && Number.isFinite(a.value) && a.value >= 0 && a.value <= 1e9 ? null : 'Enter the reading (a number, 0 or more).';
    case 'date':
      return isRealDate(a.date) ? null : 'Enter a date.';
    default:
      return a.status === 'present' || a.status === 'absent' ? null : 'Answer present or not there.';
  }
}
export interface AnswersReport { unanswered: string[]; errors: { itemId: string; name: string; error: string }[]; shortages: Shortage[] }
/** Check every item of a list against the answers. Unknown item ids in `answers` count as errors. Shortages come back in list order. */
export function checkAnswers(sections: BusSection[], answers: BusAnswers, today: string): AnswersReport {
  const unanswered: string[] = [], errors: AnswersReport['errors'] = [], shortages: Shortage[] = [];
  const known = new Set<string>();
  for (const s of sections) for (const it of s.items) {
    known.add(it.id);
    const a = answers[it.id];
    const e = answerError(it, a);
    if (e === 'Not answered.') unanswered.push(it.id);
    else if (e) errors.push({ itemId: it.id, name: it.name, error: e });
    else { const sh = shortageOf(it, a, today, s.title); if (sh) shortages.push(sh); }
  }
  for (const k of Object.keys(answers)) if (!known.has(k)) errors.push({ itemId: k, name: k, error: 'This item is not on the list.' });
  return { unanswered, errors, shortages };
}
/** "54 of 79 answered" counts only the items that must be answered. */
export function progress(sections: BusSection[], answers: BusAnswers): { done: number; total: number } {
  let done = 0, total = 0;
  for (const it of flatItems(sections)) if (isRequired(it)) { total++; if (!answerError(it, answers[it.id])) done++; }
  return { done, total };
}

/** What a check-box "All OK in this section" fills in: counts as OK and checks as Pass, only where nothing is answered yet. Readings and dates need a real value. */
export function allOkFill(section: BusSection, answers: BusAnswers): BusAnswers {
  const out: BusAnswers = {};
  for (const it of section.items) {
    if (answers[it.id] && (answers[it.id].status != null)) continue;
    if (it.kind === 'count') out[it.id] = { status: 'ok' };
    else if (it.kind === 'check') out[it.id] = { status: 'pass' };
  }
  return out;
}

/** Clean an answer so only the fields that belong to the item's kind are kept (the server stores exactly this). */
export function cleanAnswer(it: BusItem, a: BusAnswer): BusAnswer {
  const out: BusAnswer = {};
  if (it.kind === 'count') { out.status = a.status; if (a.status === 'short' && typeof a.qty === 'number') out.qty = a.qty; }
  else if (it.kind === 'check' || it.kind === 'optional') out.status = a.status;
  else if (it.kind === 'number') out.value = a.value;
  else if (it.kind === 'date') out.date = a.date;
  const n = typeof a.note === 'string' ? a.note.trim() : '';
  if (n && (it.kind === 'count' || it.kind === 'check') && (a.status === 'short' || a.status === 'fail')) out.note = n.slice(0, NOTE_MAX);
  return out;
}

/* ---------------------------------------------------------------- shifts */

export const DEFAULT_SHIFTS = '07:00, 19:00';
/** The shortest gap allowed between two shift starts (and from the last one round to the first of the next day). */
export const MIN_SHIFT_GAP_MIN = 120;
/** A check handed in this long before a shift starts still counts for that shift. */
export const EARLY_MIN = 60;
export type ParsedShifts = { ok: true; minutes: number[]; text: string } | { ok: false; error: string };
/** "07:00, 19:00" -> minutes since midnight. 1 to 6 times, 24-hour HH:MM, at least 2 hours apart. */
export function parseShiftTimes(text: unknown): ParsedShifts {
  const parts = String(text ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'Enter at least one shift start time, like 07:00.' };
  if (parts.length > 6) return { ok: false, error: 'Use at most 6 shift start times.' };
  const mins: number[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(p);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: `"${p}" is not a time. Use 24-hour times like 07:00, separated by commas.` };
    mins.push(Number(m[1]) * 60 + Number(m[2]));
  }
  const sorted = [...new Set(mins)].sort((a, b) => a - b);
  if (sorted.length !== mins.length) return { ok: false, error: 'Each shift start time can only be listed once.' };
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 1440;
    if (next - sorted[i] < MIN_SHIFT_GAP_MIN) return { ok: false, error: 'Shift start times must be at least 2 hours apart.' };
  }
  return { ok: true, minutes: sorted, text: sorted.map((m) => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`).join(', ') };
}
/** The agency's shift starts from its setting; an unreadable value falls back to the default (07:00, 19:00). */
export function shiftMinutes(setting: unknown): number[] {
  const r = parseShiftTimes(setting);
  return r.ok ? r.minutes : (parseShiftTimes(DEFAULT_SHIFTS) as { ok: true; minutes: number[] }).minutes;
}
export const hhmm = (min: number) => `${p2(Math.floor(min / 60))}:${p2(min % 60)}`;

export interface ShiftWindow {
  index: number; label: string;
  /** When the shift starts. */
  startMs: number;
  /** A check at or after this time counts for the shift (EARLY_MIN before the start)... */
  openMs: number;
  /** ...and before this time (EARLY_MIN before the next shift starts). */
  closeMs: number;
}
/** The instant this Guyana calendar day starts. */
export const dayStartMs = (date: string) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) - TZ_OFFSET_H * 36e5; };
/** The shifts that START on this Guyana day, in order. A late shift (19:00) runs into the next morning: its window closes EARLY_MIN before the next start. */
export function shiftsOnDate(date: string, minutes: number[]): ShiftWindow[] {
  const day = dayStartMs(date);
  return minutes.map((m, i) => {
    const startMs = day + m * 60000;
    const nextStart = i + 1 < minutes.length ? day + minutes[i + 1] * 60000 : day + (minutes[0] + 1440) * 60000;
    return { index: i, label: hhmm(m), startMs, openMs: startMs - EARLY_MIN * 60000, closeMs: nextStart - EARLY_MIN * 60000 };
  });
}
/** Which shift (the Guyana date it starts on and its number) a submit time belongs to. */
export function shiftFor(ms: number, minutes: number[]): { date: string; index: number } {
  const d = gyDate(ms);
  const day = (n: number) => gyDate(dayStartMs(d) + n * 864e5 + 12 * 36e5);
  for (const date of [day(-1), d, day(1)]) {
    for (const w of shiftsOnDate(date, minutes)) if (ms >= w.openMs && ms < w.closeMs) return { date, index: w.index };
  }
  // cannot happen: the windows of consecutive days tile the whole timeline
  return { date: d, index: 0 };
}

export type CellState = 'checked' | 'missed' | 'due' | 'upcoming' | 'not_expected';
/**
 * The state of one unit in one shift.
 *  checked       a check was submitted inside the shift's window (even if the unit was out of service)
 *  not_expected  no check, and the unit was out of service when the shift started (or was not in the fleet yet)
 *  upcoming      the shift has not started yet
 *  due           the shift has started and nothing has been submitted yet
 *  missed        the window has closed with no check
 */
export function cellState(w: ShiftWindow, nowMs: number, expected: boolean, hasCheck: boolean): CellState {
  if (hasCheck) return 'checked';
  if (!expected) return 'not_expected';
  if (nowMs < w.startMs) return 'upcoming';
  if (nowMs < w.closeMs) return 'due';
  return 'missed';
}

/** "07:00 shift" or "19:00 shift" */
export const shiftName = (w: { label: string }) => `${w.label} shift`;
export { gyDate, gyParts };
