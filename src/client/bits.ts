/** Small HTML building blocks shared by the views. */
import { STATUS } from '../shared/constants';
import { D, baseName, basesSorted, vehiclesSorted } from './state';
import { esc, fmtDate, todayStr } from './util';
import { fileUrl, safeAsset } from './files';
import { icon } from './icons';

/** A small tinted status badge. kind: ok | warn | bad | res | off | acc */
export const pill = (kind: string, label: string) => `<span class="badge ${kind}">${esc(label)}</span>`;
/** A dense-row status marker: 8x8 swatch and the label. */
export const statusSw = (s: string) => `<span class="sw-l"><i class="sw ${STATUS[s]?.kind || 'off'}"></i>${esc(STATUS[s]?.label || s)}</span>`;
export const statusPill = (s: string) => pill(STATUS[s]?.kind || 'off', STATUS[s]?.label || s);
export const pmPill = (s: string) => (s === 'overdue' ? pill('bad', 'Overdue') : s === 'due_soon' ? pill('warn', 'Due soon') : pill('ok', 'OK'));
export const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

export const baseOpts = (withAll: boolean) => [...(withAll ? [['', 'All bases']] : []), ...basesSorted().map((b) => [b.id, b.name])];
export const vehOpts = () => vehiclesSorted().map((v) => [v.id, `${v.unit} (${baseName(v.baseId)})`]);
export const statusOpts = (withAll: boolean) => [...(withAll ? [['', 'All statuses']] : []), ...Object.entries(STATUS).map(([k, v]) => [k, v.label])];

export function loanChip(v: any) {
  if (!v.tempUntil || !v.tempFromBaseId) return '';
  return `<span class="badge ${v.tempUntil < todayStr() ? 'bad' : 'acc'}">On loan from ${esc(baseName(v.tempFromBaseId))} until ${fmtDate(v.tempUntil)}</span>`;
}
export const CLIP = icon('clip');
export const attChip = (d: any) => {
  const n = (d.attachments || []).length;
  return n ? ` <span class="badge acc">${CLIP}${n} ${n === 1 ? 'file' : 'files'}</span>` : '';
};
export const isImgAtt = (a: any) => /^image\//.test(a.type || '') && safeAsset(a.assetId);
export const thumbStrip = (d: any) => {
  const im = (d.attachments || []).filter(isImgAtt).slice(0, 4);
  return im.length ? `<div class="thumbs">${im.map((a: any) => `<img class="thumb" src="${esc(fileUrl(a.assetId))}" alt="Photo: ${esc(a.name)}" width="48" height="48" loading="lazy">`).join('')}</div>` : '';
};
void D;

/** A button for a page's action row. Primary actions get an icon so they can stand alone as an icon button in the top bar on small screens. */
export const actBtn = (label: string, o: { id?: string; act: string; data?: Record<string, string>; primary?: boolean; icon?: string; cls?: string; disabled?: boolean }) =>
  `<button type="button" class="btn${o.primary ? ' primary' : ''}${o.cls ? ' ' + o.cls : ''}" data-act="${o.act}"${o.id ? ` id="${o.id}"` : ''}${Object.entries(o.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')} aria-label="${esc(label)}"${o.disabled ? ' disabled' : ''}>${o.icon ? icon(o.icon) : ''}<span class="lbl">${esc(label)}</span></button>`;

/** The title row at the top of a page. `acts` goes in a .pactions row that the frame moves to the top bar (see layout.ts). */
export const pageHead = (title: string, o: { sub?: string; acts?: string; pt?: boolean; extra?: string } = {}) =>
  `<div class="vhead"><div class="vt"><div class="row tight"><h1${o.pt === false ? '' : ' class="pt"'}>${esc(title)}</h1>${o.extra || ''}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ''}</div>${o.acts ? `<div class="pactions row">${o.acts}</div>` : ''}</div>`;

export interface MenuItem { label: string; act: string; id?: string; data?: Record<string, string>; danger?: boolean; cls?: string; icon?: string }
/** A button that opens a small menu (arrow keys, Esc and outside clicks are handled in layout.ts). */
export const menuHtml = (key: string, label: string, items: MenuItem[], o: { cls?: string; labelSm?: string; up?: boolean; wrapCls?: string } = {}) => {
  if (!items.length) return '';
  return `<div class="menu${o.wrapCls ? ' ' + o.wrapCls : ''}"><button type="button" class="btn${o.cls ? ' ' + o.cls : ''}" id="${key}Btn" data-act="menu-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="${key}Pop">${icon('more')}<span class="lbl">${o.labelSm ? `<span class="hide-sm">${esc(label)}</span><span class="only-sm">${esc(o.labelSm)}</span>` : esc(label)}</span></button>
  <div class="menupop${o.up ? ' up' : ''}" id="${key}Pop" role="menu" hidden>${items.map((i) => `<button type="button" role="menuitem" class="${i.danger ? 'danger ' : ''}${i.cls || ''}" data-act="${i.act}"${i.id ? ` id="${i.id}"` : ''}${Object.entries(i.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}>${i.icon ? icon(i.icon) : ''}${esc(i.label)}</button>`).join('')}</div></div>`;
};
export const emptyState = (ic: string, title: string, help: string, action = '') => `<div class="empty">${icon(ic, 'big')}<h2>${esc(title)}</h2><p class="muted">${esc(help)}</p>${action}</div>`;
export const initials = (name: string) => (String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
/** The mark and name above the logged-out panels. */
export const brandHtml = (label = '') => `<div class="brandrow"><i class="mark" aria-hidden="true"></i>${label ? `<span>${esc(label)}</span>` : ''}</div>`;
