import { applyMe, applySync, S, scheduleRender } from './state';
import { uerr } from './util';

export class ApiError extends Error {
  user = true;
  constructor(public status: number, message: string, public code: string | null) { super(message); }
}

/** Called when the server says "log in again" or "change your password first". */
let authHook: (kind: 'login' | 'change-password') => void = () => {};
export const setAuthHook = (f: typeof authHook) => { authHook = f; };

export async function api<T = any>(method: string, path: string, body?: any, opts: { form?: FormData; quiet?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'gema-fleet' };
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try {
    res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw uerr('Could not reach the server. Check your connection and try again.');
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return json as T;
  const code = json?.code ?? null;
  if (res.status === 401 && path !== '/auth/login') { if (!opts.quiet) authHook('login'); }
  if (res.status === 403 && code === 'must_change_password') authHook('change-password');
  throw new ApiError(res.status, json?.message || json?.error || 'Something went wrong. Please try again.', code);
}

/** GET a file (for example a CSV export). Same error handling as api(). */
export async function apiFile(path: string): Promise<{ blob: Blob; headers: Headers }> {
  let res: Response;
  try { res = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store' }); } catch { throw uerr('Could not reach the server. Check your connection and try again.'); }
  if (res.ok) return { blob: await res.blob(), headers: res.headers };
  let json: any = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) authHook('login');
  throw new ApiError(res.status, json?.message || json?.error || 'Something went wrong. Please try again.', json?.code ?? null);
}

/* ---------- sync: first load gets everything, after that only what changed ---------- */
let syncing: Promise<boolean> | null = null;
export function syncNow(): Promise<boolean> {
  if (syncing) return syncing.then(() => syncNow());
  syncing = (async () => {
    try {
      const res = await api('GET', '/sync?since=' + S.cursor, undefined, { quiet: false });
      const changed = res.full || Object.keys(res.data || {}).length > 0 || Object.keys(res.deleted || {}).length > 0;
      const meChanged = applyMe(res.me);
      if (changed || !S.ready) { applySync(res); scheduleRender(); }
      else { S.cursor = res.cursor; if (meChanged) scheduleRender(); }
      if (S.connFailed) { S.connFailed = false; scheduleRender(); }
      return changed;
    } catch (e: any) {
      if (!(e instanceof ApiError)) { S.connFailed = true; scheduleRender(); }
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/* ---------- polling ---------- */
let timer: any = null, running = false, listening = false, quiet = 0, getRoute: () => string = () => 'board';
export const setRouteGetter = (f: () => string) => { getRoute = f; };
const BASE_MS = 20000, DISPATCH_MS = 15000;
/** Poll faster on the dispatch wall; back off when nothing has changed for a while to save the daily request allowance. */
function delay() {
  const dispatch = getRoute() === 'dispatch';
  const base = dispatch ? DISPATCH_MS : BASE_MS;
  if (quiet >= 15) return dispatch ? 30000 : 60000;
  if (quiet >= 6) return base * 2;
  return base;
}
export function startPolling() {
  if (running) return;
  running = true;
  const tick = async () => {
    timer = null;
    if (!running) return;
    if (document.visibilityState === 'visible') {
      const changed = await syncNow();
      quiet = changed ? 0 : quiet + 1;
    }
    if (running) timer = setTimeout(tick, delay());
  };
  timer = setTimeout(tick, delay());
  if (listening) return;
  listening = true;
  const wake =() => { quiet = 0; if (document.visibilityState === 'visible' && running) { clearTimeout(timer); timer = setTimeout(tick, 200); } };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { quiet = 0; }, { passive: true });
}
export function stopPolling() { running = false; clearTimeout(timer); timer = null; }
/** Resolves once any sync already in flight has finished (used before logging out). */
export const syncIdle = () => (syncing ? syncing.then(() => undefined, () => undefined) : Promise.resolve());
export function resetSyncState() { S.cursor = 0; S.ready = false; }
