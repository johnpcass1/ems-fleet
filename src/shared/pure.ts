import { roundMoney } from './constants';
/* Pure logic shared by the browser and the Worker: no DOM, no globals. Ported unchanged from the approved prototype. */

export const DAY = 864e5;
export const TZ_OFFSET_H = -4; // America/Guyana is UTC-4 all year, no daylight saving
export const p2 = (n: number) => String(n).padStart(2, '0');

export function gyParts(ms: number) {
  const d = new Date(ms + TZ_OFFSET_H * 36e5);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}
export function gyDate(ms: number): string {
  const p = gyParts(ms);
  return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
}
export function dayNum(s: string): number {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
}
export function addDays(s: string, n: number): string {
  const t = new Date((dayNum(s) + n) * DAY);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}
export function toDay(x: any): string | null {
  return !x ? null : String(x).length === 10 ? x : gyDate(Date.parse(x));
}
export function daysBetween(a: any, b: any): number {
  return dayNum(toDay(b)!) - dayNum(toDay(a)!);
}

export const RANK: Record<string, number> = { ok: 0, due_soon: 1, overdue: 2 };

export interface PmStatus {
  never: boolean;
  state: 'ok' | 'due_soon' | 'overdue';
  nextDueHours: number | null;
  nextDueDate: string | null;
  nextDueKm: number | null;
  hoursRemaining: number | null;
  daysRemaining: number | null;
  kmRemaining: number | null;
  bases: Record<string, string>;
  task?: any;
  projected?: string | null;
}

/** PM state for one task on one vehicle. cur={hours,km,date}; S=settings. A task without a `last` record is due now ("Never done"). */
export function pmTaskStatus(task: any, last: any, cur: { hours: number; km: number; date: string }, S: any): PmStatus {
  const win: Record<string, number> = { hours: S.dueSoonHours ?? 25, days: S.dueSoonDays ?? 14, km: S.dueSoonKm ?? 1000 };
  const has = { hours: task.intervalHours > 0, days: task.intervalDays > 0, km: task.intervalKm > 0 };
  const r: PmStatus = { never: false, state: 'ok', nextDueHours: null, nextDueDate: null, nextDueKm: null, hoursRemaining: null, daysRemaining: null, kmRemaining: null, bases: {} };
  if (!last) {
    r.never = true;
    r.state = 'overdue';
    if (has.hours) { r.hoursRemaining = 0; r.bases.hours = 'overdue'; }
    if (has.days) { r.daysRemaining = 0; r.bases.days = 'overdue'; }
    if (has.km) { r.kmRemaining = 0; r.bases.km = 'overdue'; }
    return r;
  }
  let worst: PmStatus['state'] = 'ok';
  const upd = (k: string, rem: number) => {
    const st = rem <= 0 ? 'overdue' : rem <= win[k] ? 'due_soon' : 'ok';
    r.bases[k] = st;
    if (RANK[st] > RANK[worst]) worst = st as PmStatus['state'];
  };
  if (has.hours && last.lastHours != null) { r.nextDueHours = last.lastHours + task.intervalHours; r.hoursRemaining = r.nextDueHours! - cur.hours; upd('hours', r.hoursRemaining!); }
  if (has.days && last.lastDate) { r.nextDueDate = addDays(last.lastDate, task.intervalDays); r.daysRemaining = daysBetween(cur.date, r.nextDueDate); upd('days', r.daysRemaining); }
  if (has.km && last.lastKm != null) { r.nextDueKm = last.lastKm + task.intervalKm; r.kmRemaining = r.nextDueKm! - cur.km; upd('km', r.kmRemaining!); }
  r.state = worst;
  return r;
}

/** Average engine hours per day: non-flagged readings in the last 30 days; fallback = all readings since the earliest; else null. */
export function avgHoursPerDay(readings: any[], nowMs: number): number | null {
  const rs = readings.filter((r) => !r.flagged && r.hours != null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rate = (a: any[]) => {
    if (a.length < 2) return null;
    const f = a[0], l = a[a.length - 1];
    const days = (Date.parse(l.at) - Date.parse(f.at)) / DAY;
    if (days <= 0) return null;
    const v = (l.hours - f.hours) / days;
    return v > 0 ? v : null;
  };
  return rate(rs.filter((r) => Date.parse(r.at) >= nowMs - 30 * DAY)) ?? rate(rs);
}

/** Earliest projected due date (YYYY-MM-DD) from hours burn rate and calendar due date; null when unknown. */
export function projectDue(st: PmStatus, rate: number | null, today: string): string | null {
  if (st.never) return today;
  const c: string[] = [];
  if (st.nextDueDate) c.push(st.nextDueDate);
  if (st.hoursRemaining != null && rate) c.push(addDays(today, Math.max(0, Math.ceil(st.hoursRemaining / rate))));
  return c.length ? c.sort()[0] : null;
}

export const AVAIL = new Set(['in_service', 'limited', 'reserve']);

/** Replay status events per vehicle over [startMs,endMs]. Decommissioned time is excluded from both numerator and denominator. */
export function computeAvailability(vehicles: any[], events: any[], startMs: number, endMs: number) {
  const byV: Record<string, any[]> = {};
  events.forEach((e) => (byV[e.vehicleId] = byV[e.vehicleId] || []).push(e));
  let availMs = 0, totalMs = 0;
  const per: Record<string, { avail: number; total: number }> = {};
  const downByStatus: Record<string, number> = {};
  for (const v of vehicles) {
    const ev = (byV[v.id] || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const before = ev.filter((e) => Date.parse(e.at) <= startMs);
    const inside = ev.filter((e) => Date.parse(e.at) > startMs && Date.parse(e.at) < endMs);
    let state = before.length ? before[before.length - 1].to : inside.length ? inside[0].from || v.status : v.status;
    let t = startMs, a = 0, tot = 0;
    const seg = (to: number, st: string) => {
      const ms = Math.max(0, to - t);
      if (st !== 'decommissioned') {
        tot += ms;
        if (AVAIL.has(st)) a += ms;
        else downByStatus[st] = (downByStatus[st] || 0) + ms;
      }
      t = Math.max(t, to);
    };
    for (const e of inside) { seg(Date.parse(e.at), state); state = e.to; }
    seg(endMs, state);
    per[v.id] = { avail: a, total: tot };
    availMs += a;
    totalMs += tot;
  }
  return { pct: totalMs ? (availMs / totalMs) * 100 : null, availMs, totalMs, per, downByStatus };
}

/** Warnings for a new meter reading (empty array = fine). last = latest non-flagged reading {hours,at}. */
export function checkReading(curHours: number, last: { hours: number; at: string } | null | undefined, newHours: number, nowMs: number, curKm?: number | null, newKm?: number | null): string[] {
  const w: string[] = [];
  if (newHours < curHours) w.push(`Lower than the current reading of ${curHours} h.`);
  if (last && newHours > last.hours) {
    const days = Math.max(1, (nowMs - Date.parse(last.at)) / DAY);
    if ((newHours - last.hours) / days > 24) w.push('That is more than 24 hours of running a day since the last reading.');
  }
  if (newKm != null && curKm != null && newKm < curKm) w.push(`Kilometres are lower than the current ${curKm} km.`);
  return w;
}

export function nextWoNumber(list: { number?: string }[]): string {
  const m = list.reduce((a, w) => Math.max(a, parseInt(String(w.number || '').replace(/\D/g, ''), 10) || 0), 0);
  return 'WO-' + String(m + 1).padStart(4, '0');
}
export const lineCost = (l: any) => (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
/** Total cost to GEMA: warranty lines are excluded. */
export const woTotal = (wo: any) => (wo.lines || []).reduce((s: number, l: any) => s + (l.warranty ? 0 : lineCost(l)), 0);
export const woWarranty = (wo: any) => (wo.lines || []).reduce((s: number, l: any) => s + (l.warranty ? lineCost(l) : 0), 0);

export function isComeback(wo: any, all: any[], comebackDays: number): boolean {
  if (!wo.openedAt) return false;
  const codes = new Set((wo.lines || []).map((l: any) => l.repairCode));
  const open = Date.parse(wo.openedAt);
  return all.some(
    (o) =>
      o.id !== wo.id && o.vehicleId === wo.vehicleId && o.type === 'corrective' && (o.status === 'completed' || o.status === 'closed') && o.completedAt &&
      Date.parse(o.completedAt) <= open && open - Date.parse(o.completedAt) <= comebackDays * DAY && (o.lines || []).some((l: any) => codes.has(l.repairCode)),
  );
}

/** Hours at a time, interpolated from non-flagged readings (extrapolated backwards, floored at 0). */
export function hoursAt(readings: any[], ms: number): number | null {
  const rs = readings.filter((r) => !r.flagged && r.hours != null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rs.length) return null;
  const t = (r: any) => Date.parse(r.at);
  if (ms >= t(rs[rs.length - 1])) return rs[rs.length - 1].hours;
  if (ms <= t(rs[0])) {
    if (rs.length < 2) return rs[0].hours;
    const rate = (rs[rs.length - 1].hours - rs[0].hours) / Math.max(1, (t(rs[rs.length - 1]) - t(rs[0])) / DAY);
    return Math.max(0, rs[0].hours - rate * ((t(rs[0]) - ms) / DAY));
  }
  for (let i = 1; i < rs.length; i++) {
    if (ms <= t(rs[i])) {
      const a = rs[i - 1], b = rs[i];
      return a.hours + (b.hours - a.hours) * ((ms - t(a)) / (t(b) - t(a) || 1));
    }
  }
  return rs[rs.length - 1].hours;
}

export function csvCell(v: any): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (rows: any[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/** Weighted average unit cost after receiving stock, rounded to the currency's smallest unit (whole G$, or cents). */
export function weightedAvgCost(onHand: number, unitCost: number, qty: number, cost: number, currency?: string): number {
  return roundMoney((onHand * unitCost + qty * cost) / (onHand + qty), currency);
}

/** Whether a work order total needs fleet manager approval. */
export const needsApproval = (total: number, threshold: number) => total >= threshold;
