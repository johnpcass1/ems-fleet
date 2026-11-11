/** Agencies screen (super user only): the organisations that share this site. The server answers 403 to everyone else. */
import { S, hooks, scheduleRender } from './state';
import { esc, fmtDate, toast, field, inp, val, run, selHtml } from './util';
import { CURRENCIES } from '../shared/constants';
import { VIEWS } from './registry';
import { pageHead, actBtn } from './bits';
import { showDrawer, closeDrawer, confirmUI } from './dom';
import { pwFieldsHtml, passwordProblem } from './accounts-ui';
import { listAgencies, createAgency, renameAgency, setAgencyActive, openAgency, backToHomeAgency, type AgencyRow } from './actions';

let cache: AgencyRow[] | null = null, loading = false, err = '';
export const resetAgenciesCache = () => { cache = null; };
export async function loadAgencies(force = false) {
  if (loading || (cache && !force)) return;
  loading = true;
  try { cache = (await listAgencies()).agencies; err = ''; } catch (e: any) { err = e.message || 'Could not load agencies.'; cache = cache || []; }
  loading = false;
  scheduleRender();
}

VIEWS.agencies = function () {
  if (!S.me?.isSuperuser) return '<div class="warnbox bad">You do not have access to this page.</div>';
  loadAgencies();
  const list = cache;
  const here = S.me.agency?.id;
  return `${pageHead('Agencies', { sub: 'The organisations that share this site. Each one has its own vehicles, people and settings, and cannot see the others.', acts: actBtn('Add agency', { id: 'addAgency', act: 'add-agency', primary: true, icon: 'plus' }) })}
  ${err ? `<div class="warnbox bad" role="alert">${esc(err)}</div>` : ''}
  <div class="panel"><div class="tscroll"><table class="t" id="agenciesTable"><thead><tr><th>Agency ID</th><th>Name</th><th>State</th><th class="n">Active users</th><th class="n">Vehicles</th><th>Created</th><th></th></tr></thead><tbody>
  ${list === null ? '<tr><td colspan="7" class="muted">Loading...</td></tr>' : list.map((a) => `<tr class="${a.active ? '' : 'muted'}" data-agency="${esc(a.id)}"><td><b>${esc(a.id)}</b>${a.isHome ? ' <span class="badge acc" title="Your own agency">Home</span>' : ''}</td><td>${esc(a.name)}</td>
    <td>${a.active ? '<span class="badge ok">Active</span>' : '<span class="badge off">Deactivated</span>'}${a.id === here ? ' <span class="badge">Viewing</span>' : ''}</td>
    <td class="n">${a.users}</td><td class="n">${a.vehicles}</td><td>${a.createdAt ? esc(fmtDate(a.createdAt.slice(0, 10))) : ''}</td>
    <td class="c-act"><div class="row tight">${a.id !== here && a.active ? `<button class="btn sm" data-act="open-agency" data-id="${esc(a.id)}" id="oa-${esc(a.id)}">Open</button>` : ''}
      <button class="btn sm ghost" data-act="rename-agency" data-id="${esc(a.id)}" id="ra-${esc(a.id)}">Rename</button>
      ${a.isHome ? '' : `<button class="btn sm ghost ${a.active ? 'danger' : ''}" data-act="${a.active ? 'deactivate-agency' : 'reactivate-agency'}" data-id="${esc(a.id)}" id="da-${esc(a.id)}">${a.active ? 'Deactivate' : 'Reactivate'}</button>`}</div></td></tr>`).join('')}
  </tbody></table></div></div>`;
};

const pwVal = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
function addFormHtml() {
  return `<form data-form="agency-add" id="agencyForm" novalidate>
    <p class="small muted" style="margin-top:0">The agency starts empty, with default settings. Its first system administrator then sets up bases, vehicles and people.</p>
    ${field('Agency ID', inp('ag-code', '', 'text', 'required maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. NORTH"'), '2 to 20 characters: letters, numbers or hyphens. People type this to log in. It cannot be changed later.')}
    ${field('Agency name', inp('ag-name', '', 'text', 'required maxlength="100" autocomplete="off"'), 'Shown in the sidebar and on the page title.')}
    ${field('Currency', selHtml('ag-cur', CURRENCIES.map((c) => [c.code, `${c.label} (${c.symbol})`]), 'USD'), 'Money is shown in this currency. The agency can change it later in Setup.')}
    <fieldset class="f"><legend class="l">First system administrator</legend>
    ${field('Full name', inp('ag-aname', '', 'text', 'required maxlength="120" autocomplete="off"'))}
    ${field('Email', inp('ag-aemail', '', 'email', 'required maxlength="200" autocomplete="off"'))}
    ${pwFieldsHtml('ag')}</fieldset>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="ag-cancel">Cancel</button><button class="btn primary" type="submit" id="ag-save">Add agency</button></div></form>`;
}
function renameFormHtml(a: AgencyRow) {
  return `<form data-form="agency-rename" data-id="${esc(a.id)}" id="agencyRenameForm" novalidate>
    <p class="small muted" style="margin-top:0">The Agency ID <b>${esc(a.id)}</b> stays the same. Only the name changes.</p>
    ${field('Agency name', inp('ar-name', a.name, 'text', 'required maxlength="100" autocomplete="off"'))}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="ar-cancel">Cancel</button><button class="btn primary" type="submit" id="ar-save">Save name</button></div></form>`;
}
const find = (id: string) => (cache || []).find((a) => a.id === id);

export const agencyForms: Record<string, any> = {
  'agency-add': async () => {
    const code = val('ag-code').toUpperCase(), name = val('ag-name'), aname = val('ag-aname'), email = val('ag-aemail');
    if (!/^[A-Z0-9-]{2,20}$/.test(code)) { toast('The Agency ID must be 2 to 20 characters: letters, numbers or hyphens.', true); return; }
    if (!name) { toast('Enter the agency name.', true); return; }
    if (!aname) { toast('Enter the administrator’s name.', true); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter a valid email address.', true); return; }
    const problem = passwordProblem(pwVal('ag-pw'), pwVal('ag-pw2'), email);
    if (problem) { toast(problem, true); return; }
    if (await run(() => createAgency({ code, name, currency: val('ag-cur') || 'USD', admin: { name: aname, email, password: pwVal('ag-pw') } }))) {
      closeDrawer();
      toast(`${name} added. Give ${aname} the Agency ID ${code}, their email and the password.`);
      await loadAgencies(true);
    }
  },
  'agency-rename': async (f: any) => {
    const a = find(f.dataset.id), name = val('ar-name');
    if (!a) return;
    if (!name) { toast('Enter the agency name.', true); return; }
    if (await run(() => renameAgency(a.id, name))) {
      closeDrawer(); toast('Name saved');
      if (S.me?.agency?.id === a.id) { S.me.agency.name = name; if (S.me.homeAgency?.id === a.id) S.me.homeAgency.name = name; }
      await loadAgencies(true);
    }
  },
};
export const agencyActs: Record<string, any> = {
  'add-agency': () => showDrawer('Add agency', addFormHtml()),
  'rename-agency': (el: any) => { const a = find(el.dataset.id); if (a) showDrawer(`Rename ${a.id}`, renameFormHtml(a)); },
  'deactivate-agency': async (el: any) => {
    const a = find(el.dataset.id);
    if (!a) return;
    if (!(await confirmUI({ title: `Deactivate ${a.name}?`, message: 'Nobody in this agency can log in, and everyone in it is logged out now. Nothing is deleted. You can reactivate it at any time.', label: 'Deactivate', danger: true }))) return;
    if (await run(() => setAgencyActive(a.id, false))) { toast('Agency deactivated'); await loadAgencies(true); }
  },
  'reactivate-agency': async (el: any) => { if (await run(() => setAgencyActive(el.dataset.id, true))) { toast('Agency reactivated'); await loadAgencies(true); } },
  'open-agency': async (el: any) => {
    let r: any;
    if (await run(async () => { r = await openAgency(el.dataset.id); })) {
      if (S.me) S.me.agency = r.agency;
      await hooks.agencySwitched('#board');
    }
  },
  'agency-back': async () => {
    let r: any;
    if (await run(async () => { r = await backToHomeAgency(); })) {
      if (S.me) S.me.agency = r.agency;
      resetAgenciesCache();
      await hooks.agencySwitched('#agencies');
    }
  },
};
