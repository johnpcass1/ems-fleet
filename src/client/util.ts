import { gyDate, gyParts, p2 } from '../shared/pure';

export const $ = (s: string, r: ParentNode = document): any => r.querySelector(s);
export const $$ = (s: string, r: ParentNode = document): any[] => [...r.querySelectorAll(s)];
export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const num = (n: any) => (n == null || n === '' || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
export const gyd = (n: any) => 'G$ ' + Math.round(Number(n) || 0).toLocaleString('en-US');
export function fmtDate(x: any) {
  if (!x) return '–';
  const s = String(x).length === 10 ? x : gyDate(Date.parse(x));
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDT(x: any) {
  if (!x) return '–';
  const p = gyParts(Date.parse(x));
  return `${p2(p.d)}/${p2(p.m)}/${p.y} ${p2(p.hh)}:${p2(p.mm)}`;
}
export const nowISO = () => new Date().toISOString();
export const todayStr = () => gyDate(Date.now());
export const fmtSize = (n: any) => {
  n = Number(n) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
};

/** An error the person should see as-is. */
export const uerr = (m: string) => Object.assign(new Error(m), { user: true });

export function toast(msg: string, bad?: boolean) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  if (bad) el.setAttribute('role', 'alert');
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3500);
}

export async function run(fn: () => Promise<any>, fail?: string): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    if (!(e && e.user)) console.error(e);
    toast(e && e.user ? e.message : fail || 'Could not save that. Please try again.', true);
    return false;
  }
}

/* tiny form helpers */
export const opt = (v: any, l: any, sel: any) => `<option value="${esc(v)}"${String(sel) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
export const selHtml = (id: string, items: any[][], val: any, extra = '') => `<select id="${id}" name="${id}" ${extra}>${items.map(([v, l]) => opt(v, l, val)).join('')}</select>`;
export const field = (label: string, ctl: string, hint?: string) => `<label class="f"><span class="l">${esc(label)}</span>${ctl}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
export const inp = (id: string, val: any, type = 'text', extra = '') => `<input id="${id}" name="${id}" type="${type}" value="${esc(val ?? '')}" ${extra}>`;
export const nv = (s: any) => {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
export const val = (id: string) => {
  const el: any = document.getElementById(id);
  return el ? String(el.value).trim() : '';
};
