/**
 * Bus checks > Requirements: the lists a crew checks against. Who may change them is the "Edit bus check requirements" permission.
 * Editing a list never changes a check that was already sent (each check keeps its own copy of the list).
 */
import { KIND_LABEL, ITEM_KINDS, flatItems, normType, type ItemKind } from '../shared/buscheck';
import { D, LST, scheduleRender } from './state';
import { esc, num, toast, field, inp, selHtml } from './util';
import { emptyState, pill } from './bits';
import { icon } from './icons';
import { api, syncNow } from './api';
import { confirmUI } from './dom';

interface EItem { id: string | null; code: string; name: string; kind: ItemKind; min: string; unit: string; note: string }
interface ESec { id: string | null; title: string; items: EItem[] }
const ed = { open: false, id: null as string | null, name: '', types: '', active: true, sections: [] as ESec[], updatedAt: '', saving: false, err: '', dirty: false };
const lists = () => (LST.busCheckLists || []).slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

export function resetRequirements() { ed.open = false; ed.id = null; ed.err = ''; ed.saving = false; ed.dirty = false; ed.sections = []; }

const blankItem = (): EItem => ({ id: null, code: '', name: '', kind: 'check', min: '', unit: '', note: '' });
const fromList = (l: any): ESec[] => (l.sections || []).map((s: any) => ({ id: s.id, title: s.title, items: (s.items || []).map((i: any) => ({ id: i.id, code: i.code || '', name: i.name, kind: i.kind, min: i.min == null ? '' : String(i.min), unit: i.unit || '', note: i.note || '' })) }));

/* ---------- the list of lists ---------- */
function coverage(): string {
  const act = lists().filter((l: any) => l.active);
  const hasDefault = act.some((l: any) => !(l.unitTypes || []).length);
  if (hasDefault || !act.length) return '';
  const covered = new Set(act.flatMap((l: any) => (l.unitTypes || []).map(normType)));
  const missing = [...new Set(LST.vehicles.filter((v: any) => v.status !== 'decommissioned').map((v: any) => String(v.type || '').trim()))].filter((t) => !covered.has(normType(t)));
  return missing.length ? `<div class="warnbox" role="status" id="reqGap">No active list covers ${missing.map((t) => `<b>${esc(t || '(no type)')}</b>`).join(', ')}. Units of ${missing.length === 1 ? 'that type' : 'those types'} cannot be checked until a list covers ${missing.length === 1 ? 'it' : 'them'} or one list is made the default (no unit types).</div>` : '';
}
function listCard(l: any) {
  const items = flatItems(l.sections || []).length, types: string[] = l.unitTypes || [];
  return `<div class="panel reqcard" id="rl-${esc(l.id)}"><div class="ph"><h2>${esc(l.name)}</h2><div class="row tight">${l.active ? pill('ok', 'Active') : pill('off', 'Inactive')}</div></div>
    <div class="pb"><p class="small" style="margin:0 0 4px">${types.length ? 'For: ' + types.map((t) => `<span class="badge acc">${esc(t)}</span>`).join(' ') : '<span class="badge">Default</span> any unit whose type no other list covers'}</p>
    <p class="small muted" style="margin:0 0 12px">${items} ${items === 1 ? 'item' : 'items'} in ${(l.sections || []).length} ${(l.sections || []).length === 1 ? 'section' : 'sections'}</p>
    <div class="row"><button type="button" class="btn sm" data-act="req-edit" data-id="${esc(l.id)}" id="re-${esc(l.id)}">${icon('edit')}Edit</button>
    <button type="button" class="btn sm" data-act="req-dup" data-id="${esc(l.id)}" id="rd-${esc(l.id)}">Duplicate</button>
    <button type="button" class="btn sm" data-act="req-toggle" data-id="${esc(l.id)}" id="rt-${esc(l.id)}">${l.active ? 'Make inactive' : 'Make active'}</button></div></div></div>`;
}
function listsView() {
  const ls = lists();
  if (!ls.length) return `<div class="panel" id="reqEmpty">${emptyState('inbox', 'No bus check list yet', 'Start from the standard ambulance list (about 80 items in 8 sections) and change it to suit your units, or build your own.',
    `<div class="row" style="justify-content:center"><button type="button" class="btn primary" data-act="req-std" id="reqStd">Start from the standard list</button><button type="button" class="btn" data-act="req-new" id="reqNew">Create a blank list</button></div>`)}</div>`;
  return `<div class="row" style="margin:0 0 12px;justify-content:space-between"><p class="small muted" style="margin:0;flex:1 1 280px">A unit is checked against the active list that names its type. A list with no unit types is used for every other unit. Changing a list does not change checks already sent.</p>
    <button type="button" class="btn primary" data-act="req-new" id="reqNew">${icon('plus')}New list</button></div>${coverage()}${ls.map(listCard).join('')}`;
}

/* ---------- the editor ---------- */
const typeOptions = () => [...new Set(LST.vehicles.map((v: any) => String(v.type || '').trim()).filter(Boolean))].sort();
function itemRow(it: EItem, si: number, ii: number, last: number) {
  const p = `bre-s${si}-i${ii}`, num2 = it.kind === 'count' || it.kind === 'number';
  const d = `data-s="${si}" data-i="${ii}"`;
  return `<li class="reitem" id="${p}"><div class="reg">
    <label class="f re-code"><span class="l">Code</span><input id="${p}-code" name="${p}-code" type="text" maxlength="20" value="${esc(it.code)}" data-re="code" ${d}></label>
    <label class="f re-name"><span class="l">Item</span><input id="${p}-name" name="${p}-name" type="text" maxlength="160" value="${esc(it.name)}" data-re="name" ${d} required></label>
    <label class="f re-kind"><span class="l">Kind</span>${selHtml(`${p}-kind`, ITEM_KINDS.map((k) => [k, KIND_LABEL[k]]), it.kind, `data-re="kind" ${d}`)}</label>
    ${num2 ? `<label class="f re-min"><span class="l">${it.kind === 'count' ? 'Minimum quantity' : 'Minimum reading'}</span><input id="${p}-min" name="${p}-min" type="number" min="${it.kind === 'count' ? 1 : 0}" step="${it.kind === 'count' ? 1 : 'any'}" value="${esc(it.min)}" data-re="min" ${d}></label>
    <label class="f re-unit"><span class="l">Unit (optional)</span><input id="${p}-unit" name="${p}-unit" type="text" maxlength="20" value="${esc(it.unit)}" data-re="unit" ${d} placeholder="${it.kind === 'count' ? 'pairs' : 'psi'}"></label>` : ''}
    <label class="f re-note"><span class="l">Note shown to the crew (optional)</span><input id="${p}-note" name="${p}-note" type="text" maxlength="160" value="${esc(it.note)}" data-re="note" ${d}></label></div>
    <div class="reops"><button type="button" class="btn sm ghost" data-act="req-mv-item" data-s="${si}" data-i="${ii}" data-d="-1" id="${p}-up" aria-label="Move item up"${ii === 0 ? ' disabled' : ''}>${icon('up')}</button>
    <button type="button" class="btn sm ghost" data-act="req-mv-item" data-s="${si}" data-i="${ii}" data-d="1" id="${p}-down" aria-label="Move item down"${ii === last ? ' disabled' : ''}>${icon('down')}</button>
    <button type="button" class="btn sm ghost" data-act="req-del-item" data-s="${si}" data-i="${ii}" id="${p}-del" aria-label="Remove item">${icon('trash')}</button></div></li>`;
}
function editorView() {
  const n = ed.sections.reduce((a, s) => a + s.items.length, 0);
  return `<form id="reqForm" novalidate onsubmit="return false"><div class="row" style="margin:0 0 12px"><button type="button" class="crumb" data-act="req-cancel" id="reqBack">Back to the lists</button><h2 style="margin:0">${ed.id ? 'Edit list' : 'New list'}</h2></div>
    <div class="panel"><div class="pb"><div class="fgrid">${field('List name', inp('re-name', ed.name, 'text', 'maxlength="80" required data-re="lname"'))}
    ${field('Unit types', inp('re-types', ed.types, 'text', 'maxlength="300" list="re-typelist" data-re="ltypes" placeholder="Leave empty for the default list"'), 'Separate with commas. The list is used for units of these types. Leave empty to use it for every unit no other list covers.')}
    <datalist id="re-typelist">${typeOptions().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
    <label class="chk"><input type="checkbox" id="re-active" name="re-active" data-re="lactive"${ed.active ? ' checked' : ''}><span>Active (crews use it)</span></label></div></div>
    ${ed.sections.map((s, si) => `<section class="panel resec" id="bres-${si}"><div class="ph"><div class="f re-title" style="flex:1 1 220px;margin:0"><label class="sr" for="bres-${si}-title">Section title</label><input id="bres-${si}-title" name="bres-${si}-title" type="text" maxlength="120" value="${esc(s.title)}" data-re="stitle" data-s="${si}" placeholder="Section title" required></div>
      <div class="reops"><button type="button" class="btn sm ghost" data-act="req-mv-sec" data-s="${si}" data-d="-1" id="bres-${si}-up" aria-label="Move section up"${si === 0 ? ' disabled' : ''}>${icon('up')}</button>
      <button type="button" class="btn sm ghost" data-act="req-mv-sec" data-s="${si}" data-d="1" id="bres-${si}-down" aria-label="Move section down"${si === ed.sections.length - 1 ? ' disabled' : ''}>${icon('down')}</button>
      <button type="button" class="btn sm ghost" data-act="req-del-sec" data-s="${si}" id="bres-${si}-del" aria-label="Remove section">${icon('trash')}</button></div></div>
      <ul class="relist">${s.items.map((it, ii) => itemRow(it, si, ii, s.items.length - 1)).join('')}</ul>
      <div class="pb"><button type="button" class="btn sm" data-act="req-add-item" data-s="${si}" id="bres-${si}-add">${icon('plus')}Add item</button></div></section>`).join('')}
    <div class="row" style="margin:0 0 16px"><button type="button" class="btn" data-act="req-add-sec" id="reqAddSec">${icon('plus')}Add section</button><span class="muted small">${n} ${n === 1 ? 'item' : 'items'}</span></div>
    ${ed.err ? `<div class="warnbox bad" role="alert" id="reqErr">${esc(ed.err)}</div>` : ''}
    <div class="row"><button type="button" class="btn primary" data-act="req-save" id="reqSave"${ed.saving ? ' disabled' : ''}>${ed.saving ? 'Saving...' : 'Save list'}</button><button type="button" class="btn" data-act="req-cancel" id="reqCancel">Cancel</button></div></form>`;
}
export function reqTab() { return ed.open ? editorView() : listsView(); }

/* ---------- actions ---------- */
const swap = <T,>(a: T[], i: number, d: number) => { const j = i + d; if (j < 0 || j >= a.length) return false; [a[i], a[j]] = [a[j], a[i]]; return true; };
const focusLater = (id: string) => setTimeout(() => { const e = document.getElementById(id); if (e) { (e as HTMLElement).focus(); } }, 60);
function startEdit(l: any | null) {
  ed.open = true; ed.id = l?.id ?? null; ed.name = l?.name ?? ''; ed.types = (l?.unitTypes || []).join(', '); ed.active = l ? !!l.active : true; ed.updatedAt = l?.updatedAt ?? '';
  ed.sections = l ? fromList(l) : [{ id: null, title: '', items: [blankItem()] }]; ed.err = ''; ed.saving = false; ed.dirty = false;
  scheduleRender();
  setTimeout(() => window.scrollTo(0, 0), 20);
}
function body() {
  return {
    name: ed.name.trim(), unitTypes: ed.types.split(',').map((t) => t.trim()).filter(Boolean), active: ed.active, updatedAt: ed.updatedAt || null,
    sections: ed.sections.map((s) => ({ id: s.id, title: s.title.trim(), items: s.items.map((i) => ({
      id: i.id, code: i.code.trim(), name: i.name.trim(), kind: i.kind, min: (i.kind === 'count' || i.kind === 'number') && i.min.trim() !== '' ? Number(i.min) : null, unit: i.kind === 'count' || i.kind === 'number' ? i.unit.trim() : '', note: i.note.trim(),
    })) })),
  };
}
async function call(fn: () => Promise<any>, ok: string) {
  try { await fn(); await syncNow(); toast(ok); return true; } catch (e: any) { toast(e?.message || 'Could not save that. Please try again.', true); if (!(e && e.user)) console.error(e); return false; }
}

export const requirementsActs: Record<string, any> = {
  'req-std': async () => { await call(() => api('POST', '/bus-check-lists/standard'), 'Standard list added'); scheduleRender(); },
  'req-new': () => startEdit(null),
  'req-edit': (el: HTMLElement) => { const l = D.busCheckLists[el.dataset.id!]; if (l) startEdit(l); },
  'req-dup': async (el: HTMLElement) => { await call(() => api('POST', `/bus-check-lists/${encodeURIComponent(el.dataset.id!)}/duplicate`), 'Copy made. It is inactive until you give it unit types and make it active.'); scheduleRender(); },
  'req-toggle': async (el: HTMLElement) => {
    const l = D.busCheckLists[el.dataset.id!];
    if (!l) return;
    if (l.active && !(await confirmUI({ title: `Make "${l.name}" inactive?`, message: 'Units that use this list cannot be checked until another list covers them.', label: 'Make inactive', danger: true }))) return;
    await call(() => api('PUT', `/bus-check-lists/${encodeURIComponent(l.id)}`, { name: l.name, unitTypes: l.unitTypes, active: !l.active, sections: l.sections, updatedAt: l.updatedAt }), l.active ? 'List made inactive' : 'List made active');
    scheduleRender();
  },
  'req-cancel': async () => {
    if (ed.dirty && !(await confirmUI({ title: 'Leave without saving?', message: 'Your changes to this list will be lost.', label: 'Leave', danger: true }))) return;
    ed.open = false; scheduleRender();
  },
  'req-add-sec': () => { ed.sections.push({ id: null, title: '', items: [blankItem()] }); ed.dirty = true; scheduleRender(); focusLater(`bres-${ed.sections.length - 1}-title`); },
  'req-del-sec': async (el: HTMLElement) => {
    const i = Number(el.dataset.s), s = ed.sections[i];
    if (!s) return;
    if (s.items.length && !(await confirmUI({ title: `Remove the section "${s.title || 'untitled'}"?`, message: `Its ${s.items.length} ${s.items.length === 1 ? 'item is' : 'items are'} removed from this list when you save.`, label: 'Remove section', danger: true }))) return;
    ed.sections.splice(i, 1); ed.dirty = true; scheduleRender();
  },
  'req-mv-sec': (el: HTMLElement) => { const i = Number(el.dataset.s), d = Number(el.dataset.d); if (swap(ed.sections, i, d)) { ed.dirty = true; scheduleRender(); focusLater(`bres-${i + d}-${d < 0 ? 'up' : 'down'}`); } },
  'req-add-item': (el: HTMLElement) => { const s = ed.sections[Number(el.dataset.s)]; if (!s) return; s.items.push(blankItem()); ed.dirty = true; scheduleRender(); focusLater(`bre-s${el.dataset.s}-i${s.items.length - 1}-name`); },
  'req-del-item': (el: HTMLElement) => { const s = ed.sections[Number(el.dataset.s)]; if (!s) return; s.items.splice(Number(el.dataset.i), 1); ed.dirty = true; scheduleRender(); },
  'req-mv-item': (el: HTMLElement) => { const si = Number(el.dataset.s), i = Number(el.dataset.i), d = Number(el.dataset.d); if (ed.sections[si] && swap(ed.sections[si].items, i, d)) { ed.dirty = true; scheduleRender(); focusLater(`bre-s${si}-i${i + d}-${d < 0 ? 'up' : 'down'}`); } },
  'req-save': async () => {
    if (ed.saving) return;
    const b = body();
    const fail = (m: string, id?: string) => { ed.err = m; scheduleRender(); if (id) focusLater(id); };
    if (!b.name) return fail('Give the list a name.', 're-name');
    if (!b.sections.length) return fail('Add at least one section.');
    for (let si = 0; si < b.sections.length; si++) {
      const s = b.sections[si];
      if (!s.title) return fail('Every section needs a title.', `bres-${si}-title`);
      for (let ii = 0; ii < s.items.length; ii++) {
        const it = s.items[ii], p = `bre-s${si}-i${ii}`;
        if (!it.name) return fail('Every item needs a name.', `${p}-name`);
        if (it.kind === 'count' && (it.min == null || !Number.isInteger(it.min) || it.min < 1)) return fail(`"${it.name}" needs a minimum quantity of 1 or more (a whole number).`, `${p}-min`);
        if (it.kind === 'number' && it.min == null) return fail(`"${it.name}" needs a minimum reading.`, `${p}-min`);
      }
    }
    if (!b.sections.some((s) => s.items.length)) return fail('Add at least one item.');
    ed.err = ''; ed.saving = true; scheduleRender();
    try {
      if (ed.id) await api('PUT', `/bus-check-lists/${encodeURIComponent(ed.id)}`, b); else await api('POST', '/bus-check-lists', b);
      await syncNow();
      toast('List saved');
      ed.open = false; ed.dirty = false;
    } catch (e: any) { ed.err = e?.message || 'Could not save the list. Please try again.'; if (!(e && e.user)) console.error(e); }
    ed.saving = false; scheduleRender();
    if (ed.err) focusLater('reqErr');
  },
};

/* ---------- typing (no redraw, so the cursor stays put) ---------- */
document.addEventListener('input', (e: any) => {
  const el = e.target, k = el?.dataset?.re;
  if (!k || !ed.open || !el.closest('#view')) return;
  const s = ed.sections[Number(el.dataset.s)], it = s?.items[Number(el.dataset.i)];
  switch (k) {
    case 'lname': ed.name = el.value; break;
    case 'ltypes': ed.types = el.value; break;
    case 'stitle': if (s) s.title = el.value; break;
    case 'code': case 'name': case 'min': case 'unit': case 'note': if (it) (it as any)[k] = el.value; break;
    default: return;
  }
  ed.dirty = true;
});
document.addEventListener('change', (e: any) => {
  const el = e.target, k = el?.dataset?.re;
  if (!k || !ed.open || !el.closest('#view')) return;
  if (k === 'lactive') { ed.active = el.checked; ed.dirty = true; }
  if (k === 'kind') { const it = ed.sections[Number(el.dataset.s)]?.items[Number(el.dataset.i)]; if (it) { it.kind = el.value; if (it.kind === 'count' && !it.min) it.min = '1'; ed.dirty = true; scheduleRender(); } }
});
void num;
