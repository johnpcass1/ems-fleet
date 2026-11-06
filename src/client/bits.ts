/** Small HTML building blocks shared by the views. */
import { STATUS } from '../shared/constants';
import { D, baseName, basesSorted, vehiclesSorted } from './state';
import { esc, fmtDate, todayStr } from './util';
import { fileUrl, safeAsset } from './files';

export const pill = (kind: string, label: string) => `<span class="pill ${kind}">${esc(label)}</span>`;
export const statusPill = (s: string) => pill(STATUS[s]?.kind || 'off', STATUS[s]?.label || s);
export const pmPill = (s: string) => (s === 'overdue' ? pill('bad', 'Overdue') : s === 'due_soon' ? pill('warn', 'Due soon') : pill('ok', 'OK'));
export const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

export const baseOpts = (withAll: boolean) => [...(withAll ? [['', 'All bases']] : []), ...basesSorted().map((b) => [b.id, b.name])];
export const vehOpts = () => vehiclesSorted().map((v) => [v.id, `${v.unit} (${baseName(v.baseId)})`]);
export const statusOpts = (withAll: boolean) => [...(withAll ? [['', 'All statuses']] : []), ...Object.entries(STATUS).map(([k, v]) => [k, v.label])];

export function loanChip(v: any) {
  if (!v.tempUntil || !v.tempFromBaseId) return '';
  return `<span class="chip ${v.tempUntil < todayStr() ? 'bad' : 'acc'}">On loan from ${esc(baseName(v.tempFromBaseId))} until ${fmtDate(v.tempUntil)}</span>`;
}
export const CLIP = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2"/></svg>';
export const attChip = (d: any) => {
  const n = (d.attachments || []).length;
  return n ? ` <span class="chip acc">${CLIP}${n} ${n === 1 ? 'file' : 'files'}</span>` : '';
};
export const isImgAtt = (a: any) => /^image\//.test(a.type || '') && safeAsset(a.assetId);
export const thumbStrip = (d: any) => {
  const im = (d.attachments || []).filter(isImgAtt).slice(0, 4);
  return im.length ? `<div class="thumbs">${im.map((a: any) => `<img class="thumb" src="${esc(fileUrl(a.assetId))}" alt="Photo: ${esc(a.name)}" width="48" height="48" loading="lazy">`).join('')}</div>` : '';
};
void D;
