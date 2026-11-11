/** Drawers and the confirm dialog. They live outside #view so data refreshes never wipe a form. */
import { ui } from './state';
import { $, esc } from './util';
import { icon } from './icons';

let lastFocus: any = null;
/** Where "Back" goes when one drawer was opened from inside another. */
export const drawerBack: { type: string; id: string }[] = [];

export function showDrawer(title: string, html: string, opts: { wide?: boolean; drawer?: any; back?: string; focusClose?: boolean } = {}) {
  if (!$('#drawerRoot .drawer')) lastFocus = document.activeElement;
  ui.drawer = opts.drawer || null;
  if (!opts.drawer) drawerBack.length = 0;
  $('#drawerRoot').innerHTML = `<div class="scrim" data-act="close-drawer"></div><aside class="drawer${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dTitle">
    <div class="dhead"><div class="dtitle">${opts.back ? `<button class="btn link back" type="button" data-act="drawer-back" id="dBack">${icon('left')}${esc(opts.back)}</button>` : ''}<h2 id="dTitle">${esc(title)}</h2></div><button class="iconbtn" type="button" id="dClose" data-act="close-drawer" aria-label="Close" title="Close">${icon('x')}</button></div><div class="dbody" id="dBody">${html}</div></aside>`;
  const first = $('#dBody input:not([type=hidden]):not(.sr),#dBody select,#dBody textarea');
  (opts.focusClose || !first ? $('#dClose') : first).focus();
}
export function closeDrawer() {
  if (!$('#drawerRoot .drawer')) return;
  $('#drawerRoot').innerHTML = '';
  ui.drawer = null;
  drawerBack.length = 0;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

let cfResolve: ((v: boolean) => void) | null = null;
export function confirmUI({ title, message, label = 'Confirm', danger = false, list, after }: { title: string; message: string; label?: string; danger?: boolean; list?: string[]; after?: string }): Promise<boolean> {
  return new Promise((res) => {
    cfResolve = res;
    $('#confirmRoot').innerHTML = `<div class="scrim hi"></div><div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="cfT" aria-describedby="cfM">
      <h2 id="cfT">${esc(title)}</h2><p id="cfM" class="muted" style="margin-top:8px">${esc(message)}</p>${list && list.length ? `<ul class="cflist" id="cfList">${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${after ? `<p class="muted small" style="margin-top:8px">${esc(after)}</p>` : ''}
      <div class="dfoot"><button class="btn" id="cfNo" type="button" data-act="cf-no">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="cfYes" type="button" data-act="cf-yes">${esc(label)}</button></div></div>`;
    $('#cfNo').focus();
  });
}
export function cfDone(v: boolean) {
  $('#confirmRoot').innerHTML = '';
  const r = cfResolve;
  cfResolve = null;
  if (r) r(v);
}
