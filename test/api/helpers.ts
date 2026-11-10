import { env, exports } from 'cloudflare:workers';
import { hashPassword } from '../../src/worker/auth';
import { buildSample } from '../../src/shared/sample';
import { docsToStatements } from '../../src/shared/docs-to-sql';
import type { Env } from '../../src/worker/env';

export const E = env as unknown as Env;
export const PASSWORD = 'correct-horse-9';

export interface Res { status: number; json: any; headers: Headers; res: Response }
export async function api(method: string, path: string, opts: { body?: any; cookie?: string; form?: FormData; headers?: Record<string, string>; noCsrf?: boolean } = {}): Promise<Res> {
  const headers = new Headers(opts.headers || {});
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (method !== 'GET' && !opts.noCsrf) headers.set('X-Requested-With', 'gema-fleet');
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(opts.body); }
  const res = await (exports as any).default.fetch(new Request('https://gema.test' + path, { method, headers, body }));
  const ct = res.headers.get('content-type') || '';
  const json = ct.includes('json') ? await res.clone().json().catch(() => null) : null;
  return { status: res.status, json, headers: res.headers, res };
}

let n = 0;
export async function makeUser(role: string, o: { email?: string; baseIds?: string[]; mechanicId?: string | null; name?: string; mustChange?: boolean; active?: boolean } = {}) {
  const k = ++n;
  const email = o.email ?? `${role}${k}@gema.test`;
  const id = `u-${role}-${k}`;
  const now = new Date().toISOString();
  await E.DB.batch([
    E.DB.prepare('UPDATE counter SET v = v + 1 WHERE id = 1'),
    E.DB.prepare(`INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,(SELECT v FROM counter),?,?)`)
      .bind(id, email, o.name ?? `Test ${role}`, role, JSON.stringify(o.baseIds ?? []), o.mechanicId ?? null, await hashPassword(PASSWORD, 1000), o.active === false ? 0 : 1, o.mustChange ? 1 : 0, now, now),
  ]);
  return { id, email, password: PASSWORD, role };
}
export function cookieOf(res: Res): string {
  const sc = res.headers.get('set-cookie') || '';
  const m = /gf_session=([^;]+)/.exec(sc);
  if (!m) throw new Error('no session cookie in response: ' + sc);
  return 'gf_session=' + m[1];
}
export async function loginAs(u: { email: string; password: string }) {
  const r = await api('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
  if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.json));
  return cookieOf(r);
}
/** Make a user and log them in. Returns {user, cookie}. */
export async function as(role: string, o: Parameters<typeof makeUser>[1] = {}) {
  const user = await makeUser(role, o);
  return { user, cookie: await loginAs(user) };
}

/** Loads the prototype's demo fleet (flagged sample = 1). */
export async function seedDemo() {
  const { stmts } = docsToStatements(buildSample(), { sample: true });
  await E.DB.prepare('UPDATE counter SET v = v + 1 WHERE id = 1').run();
  for (let i = 0; i < stmts.length; i += 80) await E.DB.batch(stmts.slice(i, i + 80).map((s) => E.DB.prepare(s.sql).bind(...s.params)));
}
export const row = <T = any>(sql: string, ...p: unknown[]) => E.DB.prepare(sql).bind(...p).first<T>();
export const rows = async <T = any>(sql: string, ...p: unknown[]) => (await E.DB.prepare(sql).bind(...p).all<T>()).results;

/** Fetch the whole synced data set as the given cookie. */
export async function syncAll(cookie: string, since = 0) {
  const r = await api('GET', '/api/sync?since=' + since, { cookie });
  return r.json;
}
export const byId = (list: any[], id: string) => list.find((x) => x.id === id);

/** The super user's address, from SUPERUSER_EMAILS in wrangler.jsonc (the API tests run with that config). */
export const SUPER_EMAIL = 'johnpcass3@gmail.com';
/** Log in as the super user (creating the account on first use in a test). */
export async function superCookie(): Promise<string> {
  const have = await E.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(SUPER_EMAIL).first();
  if (!have) await makeUser('system_admin', { email: SUPER_EMAIL, name: 'Super User' });
  return loginAs({ email: SUPER_EMAIL, password: PASSWORD });
}
/** Photo and PDF uploads are OFF by default and only the super user can change that. Tests that upload turn them on through the API, as the super user would. */
export async function setUploads(_ignored: string | null, on = true) {
  const r = await api('PUT', '/api/features', { cookie: await superCookie(), body: { uploads: on } });
  if (r.status !== 200) throw new Error('could not set uploads ' + JSON.stringify(r.json));
}
