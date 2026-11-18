/**
 * Demo mode: "Try the demo" on the login page opens the app on the GEMA sample fleet without an account.
 *
 * The real API (src/worker) runs inside this browser tab on an in-memory database (src/demo/server.ts), and every request goes there instead of to the
 * real server (setTransport). So the demo never touches real data, nothing is saved, and reloading the page (or Exit demo) throws it all away.
 * A menu at the top right switches between one demo person per role.
 *
 * The demo engine (sql.js, the API code and the migrations) is only downloaded when somebody opens the demo.
 */
import { ROLES } from '../shared/constants';
import { setTransport } from './api';
import { S } from './state';
import { $, esc, toast } from './util';

interface DemoPerson { id: string; name: string; role: string; active: boolean }
interface DemoServer { fetch(req: Request): Promise<Response>; switchTo(id: string): Promise<void>; people(): Promise<DemoPerson[]>; current(): string }

let server: DemoServer | null = null;
let people: DemoPerson[] = [];
export const isDemo = () => !!server;

/* Vite bundles these into separate files that load on demand (import.meta.glob keeps the Worker code out of the browser type-check). */
const serverModule = import.meta.glob('../demo/server.ts');
const migrationFiles = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default' });

/** Load the demo engine and the sample fleet, and send every request there from now on. */
export async function startDemo(): Promise<void> {
  if (server) return;
  const [{ default: initSqlJs }, { default: wasmUrl }, mod] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
    serverModule['../demo/server.ts']() as Promise<{ createDemoServer(SQL: unknown, migrations: string[]): Promise<DemoServer> }>,
  ]);
  const names = Object.keys(migrationFiles).sort();
  const migrations = await Promise.all(names.map((n) => migrationFiles[n]() as Promise<string>));
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const s = await mod.createDemoServer(SQL, migrations);
  server = s;
  setTransport(async (path, init) => {
    const res = await s.fetch(new Request(location.origin + '/api' + path, init));
    // An administrator may have just changed a demo person's role or deactivated them: keep the top-right menu right.
    if (init.method && init.method !== 'GET' && path.startsWith('/users')) people = await s.people();
    return res;
  });
  people = await s.people();
}

/** Become another demo person. The caller reloads the data afterwards. */
export async function switchDemoPerson(id: string) {
  if (!server) return;
  await server.switchTo(id);
  people = await server.people();
}

/** Leave the demo: reload the page, which throws the in-memory copy away and shows the login page. */
export function exitDemo() {
  history.replaceState(null, '', '/');
  location.reload();
}

/** The top-right menu of demo people (one per role), and an Exit button. Drawn on every render while the demo is open. */
export function drawDemoBar() {
  const bar = $('#demoBar');
  if (!bar) return;
  if (!server || !S.me) { bar.hidden = true; bar.innerHTML = ''; bar.dataset.sig = ''; return; }
  bar.hidden = false;
  const cur = server.current();
  const sig = cur + '|' + people.map((p) => p.id + p.role + p.active).join(',');
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  const opts = people.map((p) => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}${p.active || p.id === cur ? '' : ' disabled'} title="${esc(p.name)}">${esc(ROLES[p.role] || p.role)}${p.active ? '' : ' (deactivated)'}</option>`).join('');
  bar.innerHTML = `<span class="badge acc demotag" aria-hidden="true">Demo</span>
    <label class="demopick"><span class="sr">Viewing the demo as</span><select id="demoPerson" data-demo-person title="Viewing the demo as">${opts}</select></label>
    <button type="button" class="btn sm" data-act="demo-exit" id="demoExit">Exit demo</button>`;
}

/** The note at the top of every page while the demo is open. */
export const demoBannerHtml = () =>
  server ? '<div class="banner info" id="demoBanner" role="status"><span><b>Demo</b> with sample GEMA data. Change anything you like: nothing is saved, and reloading starts again. Switch the type of user at the top right.</span><button class="btn sm" type="button" data-act="demo-exit" id="demoExitBanner">Exit demo</button></div>' : '';

/** "Try the demo" under the login form. The login page is shared by every agency, so it never names one (the e2e run checks this). */
export const demoLoginHtml = () =>
  `<div class="panel demoinvite"><div class="pb"><h2>Just looking?</h2><p class="muted small">Try the app with a sample ambulance fleet. You can switch between every type of user, and nothing you change is saved.</p>
    <div id="demo-err" class="warnbox bad" role="alert" hidden></div>
    <button class="btn block" type="button" data-act="demo-start" id="demoStart">Try the demo</button></div></div>`;

export function demoFailed(e: unknown) {
  console.error('demo failed to start', e);
  const err = document.getElementById('demo-err');
  const msg = 'The demo could not start in this browser. Try reloading the page.';
  if (err) { err.textContent = msg; err.hidden = false; } else toast(msg, true);
}
