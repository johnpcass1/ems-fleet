/**
 * Bus check (Operations): the start-of-shift inspection a crew does on their phone.
 * One page: unit and station, crew, mileage and hours, every item grouped by section, problems the crew want to report, the confirmation tick, Send.
 * Everything typed is kept in `st` (the page is redrawn whenever data syncs, so the form must not live in the page itself), and a copy of the unsent
 * check is kept in this browser only, per unit, so a lost signal or a closed tab does not lose the work.
 */
import { SEV } from '../shared/constants';
import { ATTESTATION, checkAnswers, allOkFill, answerError, flatItems, isRequired, pickList, progress, shortageOf, type BusAnswer, type BusItem, type BusSection } from '../shared/buscheck';
import { checkReading } from '../shared/pure';
import { D, LST, S, can, scheduleRender, vehiclesSorted, basesSorted, baseName, readingsOf } from './state';
import { $, esc, num, toast, selHtml, field, inp, nv, todayStr, uerr } from './util';
import { VIEWS } from './registry';
import { pageHead, emptyState, pill } from './bits';
import { icon } from './icons';
import { api, syncNow } from './api';
import { confirmUI } from './dom';
import { go, allowedRoutes } from './nav';

interface Person { sel: string; name: string }
interface Problem { title: string; description: string; severity: string }
const OTHER = '__other';
const DRAFT_TTL = 24 * 3600e3;

const blankPerson = (): Person => ({ sel: '', name: '' });
const st = {
  owner: '', // agency + person this state belongs to
  vehicleId: '', baseId: '', emt1: blankPerson(), emt2: blankPerson(), driver: blankPerson(), km: '', hours: '',
  answers: {} as Record<string, BusAnswer>, problems: [] as Problem[], attested: false,
  closed: new Set<string>(), // sections the person collapsed
  ref: '', sending: false, done: null as any, err: '', restored: false, picked: false,
  showMissing: false, // after a Send with unanswered items: mark every one of them in red
};
const newRef = () => { try { return crypto.randomUUID(); } catch { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } };

/** Forget everything (sign-out, another agency). */
export function resetBusCheck() {
  st.owner = ''; st.vehicleId = ''; st.baseId = ''; st.emt1 = blankPerson(); st.emt2 = blankPerson(); st.driver = blankPerson(); st.km = ''; st.hours = '';
  st.answers = {}; st.problems = []; st.attested = false; st.closed = new Set(); st.ref = ''; st.sending = false; st.done = null; st.err = ''; st.restored = false; st.picked = false; st.showMissing = false;
}

/* ---------- the unsent draft (this browser only) ---------- */
const draftKey = (vid: string) => `gema-buscheck-draft:${S.me?.agency?.id ?? ''}:${S.me?.id ?? ''}:${vid}`;
function saveDraft() {
  if (!st.vehicleId || st.done) return;
  try {
    localStorage.setItem(draftKey(st.vehicleId), JSON.stringify({ at: Date.now(), ref: st.ref, baseId: st.baseId, emt1: st.emt1, emt2: st.emt2, driver: st.driver, km: st.km, hours: st.hours, answers: st.answers, problems: st.problems, attested: false }));
  } catch { /* storage may be blocked: the check still works, it just is not kept */ }
}
function clearDraft(vid: string) { try { localStorage.removeItem(draftKey(vid)); } catch { /* ignore */ } }
function readDraft(vid: string): any {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(vid)) || 'null');
    if (!d || typeof d !== 'object' || Date.now() - Number(d.at) > DRAFT_TTL) { if (d) clearDraft(vid); return null; }
    return d;
  } catch { return null; }
}
/** Put a unit's saved draft (if any) back on the page. */
function loadDraft(vid: string) {
  const d = readDraft(vid);
  st.restored = false;
  if (!d) return;
  st.ref = d.ref || st.ref;
  st.baseId = D.bases[d.baseId] ? d.baseId : st.baseId;
  for (const k of ['emt1', 'emt2', 'driver'] as const) if (d[k] && typeof d[k] === 'object') st[k] = { sel: String(d[k].sel || ''), name: String(d[k].name || '') };
  st.km = String(d.km ?? ''); st.hours = String(d.hours ?? '');
  st.answers = d.answers && typeof d.answers === 'object' ? d.answers : {};
  st.problems = Array.isArray(d.problems) ? d.problems.filter((p: any) => p && typeof p === 'object').map((p: any) => ({ title: String(p.title || ''), description: String(p.description || ''), severity: SEV[p.severity] ? p.severity : 'minor' })) : [];
  st.restored = Object.keys(st.answers).length > 0 || !!st.km || !!st.hours || st.problems.length > 0;
}

/* ---------- what applies ---------- */
export const checkableUnits = () => vehiclesSorted().filter((v: any) => v.status !== 'decommissioned' && can('busCheck', v));
const unit = () => D.vehicles[st.vehicleId];
const listFor = (v: any) => (v ? pickList(LST.busCheckLists, v.type) : null);
const secs = (l: any): BusSection[] => (l?.sections || []) as BusSection[];

function ensureOwner() {
  const o = `${S.me?.agency?.id}:${S.me?.id}`;
  if (st.owner !== o) { resetBusCheck(); st.owner = o; }
}
function pickUnit(vid: string) {
  st.vehicleId = vid; st.answers = {}; st.problems = []; st.attested = false; st.km = ''; st.hours = ''; st.err = '';
  st.emt1 = defaultEmt1(); st.emt2 = blankPerson(); st.driver = blankPerson(); st.closed = new Set(); st.ref = newRef(); st.restored = false;
  const v = D.vehicles[vid];
  st.baseId = v?.baseId && D.bases[v.baseId] ? v.baseId : '';
  if (vid) loadDraft(vid);
}
function defaultEmt1(): Person { return S.me && D.people[S.me.id] ? { sel: S.me.id, name: '' } : { sel: '', name: S.me?.name || '' }; }
/** The unit at the person's own base, when there is exactly one. */
function autoUnit(): string {
  const mine = S.me?.baseIds || [];
  if (!mine.length) return '';
  const c = checkableUnits().filter((v: any) => mine.includes(v.baseId));
  return c.length === 1 ? c[0].id : '';
}

/* ---------- drawing ---------- */
const people = () => Object.values(D.people).filter((p: any) => p.active !== false).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
function personField(key: 'emt1' | 'emt2' | 'driver', label: string, required: boolean) {
  const p = st[key];
  const opts: string[][] = [['', required ? 'Choose a person...' : 'No driver listed'], ...people().map((x: any) => [x.id, x.name]), [OTHER, 'Someone else (type a name)']];
  const typed = p.sel === OTHER || (!p.sel && p.name);
  return `<div class="bcperson">${field(label + (required ? '' : ' (optional)'), selHtml(`bc-${key}`, opts, typed ? OTHER : p.sel, `data-bc="${key}"`))}
    ${typed ? `<label class="f"><span class="l">${esc(label)} name</span><input id="bc-${key}-name" name="bc-${key}-name" type="text" value="${esc(p.name)}" maxlength="80" autocomplete="off" data-bc="${key}-name" placeholder="Full name"></label>` : ''}</div>`;
}
const answered = (it: BusItem, a?: BusAnswer) => !answerError(it, a) && !!a && (a.status != null || a.value != null || a.date != null);
function optBtns(it: BusItem, choices: [string, string, string][]) {
  const a = st.answers[it.id];
  return `<div class="bcopt" role="group" aria-label="${esc(it.name)}">${choices.map(([v, label, cls]) => `<button type="button" class="bcb ${cls}" data-act="bc-ans" data-item="${esc(it.id)}" data-v="${v}" id="bc-${esc(it.id)}-${v}" aria-pressed="${a?.status === v}">${label}</button>`).join('')}</div>`;
}
function itemControl(it: BusItem) {
  const a = st.answers[it.id] || {};
  const id = esc(it.id);
  switch (it.kind) {
    case 'count':
      return `${optBtns(it, [['ok', 'OK', 'ok'], ['short', 'Short', 'bad']])}${a.status === 'short' ? `<div class="bcmore">
        <label class="f"><span class="l">How many are there?</span><input id="bc-q-${id}" name="bc-q-${id}" type="number" inputmode="numeric" min="0" max="${Math.max(0, (it.min ?? 1) - 1)}" step="1" value="${esc(a.qty ?? '')}" data-bc="qty" data-item="${id}"><span class="hint">Needs ${num(it.min)}${it.unit ? ' ' + esc(it.unit) : ''}. Enter how many are there, or leave it blank if you are not sure.</span></label>
        <label class="f"><span class="l">Note (optional)</span><input id="bc-n-${id}" name="bc-n-${id}" type="text" maxlength="200" value="${esc(a.note ?? '')}" data-bc="note" data-item="${id}"></label></div>` : ''}`;
    case 'check':
      return `${optBtns(it, [['pass', 'Pass', 'ok'], ['fail', 'Fail', 'bad']])}${a.status === 'fail' ? `<div class="bcmore"><label class="f"><span class="l">What is wrong? (optional)</span><input id="bc-n-${id}" name="bc-n-${id}" type="text" maxlength="200" value="${esc(a.note ?? '')}" data-bc="note" data-item="${id}"></label></div>` : ''}`;
    case 'number':
      return `<div class="bcnum"><input id="bc-v-${id}" name="bc-v-${id}" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.value ?? '')}" data-bc="value" data-item="${id}" aria-label="${esc(it.name)}">${it.unit ? `<span class="muted small">${esc(it.unit)}</span>` : ''}<span class="muted small">minimum ${num(it.min)}</span></div>`;
    case 'date':
      return `<div class="bcnum"><input id="bc-d-${id}" name="bc-d-${id}" type="date" value="${esc(a.date ?? '')}" data-bc="date" data-item="${id}" aria-label="${esc(it.name)}"></div>`;
    default:
      return optBtns(it, [['present', 'Present', 'ok'], ['absent', 'Not there', 'off']]);
  }
}
function itemHtml(it: BusItem) {
  const a = st.answers[it.id];
  const ok = answered(it, a);
  const sh = ok ? shortageOf(it, a, todayStr()) : null;
  const err = a && !ok && (a.status != null || a.value != null || a.date != null) ? answerError(it, a) : null;
  const missing = st.showMissing && isRequired(it) && !ok && !err;
  const shNote = sh && (it.kind === 'number' || it.kind === 'date') ? (it.kind === 'number' ? `Below the minimum of ${num(it.min)}${it.unit ? ' ' + esc(it.unit) : ''}. This will be reported to maintenance.` : 'Expired. This will be reported to maintenance.') : '';
  return `<li class="bci${sh ? ' bad' : ''}${ok ? ' done' : ''}${missing ? ' missing' : ''}" id="bci-${esc(it.id)}">
    <div class="bcname">${it.code ? `<span class="bccode">${esc(it.code)}</span>` : ''}<span class="bctxt">${esc(it.name)}</span>${isRequired(it) ? '' : ' <span class="tiny muted">optional</span>'}
      ${it.kind === 'count' ? `<span class="tiny muted bcmin">Need ${num(it.min)}${it.unit ? ' ' + esc(it.unit) : ''}</span>` : ''}${it.note ? `<span class="tiny muted bcnote">${esc(it.note)}</span>` : ''}</div>
    <div class="bcctl">${itemControl(it)}</div>${err ? `<div class="tiny bcerr" role="alert">${esc(err)}</div>` : ''}${shNote ? `<div class="tiny bcerr">${shNote}</div>` : ''}${missing ? `<div class="tiny bcerr bcmiss">Not answered yet${it.kind === 'number' ? ': enter the reading' : it.kind === 'date' ? ': enter the date' : ''}.</div>` : ''}</li>`;
}
function sectionHtml(s: BusSection) {
  const p = progress([s], st.answers), open = !st.closed.has(s.id), all = p.total > 0 && p.done === p.total;
  return `<section class="panel bcsec" id="bcs-${esc(s.id)}"><div class="ph bcsh"><button type="button" class="bctoggle" data-act="bc-toggle" data-id="${esc(s.id)}" id="bct-${esc(s.id)}" aria-expanded="${open}" aria-controls="bcl-${esc(s.id)}">${icon(open ? 'down' : 'right')}<h2>${esc(s.title)}</h2></button>
    <span class="bccount${all ? ' ok' : st.showMissing ? ' bad' : ''}" id="bcp-${esc(s.id)}">${st.showMissing && !all ? `${p.total - p.done} not answered` : `${p.done} of ${p.total}`}</span>
    <button type="button" class="btn sm" data-act="bc-allok" data-id="${esc(s.id)}" id="bca-${esc(s.id)}">${icon('check')}All OK in this section</button></div>
    ${open ? `<ul class="bclist" id="bcl-${esc(s.id)}">${s.items.map(itemHtml).join('')}</ul>` : ''}</section>`;
}
function problemHtml(p: Problem, i: number) {
  return `<div class="bcprob" id="bcprob-${i}"><div class="row tight"><b>Problem ${i + 1}</b><button type="button" class="btn sm ghost" data-act="bc-del-problem" data-idx="${i}" id="bcpd-${i}">${icon('x')}Remove</button></div>
    ${field('What is wrong?', `<input id="bc-pt-${i}" name="bc-pt-${i}" type="text" maxlength="120" value="${esc(p.title)}" data-bc="ptitle" data-idx="${i}" placeholder="Short summary">`)}
    ${field('How serious is it?', selHtml(`bc-ps-${i}`, Object.entries(SEV), p.severity, `data-bc="psev" data-idx="${i}"`), 'Critical takes the unit out of service straight away.')}
    ${field('Details (optional)', `<textarea id="bc-pd-${i}" name="bc-pd-${i}" rows="2" maxlength="4000" data-bc="pdesc" data-idx="${i}">${esc(p.description)}</textarea>`)}</div>`;
}
function summary() {
  const v = unit(), l = listFor(v), sc = secs(l);
  if (!v || !l) return { total: 0, done: 0, shortages: 0 };
  const p = progress(sc, st.answers);
  return { ...p, shortages: checkAnswers(sc, st.answers, todayStr()).shortages.length };
}
function doneHtml() {
  const r = st.done, v = D.vehicles[r.vehicleId];
  const bits = [
    r.shortages ? `${r.shortages} ${r.shortages === 1 ? 'shortage' : 'shortages'} found` : 'No shortages found',
    r.newProblems ? `${r.newProblems} new ${r.newProblems === 1 ? 'problem' : 'problems'} sent to maintenance` : '',
    r.joined ? `${r.joined} added to ${r.joined === 1 ? 'a problem that was' : 'problems that were'} already open` : '',
    r.reported ? `${r.reported} ${r.reported === 1 ? 'problem' : 'problems'} you reported` : '',
  ].filter(Boolean);
  return `${pageHead('Bus check')}<div class="panel" id="bcDone"><div class="pb bcdone">${icon('check', 'big')}<h2>Bus check sent${v ? ' for ' + esc(v.unit) : ''}</h2>
    <p>${esc(bits.join('. '))}.</p>
    ${r.flagged ? `<div class="warnbox bad" role="status">The meter reading looked wrong, so it was saved as flagged for a supervisor. The unit's hours were not changed. ${esc((r.warnings || []).join(' '))}</div>` : ''}
    <div class="row"><button type="button" class="btn primary" data-act="bc-again" id="bcAgain">Check another unit</button>${allowedRoutes().includes('issues') ? '<button type="button" class="btn" data-act="bc-to-issues" id="bcToIssues">See the problems</button>' : ''}</div></div></div>`;
}

VIEWS.buscheck = function () {
  ensureOwner();
  if (!can('busCheck')) return '<div class="warnbox bad">You do not have access to this page.</div>';
  if (st.done) return doneHtml();
  const units = checkableUnits();
  if (!st.vehicleId && !st.picked) { st.picked = true; const a = autoUnit(); if (a) pickUnit(a); }
  if (st.vehicleId && !units.some((u: any) => u.id === st.vehicleId)) pickUnit('');
  const v = unit(), l = listFor(v), sc = secs(l);
  const head = pageHead('Bus check', { sub: 'Start-of-shift check of the unit, its crew and its equipment. Check every item.' });
  if (!units.length) return `${head}<div class="panel">${emptyState('vehicles', 'No units to check', 'You can check units at your own bases. If this looks wrong, ask a fleet manager.')}</div>`;
  const hint = (v: any) => { return `Current: ${num(v.engineHours)} h, ${num(v.odometerKm)} km`; };
  const unitPanel = `<div class="panel"><div class="ph"><h2>Unit</h2></div><div class="pb">
    <div class="fgrid">${field('Unit', selHtml('bc-unit', [['', 'Choose a unit...'], ...units.map((u: any) => [u.id, `${u.unit} (${baseName(u.baseId)})`])], st.vehicleId, 'data-bc="unit"'))}
    ${field('Station', selHtml('bc-base', [['', 'Choose a station...'], ...basesSorted().map((b: any) => [b.id, b.name])], st.baseId, 'data-bc="base"'), 'Where the unit is posted for this shift.')}</div>
    ${v ? (l ? `<p class="small muted" id="bcList">List: <b>${esc(l.name)}</b>, ${flatItems(sc).length} items.</p>` : `<div class="warnbox bad" role="alert" id="bcNoList">No bus check list covers this unit${v.type ? ' (type: ' + esc(v.type) + ')' : ''}. A fleet manager needs to set one up first (Admin, Bus checks, Requirements).</div>`) : ''}
    ${st.restored ? `<div class="warnbox info" role="status" id="bcRestored">Your unsent check for this unit was put back. <button type="button" class="btn sm" data-act="bc-discard" id="bcDiscard">Start again</button></div>` : ''}</div></div>`;
  if (!v || !l) return `${head}${unitPanel}${v ? '' : '<p class="muted small">Choose the unit you are checking to begin.</p>'}`;
  const p = summary();
  const crewPanel = `<div class="panel"><div class="ph"><h2>Crew</h2></div><div class="pb"><div class="fgrid">${personField('emt1', 'EMT 1', true)}${personField('emt2', 'EMT 2', true)}${personField('driver', 'Driver', false)}</div></div></div>`;
  const readPanel = `<div class="panel"><div class="ph"><h2>Meter readings</h2><span class="muted small">${esc(hint(v))}</span></div><div class="pb"><div class="fgrid">
    ${field('Mileage (km)', inp('bc-km', st.km, 'number', 'min="0" step="1" required inputmode="numeric" data-bc="km"'))}${field('Engine hours', inp('bc-hours', st.hours, 'number', 'min="0" step="1" required inputmode="numeric" data-bc="hours"'))}</div></div></div>`;
  const bar = `<div class="bcbar" id="bcBar" role="status" aria-live="polite"><b id="bcProg">${p.done} of ${p.total} answered</b><span id="bcShort" class="${p.shortages ? 'bad' : 'muted'}">${p.shortages} ${p.shortages === 1 ? 'shortage' : 'shortages'}</span></div>`;
  const probs = `<div class="panel"><div class="ph"><h2>Problems to report</h2><button type="button" class="btn sm" data-act="bc-add-problem" id="bcAddProblem">${icon('plus')}Report a problem</button></div>
    <div class="pb">${st.problems.length ? st.problems.map(problemHtml).join('') : '<p class="muted small" style="margin:0">Anything else wrong with the unit that is not on the list. Shortages below are sent to maintenance automatically, so you do not need to report those here.</p>'}</div></div>`;
  const send = `<div class="panel"><div class="pb">
    <label class="chk bcattest"><input type="checkbox" id="bc-attest" name="bc-attest" data-bc="attest"${st.attested ? ' checked' : ''}><span>${esc(ATTESTATION)}</span></label>
    ${st.err ? `<div class="warnbox bad" role="alert" id="bcErr">${esc(st.err)}</div>` : ''}
    <div class="row"><button type="button" class="btn primary" data-act="bc-submit" id="bcSubmit"${st.sending ? ' disabled' : ''}>${st.sending ? 'Sending...' : 'Submit bus check'}</button></div></div></div>`;
  return `${head}${unitPanel}${crewPanel}${readPanel}${bar}${sc.map(sectionHtml).join('')}${probs}${send}`;
};

/* ---------- actions ---------- */
const sectionOf = (id: string) => secs(listFor(unit())).find((s) => s.id === id);
const itemOf = (id: string) => flatItems(secs(listFor(unit()))).find((i) => i.id === id);
const keep = () => { saveDraft(); };
/** Update the counters without redrawing the page (so typing is never interrupted). */
/** Redraw one item in place (after its reading, date or count changes). Only that item is replaced, so the box the person moved on to
 *  keeps focus and the phone keyboard stays open; a whole-page redraw here would replace the box they just tapped. */
function patchItem(id: string) {
  const it = itemOf(id), li = document.getElementById('bci-' + id);
  if (it && li) {
    const ae = document.activeElement as HTMLElement | null, aid = ae && li.contains(ae) ? ae.id : '';
    li.outerHTML = itemHtml(it);
    if (aid) (document.getElementById(aid) as HTMLElement | null)?.focus(); // e.g. moved from "How many" to "Note" in the same item
  }
  refreshBar();
}
function refreshBar() {
  const v = unit(), l = listFor(v);
  if (!v || !l) return;
  const p = summary();
  const a = $('#bcProg'), b = $('#bcShort');
  if (a) a.textContent = `${p.done} of ${p.total} answered`;
  if (b) { b.textContent = `${p.shortages} ${p.shortages === 1 ? 'shortage' : 'shortages'}`; b.className = p.shortages ? 'bad' : 'muted'; }
  for (const s of secs(l)) {
    const q = progress([s], st.answers), el = $('#bcp-' + CSS.escape(s.id));
    if (el) { const all = q.total > 0 && q.done === q.total; el.textContent = st.showMissing && !all ? `${q.total - q.done} not answered` : `${q.done} of ${q.total}`; el.classList.toggle('ok', all); el.classList.toggle('bad', st.showMissing && !all); }
  }
}

export const busCheckActs: Record<string, any> = {
  'bc-ans': (el: HTMLElement) => {
    const it = itemOf(el.dataset.item!);
    if (!it) return;
    const v = el.dataset.v!, cur = st.answers[it.id];
    // pressing the chosen button again takes the answer back
    if (cur?.status === v) delete st.answers[it.id]; else st.answers[it.id] = { ...(v === 'short' || v === 'fail' ? { note: cur?.note } : {}), status: v as any, ...(v === 'short' ? { qty: cur?.qty } : {}) };
    keep(); scheduleRender();
  },
  'bc-toggle': (el: HTMLElement) => { const id = el.dataset.id!; if (st.closed.has(id)) st.closed.delete(id); else st.closed.add(id); scheduleRender(); },
  'bc-allok': (el: HTMLElement) => {
    const s = sectionOf(el.dataset.id!);
    if (!s) return;
    const fill = allOkFill(s, st.answers);
    st.answers = { ...st.answers, ...fill };
    const left = s.items.filter((it) => isRequired(it) && !answered(it, st.answers[it.id])).length;
    toast(left ? `Section marked OK. ${left} ${left === 1 ? 'item still needs' : 'items still need'} a reading or a date.` : 'Section marked OK', false, 'bc-allok');
    keep(); scheduleRender();
  },
  'bc-add-problem': () => { st.problems.push({ title: '', description: '', severity: 'minor' }); keep(); scheduleRender(); setTimeout(() => { const e = document.getElementById(`bc-pt-${st.problems.length - 1}`); if (e) e.focus(); }, 60); },
  'bc-del-problem': (el: HTMLElement) => { st.problems.splice(Number(el.dataset.idx), 1); keep(); scheduleRender(); },
  'bc-discard': async () => {
    if (!(await confirmUI({ title: 'Start this check again?', message: 'Everything you entered for this unit is cleared.', label: 'Start again', danger: true }))) return;
    clearDraft(st.vehicleId); pickUnit(st.vehicleId); st.restored = false; scheduleRender();
  },
  'bc-again': () => { resetBusCheck(); ensureOwner(); st.picked = true; scheduleRender(); },
  'bc-to-issues': () => go('issues'),
  'bc-submit': () => submit(),
};

async function submit() {
  if (st.sending) return;
  const v = unit(), l = listFor(v);
  const fail = (m: string, focusId?: string) => { st.err = m; scheduleRender(); if (focusId) setTimeout(() => { const e = document.getElementById(focusId); if (e) { e.scrollIntoView({ block: 'center' }); e.focus(); } }, 80); return; };
  if (!v || !l) return fail('Choose a unit with a bus check list first.');
  st.err = '';
  if (!st.baseId) return fail('Choose the station.', 'bc-base');
  const crew: any = {};
  for (const [k, label, req] of [['emt1', 'EMT 1', true], ['emt2', 'EMT 2', true], ['driver', 'the driver', false]] as const) {
    const p = st[k];
    if (p.sel && p.sel !== OTHER) crew[k] = { userId: p.sel, name: D.people[p.sel]?.name || '' };
    else if (p.name.trim()) crew[k] = { name: p.name.trim() };
    else if (req) return fail(`Say who ${label} is.`, `bc-${k}`);
  }
  if (crew.emt1.userId && crew.emt1.userId === crew.emt2.userId) return fail('EMT 1 and EMT 2 must be two different people.', 'bc-emt2');
  const km = nv(st.km), hours = nv(st.hours);
  if (km == null || km < 0) return fail('Enter the mileage shown on the unit (km).', 'bc-km');
  if (hours == null || hours < 0) return fail('Enter the engine hours shown on the meter.', 'bc-hours');
  const sc = secs(l), rep = checkAnswers(sc, st.answers, todayStr());
  const bad = rep.errors[0];
  if (bad) { const sec = sc.find((s) => s.items.some((i) => i.id === bad.itemId)); if (sec) st.closed.delete(sec.id); return fail(`${bad.name}: ${bad.error}`, 'bci-' + bad.itemId); }
  if (rep.unanswered.length) {
    // mark every missing item in red and open every section that has one
    st.showMissing = true;
    for (const s of sc) if (s.items.some((i) => rep.unanswered.includes(i.id))) st.closed.delete(s.id);
    const names = rep.unanswered.map((id) => itemOf(id)?.name || '').filter(Boolean);
    const shown = names.slice(0, 3).map((n) => `"${n}"`).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    return fail(`${rep.unanswered.length} ${rep.unanswered.length === 1 ? 'item is' : 'items are'} not answered yet (marked in red): ${shown}.`, 'bci-' + rep.unanswered[0]);
  }
  st.showMissing = false;
  for (let i = 0; i < st.problems.length; i++) if (!st.problems[i].title.trim()) return fail('Say what is wrong with problem ' + (i + 1) + '.', `bc-pt-${i}`);
  if (!st.attested) return fail('Tick the box to confirm the check.', 'bc-attest');
  // a reading that looks wrong: the same test as Log engine hours
  const rs = readingsOf(v.id).filter((r: any) => !r.flagged), warn = checkReading(v.engineHours || 0, rs[rs.length - 1], hours, Date.now(), v.odometerKm, km);
  // Shortages never stop a check being sent; the crew sees every issue by name before sending.
  const issues = [...rep.shortages.map((s) => s.title.replace(/^Bus check: /, '')), ...st.problems.map((p) => `Problem reported: ${p.title.trim()}`)];
  const n = issues.length;
  const message = n ? `This check has ${n} ${n === 1 ? 'issue' : 'issues'}. ${n === 1 ? 'It' : 'Each one'} will be sent to maintenance as a problem (an open problem for the same item is added to instead):` : 'Everything was checked and nothing is short.';
  scheduleRender(); // clear an earlier error box before the dialog opens
  const after = `A sent check cannot be changed.${warn.length ? ' Check the reading: ' + warn.join(' ') + ' It will be saved flagged for a supervisor and the unit\'s hours will not change.' : ''}`;
  if (!(await confirmUI({ title: n ? `${v.unit}: ${n} ${n === 1 ? 'issue' : 'issues'} found` : `Send the bus check for ${v.unit}?`, message, list: issues, after, label: n ? `Send with ${n} ${n === 1 ? 'issue' : 'issues'}` : 'Send bus check' }))) return;
  st.sending = true; scheduleRender();
  try {
    const r = await api('POST', '/bus-checks', {
      vehicleId: v.id, listId: l.id, baseId: st.baseId, clientRef: st.ref, crew, km, hours, answers: st.answers,
      problems: st.problems.map((p) => ({ title: p.title.trim(), description: p.description.trim(), severity: p.severity })), attested: true,
    });
    clearDraft(v.id);
    st.done = { ...r, vehicleId: v.id };
    toast('Bus check sent');
    await syncNow();
  } catch (e: any) {
    if (e?.code === 'stale_list') { st.err = e.message; await syncNow(); }
    else st.err = e?.user ? e.message : 'Could not send the check. Check your connection and try again. Your answers are kept.';
    if (!(e && e.user)) console.error(e);
  }
  st.sending = false; scheduleRender();
  if (st.err) setTimeout(() => { const e = document.getElementById('bcErr'); if (e) e.scrollIntoView({ block: 'center' }); }, 100);
}

/* ---------- typing and choosing (own listeners, no redraw while typing) ---------- */
document.addEventListener('input', (e: any) => {
  const el = e.target, k = el?.dataset?.bc;
  if (!k || !el.closest || !el.closest('#view')) return;
  const item = el.dataset.item, i = Number(el.dataset.idx);
  const a = item ? (st.answers[item] ||= {}) : null;
  switch (k) {
    case 'km': st.km = el.value; break;
    case 'hours': st.hours = el.value; break;
    case 'emt1-name': st.emt1.name = el.value; break;
    case 'emt2-name': st.emt2.name = el.value; break;
    case 'driver-name': st.driver.name = el.value; break;
    case 'qty': a!.qty = el.value === '' ? undefined : Number(el.value); break;
    case 'value': { if (el.value === '') delete st.answers[item]; else a!.value = Number(el.value); break; }
    case 'date': { if (el.value === '') delete st.answers[item]; else a!.date = el.value; break; }
    case 'note': a!.note = el.value; break;
    case 'ptitle': st.problems[i].title = el.value; break;
    case 'pdesc': st.problems[i].description = el.value; break;
    default: return;
  }
  keep(); refreshBar();
  if (item) { const li = document.getElementById('bci-' + item), it = itemOf(item); if (li && it) { const ok = answered(it, st.answers[item]); li.classList.toggle('done', ok); if (ok) { li.classList.remove('missing'); li.querySelector('.bcmiss')?.remove(); } } }
});
document.addEventListener('change', (e: any) => {
  const el = e.target, k = el?.dataset?.bc;
  if (!k || !el.closest || !el.closest('#view')) return;
  const i = Number(el.dataset.idx);
  switch (k) {
    case 'unit': pickUnit(el.value); scheduleRender(); return;
    case 'base': st.baseId = el.value; break;
    case 'emt1': case 'emt2': case 'driver': { const p = st[k as 'emt1']; p.sel = el.value; if (el.value && el.value !== OTHER) p.name = ''; break; }
    case 'psev': st.problems[i].severity = el.value; break;
    case 'attest': st.attested = el.checked; break;
    case 'date': case 'value': case 'qty': if (el.dataset.item) patchItem(el.dataset.item); keep(); return;
    default: return;
  }
  keep(); scheduleRender();
});
void uerr; void pill; void $;
