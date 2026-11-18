/**
 * The demo: the real API (src/worker) running inside the visitor's browser against a throwaway in-memory database filled with the GEMA sample fleet.
 *
 * - Nothing is sent to the real server and nothing is saved anywhere: reloading the page starts the demo again from scratch.
 * - There is one demo person for each role, and the visitor switches between them (switchTo). Every rule and permission is the real one.
 * - Photo and PDF uploads stay off and cannot be turned on; backups, agencies, passwords and email links are not part of the demo (BLOCKED below).
 *
 * Loaded on demand by src/client/demo.ts, so people who never open the demo never download any of this.
 */
import type { SqlJsStatic } from 'sql.js';
import { app } from '../worker/index';
import { b64url, hashPassword, sha256Hex } from '../worker/auth';
import { buildSample } from '../shared/sample';
import { docsToStatements } from '../shared/docs-to-sql';
import type { Role } from '../shared/constants';
import { DemoD1 } from './d1';

export const DEMO_AGENCY = 'GEMA';
const COOKIE = 'gf_session';
const ORIGIN = 'https://demo.invalid';

export interface DemoPerson { id: string; name: string; email: string; role: Role; baseIds: string[]; mechanicId: string | null }
/** One person per role. Bases and the mechanic's shop come from the sample fleet (src/shared/sample.ts). */
export const DEMO_PEOPLE: DemoPerson[] = [
  { id: 'demo-system-admin', name: 'Andrea Singh', email: 'andrea.singh@demo.example.org', role: 'system_admin', baseIds: [], mechanicId: null },
  { id: 'demo-fleet-manager', name: 'Marcus Thomas', email: 'marcus.thomas@demo.example.org', role: 'fleet_manager', baseIds: [], mechanicId: null },
  { id: 'demo-base-supervisor', name: 'Kavita Ramdass', email: 'kavita.ramdass@demo.example.org', role: 'base_supervisor', baseIds: ['b-hq', 'b-diamond'], mechanicId: null },
  { id: 'demo-mechanic', name: 'Devon Charles', email: 'devon.charles@demo.example.org', role: 'mechanic', baseIds: [], mechanicId: 'm-2' },
  { id: 'demo-crew', name: 'Shanice Williams', email: 'shanice.williams@demo.example.org', role: 'crew', baseIds: ['b-hq'], mechanicId: null },
  { id: 'demo-dispatcher', name: 'Ravi Persaud', email: 'ravi.persaud@demo.example.org', role: 'dispatcher', baseIds: [], mechanicId: null },
  { id: 'demo-viewer', name: 'Joanne Baptiste', email: 'joanne.baptiste@demo.example.org', role: 'viewer', baseIds: [], mechanicId: null },
];
export const DEFAULT_PERSON = 'demo-fleet-manager';

/** Requests the demo answers itself with a polite refusal, before the API sees them. */
const BLOCKED: [method: string, path: RegExp, message: string][] = [
  ['POST', /^\/api\/attachments$/, 'Uploading photos and PDFs is not available in the demo.'],
  ['DELETE', /^\/api\/attachments\//, 'Attachments cannot be changed in the demo.'],
  ['*', /^\/api\/features$/, 'Photo and PDF uploads cannot be turned on or off in the demo.'],
  ['*', /^\/api\/admin\/backups/, 'Backups are not part of the demo.'],
  ['POST', /^\/api\/agencies/, 'Agencies cannot be changed in the demo.'],
  ['PATCH', /^\/api\/agencies/, 'Agencies cannot be changed in the demo.'],
  ['POST', /^\/api\/auth\/(login|forgot|set-password|token-info|change-password)$/, 'Passwords are not part of the demo. Use the menu at the top right to switch person.'],
  ['POST', /^\/api\/users\/[^/]+\/(password|invite|reset-link)$/, 'Passwords and email links are not part of the demo.'],
  ['POST', /^\/api\/admin\/sample\/remove$/, 'The sample data is the demo, so it cannot be removed here.'],
];
const refuse = (message: string) => new Response(JSON.stringify({ error: message, code: 'demo' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

export interface DemoServer {
  /** Answer one API request, exactly as the real server would (or refuse it, see BLOCKED). */
  fetch(req: Request): Promise<Response>;
  /** Become this demo person: a fresh session, as if they had just logged in. */
  switchTo(personId: string): Promise<void>;
  /** The demo people as they are now (an administrator may have changed someone's role or deactivated them). */
  people(): Promise<(DemoPerson & { active: boolean })[]>;
  current(): string;
}

export async function createDemoServer(SQL: SqlJsStatic, migrations: string[]): Promise<DemoServer> {
  const sqlite = new SQL.Database();
  for (const m of migrations) sqlite.exec(m);
  const DB = new DemoD1(sqlite);
  const env: any = {
    DB,
    FILES: { get: async () => null, head: async () => null, list: async () => ({ objects: [], truncated: false }), put: async () => { throw new Error('Not available in the demo.'); }, delete: async () => {} },
    ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
    APP_URL: ORIGIN,
    PBKDF2_ITERATIONS: '1000',
    SUPERUSER_EMAILS: '', // nobody is the super user in the demo, so features, backups and agencies stay out of reach
    SUPERUSER_AGENCY: DEMO_AGENCY,
  };
  const ctx: any = { waitUntil: (p: Promise<unknown>) => { Promise.resolve(p).catch(() => {}); }, passThroughOnException: () => {}, props: {} };

  /* the GEMA sample fleet, then one person per role */
  const { stmts } = docsToStatements(buildSample(), { sample: true, agency: DEMO_AGENCY });
  await DB.batch([DB.prepare('UPDATE counter SET v = v + 1 WHERE id = 1'), ...stmts.map((s) => DB.prepare(s.sql).bind(...s.params))]);
  const now = new Date().toISOString();
  const unusable = await hashPassword(b64url(crypto.getRandomValues(new Uint8Array(18))), 1000); // nobody signs in with a password in the demo
  await DB.batch([
    DB.prepare('UPDATE counter SET v = v + 1 WHERE id = 1'),
    ...DEMO_PEOPLE.map((p) => DB.prepare(`INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at, agency_id)
      VALUES (?,?,?,?,?,?,?,1,0,(SELECT v FROM counter),?,?,?)`).bind(p.id, p.email, p.name, p.role, JSON.stringify(p.baseIds), p.mechanicId, unusable, now, now, DEMO_AGENCY)),
  ]);

  let cookie = '';
  let who = '';
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const [m, re, msg] of BLOCKED) if ((m === '*' || m === req.method) && re.test(url.pathname)) return refuse(msg);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const inner = new Request(ORIGIN + url.pathname + url.search, { method: req.method, headers: req.headers, body });
    // Browsers silently drop a Cookie header from any Request a page builds, and hide Set-Cookie on responses. A stand-alone Headers object may hold one,
    // so the session cookie rides on that (Hono reads cookies from req.raw.headers). Only switchTo starts sessions in the demo (sign-in is blocked).
    const headers = new Headers(req.headers);
    headers.delete('origin');
    if (cookie) headers.set('Cookie', cookie); else headers.delete('Cookie');
    Object.defineProperty(inner, 'headers', { value: headers });
    return app.fetch(inner, env, ctx);
  }
  async function switchTo(personId: string) {
    const p = DEMO_PEOPLE.find((x) => x.id === personId);
    if (!p) throw new Error('Unknown demo person.');
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const at = new Date().toISOString();
    const exp = new Date(Date.now() + 864e5).toISOString();
    await DB.batch([
      DB.prepare('DELETE FROM sessions'),
      DB.prepare('INSERT INTO sessions (id, user_id, agency_id, acting_agency_id, expires_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,NULL,?,?,?,?)').bind(await sha256Hex(token), p.id, DEMO_AGENCY, exp, at, at, at),
    ]);
    cookie = `${COOKIE}=${token}`;
    who = p.id;
  }
  async function people() {
    const rows = (await DB.prepare(`SELECT id, role, active FROM users WHERE agency_id = ? AND id LIKE 'demo-%'`).bind(DEMO_AGENCY).all<any>()).results;
    const by = new Map(rows.map((r) => [r.id, r]));
    return DEMO_PEOPLE.filter((p) => by.has(p.id)).map((p) => ({ ...p, role: by.get(p.id).role as Role, active: !!by.get(p.id).active }));
  }

  /* a bus check list, so crews can do a check straight away (made through the API, as a fleet manager would) */
  await switchTo(DEFAULT_PERSON);
  const r = await handle(new Request(ORIGIN + '/api/bus-check-lists/standard', { method: 'POST', headers: { 'X-Requested-With': 'gema-fleet' } }));
  if (!r.ok) console.warn('Demo: could not add the standard bus check list', r.status, await r.text());

  return { fetch: handle, switchTo, people, current: () => who };
}
