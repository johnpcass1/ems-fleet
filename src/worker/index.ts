import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
import { HttpError, bad, forbidden, nowISO, parse, zId } from './http';
import { Tx, SEQ, all, first, auditStmt } from './db';
import { activityCsv, listActivity } from './activity';
import {
  COOKIE, LOCK_FAILS, LOCK_MS, actorFrom, loadRolePerms, blockUntilPasswordChanged, clearSessionCookie, createSession, dummyVerify, hashPassword, iterationsFor, loginState, passwordProblem,
  recordAttempt, requireAuth, verifyPassword,
} from './auth';
import { syncSince } from './sync';
import * as rules from './rules';
import * as users from './users';
import * as roles from './roles';
import { forgotPassword, publicMe, setPasswordFromLink, tokenInfo } from './accounts';
import { emailEnabled, lastSinkMail, sinkActive } from './mail';
import { deleteAttachment, downloadAttachment, uploadAttachment } from './files';
import { backupStep, listBackups } from './backup';
import { notifyIssueReported } from './notify';
import { getCookie } from 'hono/cookie';

const app = new Hono<AppEnv>();

/* ---------- headers, CSRF, errors ---------- */
app.use('/api/*', async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    // CSRF: a custom header cannot be sent by a plain cross-site form, and Origin (when sent) must match this site.
    if (c.req.header('x-requested-with') !== 'gema-fleet') throw new HttpError(403, 'Request blocked (missing header).', 'csrf');
    const origin = c.req.header('origin');
    if (origin) {
      const allowed = new Set([new URL(c.req.url).origin]);
      try { allowed.add(new URL(c.env.APP_URL).origin); } catch { /* ignore */ }
      if (!allowed.has(origin)) throw new HttpError(403, 'Request blocked (wrong origin).', 'csrf');
    }
  }
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'same-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code ?? null }, err.status as any);
  console.error('Unhandled error', err);
  return c.json({ error: 'Something went wrong on the server. Please try again.', code: 'server_error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not found.', code: 'not_found' }, 404));

app.get('/api/health', (c) => c.json({ ok: true }));

/* ---------- login / logout ---------- */
const loginIn = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

app.post('/api/auth/login', async (c) => {
  const i = parse(loginIn, await c.req.json().catch(() => ({})));
  const state = await loginState(c.env.DB, i.email);
  const lock = state.lockedUntil;
  if (lock) {
    const mins = Math.max(1, Math.ceil((lock - Date.now()) / 60000));
    throw new HttpError(429, `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'locked');
  }
  const u = await first<any>(c.env.DB, 'SELECT * FROM users WHERE email = ?', i.email);
  let ok = false;
  let iterations = 0;
  if (u && u.active && String(u.password_hash).startsWith('pbkdf2-sha256$')) {
    const v = await verifyPassword(i.password, u.password_hash);
    ok = v.ok;
    iterations = v.iterations;
  } else {
    await dummyVerify(i.password, c.env); // same cost whether or not the email exists
  }
  if (!ok) {
    await recordAttempt(c.env.DB, i.email, false);
    // Sign-in history: the address that was tried (never the password; text that is not an email address, such as a password typed
    // into the wrong box, is not kept at all) and the account it belongs to, if there is one. The failure that starts a lock also writes "locked".
    const at = nowISO();
    const tried = /^\S+@\S+\.\S+$/.test(i.email) ? i.email : '(not an email address)';
    const rows = [auditStmt(c.env.DB, { at, userId: u?.id ?? null, email: tried, action: 'auth.login_failed', entityType: 'user', entityId: u?.id ?? null })];
    if (state.fails + 1 >= LOCK_FAILS) rows.push(auditStmt(c.env.DB, { at, userId: u?.id ?? null, email: tried, action: 'auth.locked', entityType: 'user', entityId: u?.id ?? null, after: { minutes: LOCK_MS / 60000, fails: LOCK_FAILS } }));
    await c.env.DB.batch(rows);
    throw new HttpError(401, 'Wrong email or password.', 'bad_login');
  }
  await recordAttempt(c.env.DB, i.email, true);
  const now = nowISO();
  const stmts = [c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, u.id)];
  // If the iteration setting was raised, upgrade this user's hash while we have the password.
  const want = iterationsFor(c.env);
  if (iterations < want) stmts.push(c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(i.password, want), u.id));
  stmts.push(auditStmt(c.env.DB, { at: now, userId: u.id, email: u.email, action: 'auth.login', entityType: 'user', entityId: u.id }));
  await c.env.DB.batch(stmts);
  await createSession(c, u.id);
  return c.json({ user: publicMe({ ...actorFrom(c.env, u, await loadRolePerms(c.env.DB)), mustChangePassword: u.must_change_password }), emailEnabled: emailEnabled(c.env) });
});

/* ---------- email links: choose a password, forgot password (no login needed) ---------- */
app.get('/api/auth/config', (c) => c.json({ emailEnabled: emailEnabled(c.env) }));
app.post('/api/auth/forgot', forgotPassword);
app.post('/api/auth/token-info', tokenInfo);
app.post('/api/auth/set-password', setPasswordFromLink);
/** Development only: the last email "sent" while MAIL_SINK=1 on localhost. Answers 404 everywhere else. */
app.get('/api/dev/last-mail', async (c) => {
  if (!sinkActive(c.env)) return c.json({ error: 'Not found.', code: 'not_found' }, 404);
  return c.json({ mail: await lastSinkMail(c.env, c.req.query('to') || undefined) });
});

/** Who am I? Answers 200 with `user: null` when nobody is logged in, so the login page loads without an error in the browser console. */
app.get('/api/auth/session', async (c) => {
  let user: any = null;
  try {
    await requireAuth(c, async () => { user = c.var.user; });
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 401)) throw e;
  }
  return c.json({ user: user ? publicMe(user) : null, emailEnabled: emailEnabled(c.env) });
});

const authed = new Hono<AppEnv>();
authed.use('*', requireAuth);

authed.get('/auth/me', (c) => c.json({ user: publicMe(c.var.user) }));
authed.post('/auth/logout', async (c) => {
  const u = c.var.user;
  const now = nowISO();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(u.sessionId),
    auditStmt(c.env.DB, { at: now, userId: u.id, email: u.email, action: 'auth.logout', entityType: 'user', entityId: u.id }),
  ]);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
const pwIn = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });
authed.post('/auth/change-password', async (c) => {
  const u = c.var.user;
  const i = parse(pwIn, await c.req.json().catch(() => ({})));
  const row = await first<any>(c.env.DB, 'SELECT password_hash FROM users WHERE id = ?', u.id);
  const v = await verifyPassword(i.currentPassword, row.password_hash);
  if (!v.ok) throw bad('Your current password is not right.', 'bad_current');
  const problem = passwordProblem(i.newPassword, u.email);
  if (problem) throw bad(problem);
  if (i.newPassword === i.currentPassword) throw bad('Choose a password you have not used just now.');
  const tx = new Tx(c.env.DB, u);
  tx.run(`UPDATE users SET password_hash = ?, must_change_password = 0, seq = ${SEQ}, updated_at = ? WHERE id = ?`, await hashPassword(i.newPassword, iterationsFor(c.env)), tx.at, u.id);
  tx.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', u.id, u.sessionId); // sign out other devices
  tx.audit('auth.change_password', 'user', u.id, null, null);
  await tx.commit();
  return c.json({ ok: true });
});

/* everything below needs a password that is not a temporary one */
const api = new Hono<AppEnv>();
api.use('*', blockUntilPasswordChanged);
const body = (c: any) => c.req.json().catch(() => ({}));

/** `me` rides along on every sync (even when nothing else changed) so a change to someone's permissions reaches their screen without a re-login. */
api.get('/sync', async (c) => {
  const u = c.var.user;
  return c.json({ ...(await syncSince(c.env.DB, u, Number(c.req.query('since') || 0))), me: { role: u.role, baseIds: u.baseIds, mechanicId: u.mechanicId, isSuperuser: !!u.isSuper, perms: u.perms ?? {} } });
});

/* vehicles */
api.post('/vehicles', async (c) => c.json(await rules.createVehicle(c.env, c.var.user, await body(c))));
api.patch('/vehicles/:id', async (c) => c.json(await rules.editVehicle(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/vehicles/:id/status', async (c) => c.json(await rules.changeStatus(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/vehicles/:id/readings', async (c) => c.json(await rules.logReading(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/readings/:id/accept', async (c) => c.json(await rules.acceptReading(c.env, c.var.user, c.req.param('id'))));
api.post('/moves', async (c) => c.json(await rules.moveUnits(c.env, c.var.user, await body(c))));

/* issues */
api.post('/issues', async (c) => {
  const r = await rules.reportIssue(c.env, c.var.user, await body(c));
  c.executionCtx.waitUntil(notifyIssueReported(c.env, r.issue, r.vehicle)); // no-op today; email alerts are a later addition
  return c.json({ ok: true, id: r.id });
});
api.post('/issues/:id/dismiss', async (c) => c.json(await rules.dismissIssue(c.env, c.var.user, c.req.param('id'))));

/* work orders */
api.post('/work-orders', async (c) => c.json(await rules.createWorkOrder(c.env, c.var.user, await body(c))));
api.patch('/work-orders/:id', async (c) => c.json(await rules.patchWorkOrder(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/work-orders/:id/lines', async (c) => c.json(await rules.addLine(c.env, c.var.user, c.req.param('id'), await body(c))));
api.delete('/work-orders/:id/lines/:lineId', async (c) => c.json(await rules.removeLine(c.env, c.var.user, c.req.param('id'), c.req.param('lineId'))));
api.post('/work-orders/:id/transition', async (c) => c.json(await rules.transitionWorkOrder(c.env, c.var.user, c.req.param('id'), await body(c))));

/* parts, mechanics, setup */
api.post('/parts', async (c) => c.json(await rules.savePart(c.env, c.var.user, null, await body(c))));
api.put('/parts/:id', async (c) => c.json(await rules.savePart(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/parts/:id/receive', async (c) => c.json(await rules.receivePart(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/mechanics', async (c) => c.json(await rules.saveMechanic(c.env, c.var.user, null, await body(c))));
api.put('/mechanics/:id', async (c) => c.json(await rules.saveMechanic(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/bases', async (c) => c.json(await rules.saveBase(c.env, c.var.user, null, await body(c))));
api.put('/bases/:id', async (c) => c.json(await rules.saveBase(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/pm-programs', async (c) => c.json(await rules.saveProgram(c.env, c.var.user, null, await body(c))));
api.put('/pm-programs/:id', async (c) => c.json(await rules.saveProgram(c.env, c.var.user, c.req.param('id'), await body(c))));
api.put('/features', async (c) => c.json(await rules.saveFeatures(c.env, c.var.user, await body(c))));
api.put('/roles/:role/permissions', async (c) => c.json(await roles.saveRolePermissions(c.env, c.var.user, c.req.param('role'), await body(c))));
api.post('/roles/:role/reset', async (c) => c.json(await roles.resetRolePermissions(c.env, c.var.user, c.req.param('role'))));
api.put('/settings', async (c) => c.json(await rules.saveSettings(c.env, c.var.user, await body(c))));
api.post('/admin/sample/remove', async (c) => c.json(await rules.removeSample(c.env, c.var.user)));

/* files */
api.post('/attachments', uploadAttachment);
api.get('/attachments/:id/file', downloadAttachment);
api.delete('/attachments/:id', deleteAttachment);

/* users */
api.get('/users', async (c) => c.json(await users.listUsers(c.env, c.var.user)));
api.post('/users', async (c) => c.json(await users.createUser(c.env, c.var.user, await body(c))));
api.put('/users/:id', async (c) => c.json(await users.updateUser(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/users/:id/permissions', async (c) => c.json(await users.setPermissions(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/users/:id/password', async (c) => c.json(await users.setPassword(c.env, c.var.user, c.req.param('id'), await body(c))));
api.post('/users/:id/invite', async (c) => c.json(await users.resendInvite(c.env, c.var.user, c.req.param('id'))));
api.post('/users/:id/reset-link', async (c) => c.json(await users.sendResetLink(c.env, c.var.user, c.req.param('id'))));
api.post('/users/:id/deactivate', async (c) => c.json(await users.setActive(c.env, c.var.user, c.req.param('id'), false)));
api.post('/users/:id/reactivate', async (c) => c.json(await users.setActive(c.env, c.var.user, c.req.param('id'), true)));

/* backups (super user only) */
const needBackups = (c: any) => { if (!c.var.user.isSuper) throw forbidden('Only the super user can use backups.'); };
api.get('/admin/backups', async (c) => { needBackups(c); return c.json({ backups: await listBackups(c.env) }); });
api.post('/admin/backups/step', async (c) => {
  needBackups(c);
  const b = await body(c);
  const r = await backupStep(c.env, { force: !!b.force });
  if (r.status === 'done') {
    const tx = new Tx(c.env.DB, c.var.user);
    tx.audit('backup.run', 'backup', r.date, null, { key: r.key });
    await tx.commit();
  }
  return c.json(r);
});
api.get('/admin/backups/:date', async (c) => {
  needBackups(c);
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Bad date.');
  const o = await c.env.FILES.get(`backups/${date}.json.gz`);
  if (!o) throw new HttpError(404, 'No backup for that date.', 'not_found');
  return new Response(o.body, { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="gema-fleet-${date}.json.gz"`, 'Content-Length': String(o.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
});
/* activity history (super user and system administrators; everyone else 403) */
const needActivity = (c: any) => { if (!c.var.user.isSuper && c.var.user.role !== 'system_admin') throw forbidden(); };
const activityList = async (c: any) => { needActivity(c); return c.json(await listActivity(c.env, new URL(c.req.url).searchParams)); };
api.get('/admin/activity', activityList);
api.get('/admin/audit', activityList); // the original path, same answer
api.get('/admin/activity/export', async (c) => {
  needActivity(c);
  const r = await activityCsv(c.env, new URL(c.req.url).searchParams);
  return new Response(r.body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="gema-fleet-activity-${r.date}.csv"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Activity-Rows': String(r.rows), 'X-Activity-Truncated': r.truncated ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Activity-Rows, X-Activity-Truncated' } });
});

authed.route('/', api);
app.route('/api', authed);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(backupStep(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
export { app };
void COOKIE; void getCookie; void zId;
