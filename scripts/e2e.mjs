// End-to-end check in a real browser, against a throwaway local database. Nothing here touches Cloudflare.
//   npm run e2e            runs everything at 390 px and 1280 px, light and dark
// Uses the Chrome that is installed on the machine (set CHROME_PATH to point at another one), so no browser download is needed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8799, BASE = `http://localhost:${PORT}`;
const SHOTS = 'docs/screenshots';
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const log = (...a) => console.log(...a);

/* ---------- a real PNG for the "photo" ---------- */
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 120; } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = png(2400, 1800); // big enough to exercise the client-side downscale

/* ---------- server ---------- */
let server;
async function startServer() {
  rmSync('.wrangler/e2e', { recursive: true, force: true });
  const common = ['--persist-to', '.wrangler/e2e'];
  log('Building...');
  let r = sh('npx', ['vite', 'build'], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr);
  r = sh('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', ...common], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr);
  // the scripts use the default local state, so point them at the e2e one through an env var wrangler understands
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), ...common, '--var', 'PBKDF2_ITERATIONS:2000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 90; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 1000)); if (i === 89) throw new Error('server did not start\n' + out); }
}
function d1(file) { const r = sh('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/e2e', '--file', file, '--yes'], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr); }

/* ---------- checks ---------- */
const results = [];
let failures = 0;
async function check(page, name, fn, tag) {
  try { await fn(); results.push(['ok', tag, name]); log('  ok  ', name); }
  catch (e) {
    failures++; results.push(['FAIL', tag, name, String(e.message).split('\n')[0]]); log('  FAIL', name, '-', String(e.message).split('\n')[0]);
    try { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/FAIL-${tag}-${name.replace(/\W+/g, '-')}.png` }); } catch { /* ignore */ }
  }
}
const noOverflow = async (page) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => { if (e.closest('.tscroll,.kan,.mvlist')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).slice(0, 3).map((e) => e.tagName + '.' + e.className + '#' + e.id) }));
  if (o.sw > o.iw + 1) throw new Error(`horizontal overflow: page ${o.sw}px in ${o.iw}px viewport ${o.wide.join(' ')}`);
};

async function login(page, email, password) {
  await page.goto(BASE + '/#board');
  await page.waitForSelector('#lg-email');
  await page.fill('#lg-email', email); await page.fill('#lg-pass', password);
  await page.click('#lg-submit');
}
async function forcedChange(page, from, to) {
  await page.waitForSelector('#cp-new');
  await page.fill('#cp-cur', from); await page.fill('#cp-new', to); await page.fill('#cp-new2', to);
  await page.click('#cp-submit');
}
async function logout(page) { await page.click('#logoutBtn'); await page.waitForSelector('#lg-email'); }
const toastText = (page) => page.locator('#toasts').innerText();

/* ---------- the walk-through ---------- */
async function adminFlow(page, cfg, tag, secrets, errs) {
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}-${n}.png`, fullPage: false });
  await check(page, 'login page, wrong password', async () => {
    await page.goto(BASE + '/'); await page.waitForSelector('#lg-email');
    await shot('01-login');
    await noOverflow(page);
    await page.fill('#lg-email', secrets.adminEmail); await page.fill('#lg-pass', 'not-the-password'); await page.click('#lg-submit');
    await page.waitForSelector('#lg-err:not([hidden])');
    errs.length = 0; // the browser logs the deliberate 401 of a wrong password; that is not a fault
  }, tag);
  await check(page, 'login and board', async () => {
    await page.fill('#lg-pass', secrets.adminPass);
    await page.click('#lg-submit');
    if (secrets.adminForced) { await shot('02-forced-change'); await noOverflow(page); await forcedChange(page, secrets.adminPass, secrets.adminPass2); secrets.adminForced = false; secrets.adminPass = secrets.adminPass2; }
    await page.waitForSelector('.tile');
    if ((await page.locator('.tile').count()) < 10) throw new Error('board shows too few units');
    await shot('03-board'); await noOverflow(page);
  }, tag);
  await check(page, 'no role switcher, no load-sample button', async () => {
    if (await page.locator('#roleSel').count()) throw new Error('role switcher present');
    await page.goto(BASE + '/#setup'); await page.waitForSelector('#removeSample');
    if (await page.locator('#loadSample').count()) throw new Error('load sample button present');
    await shot('04-setup'); await noOverflow(page);
  }, tag);
  await check(page, 'dispatch wall and unit drawer', async () => {
    await page.goto(BASE + '/#dispatch'); await page.waitForSelector('.wt', { timeout: 8000 });
    await shot('05-dispatch'); await noOverflow(page);
    const t = page.locator('[data-act="open-unit"]').first();
    await t.click(); await page.waitForSelector('#drawerRoot .drawer');
    await shot('06-dispatch-drawer');
    await page.click('#dClose'); await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
  }, tag);
  await check(page, 'vehicle detail and back', async () => {
    await page.goto(BASE + '/#vehicles'); await page.waitForSelector('[data-act="open-vehicle"]');
    await page.locator('[data-act="open-vehicle"]').first().click();
    await page.waitForSelector('#navBack');
    await shot('07-vehicle'); await noOverflow(page);
    for (const tab of ['pm', 'issues', 'history', 'costs']) { const b = page.locator(`[data-act="vtab"][data-tab="${tab}"]`); if (await b.count()) { await b.click(); } }
    await page.click('#navBack');
    await page.waitForFunction(() => location.hash === '#vehicles');
  }, tag);
  let issueTitle = `Siren fault ${tag}`;
  await check(page, 'report a problem with a photo', async () => {
    await page.goto(BASE + '/#vehicles'); await page.waitForSelector('[data-act="open-vehicle"]');
    await page.locator('[data-act="open-vehicle"]').first().click();
    await page.waitForSelector('#vReport'); await page.click('#vReport');
    await page.waitForSelector('#issueForm');
    await page.fill('#ri-title', issueTitle); await page.fill('#ri-desc', 'Siren cuts out on bumps.');
    await page.setInputFiles('#ri-photos', { name: 'siren.png', mimeType: 'image/png', buffer: PHOTO });
    await page.waitForSelector('#ri-thumbs img, #ri-thumbs .thumb', { timeout: 10000 });
    await shot('08-report-problem');
    await page.click('#ri-submit');
    await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await page.goto(BASE + '/#issues');
    await page.getByText(issueTitle).first().waitFor();
    await page.getByText(issueTitle).first().click();
    await page.waitForSelector('#drawerRoot .drawer');
    await page.waitForSelector('#attSec img', { timeout: 10000 });
    const ok = await page.evaluate(async () => { const im = document.querySelector('#attSec img'); await im.decode().catch(() => {}); return im.naturalWidth > 0 && im.naturalWidth <= 1600; });
    if (!ok) throw new Error('uploaded photo did not load or was not downscaled to 1600 px');
    await shot('09-issue-with-photo'); await noOverflow(page);
  }, tag);
  await check(page, 'work order lifecycle', async () => {
    await page.click('#issue-wo');
    await page.waitForSelector('#woForm'); await shot('10-new-wo');
    await page.click('#wf-submit');
    await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await page.waitForSelector('[data-act="open-wo"]');
    await page.locator('[data-act="open-wo"]').first().click();
    await page.waitForSelector('#lineForm');
    await page.fill('#ln-desc', 'Replace siren relay'); await page.fill('#ln-cost', '12000'); await page.fill('#ln-qty', '2');
    await page.click('#ln-add');
    await page.waitForSelector('.lines td:has-text("Replace siren relay")');
    for (const [btn, extra] of [['approve'], ['schedule', async () => { await page.fill('#wo-sched', '2030-01-15'); }], ['start'], ['complete', async () => { const h = await page.evaluate(() => document.querySelector('#wo-hrs').value || ''); await page.fill('#wo-hrs', String(Number(h || 0) + 5)); }], ['close']]) {
      const b = page.locator(`#wo-btn-${btn}`);
      if (!(await b.count())) { if (btn === 'approve') continue; throw new Error('missing button ' + btn); }
      if (extra) await extra();
      await b.click();
      await page.waitForTimeout(500);
    }
    await page.waitForFunction(() => /Closed/i.test(document.querySelector('#dBody')?.innerText || ''));
    await shot('11-wo-closed'); await noOverflow(page);
    await page.click('#dClose');
  }, tag);
  await check(page, 'move units', async () => {
    await page.goto(BASE + '/#board'); await page.waitForSelector('#boardMove'); await page.click('#boardMove');
    await page.waitForSelector('#moveForm');
    await page.locator('input[name=mvu]').first().check();
    const opts = await page.$$eval('#mv-to option', (o) => o.map((x) => x.value).filter(Boolean));
    const first = await page.locator('input[name=mvu]').first().getAttribute('id');
    const cur = await page.evaluate((id) => { const v = document.getElementById(id).closest('.mvlist'); return null; }, first);
    void cur;
    // choose a base the unit is not in
    for (const o of opts) { await page.selectOption('#mv-to', o); if (!(await page.locator('#mv-submit').isDisabled())) break; }
    await shot('12-move-units');
    await page.click('#mv-submit');
    await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    if (!/moved/.test(await toastText(page))) throw new Error('no moved toast');
  }, tag);
  await check(page, 'users: create crew, dispatcher, mechanic', async () => {
    await page.goto(BASE + '/#users'); await page.waitForSelector('#addUser');
    await shot('13-users'); await noOverflow(page);
    const mk = async (name, email, role) => {
      await page.click('#addUser'); await page.waitForSelector('#userForm');
      await page.fill('#uf-name', name); await page.fill('#uf-email', email); await page.selectOption('#uf-role', role);
      if (role === 'crew' || role === 'base_supervisor') await page.locator('input[name=ufb]').first().check();
      if (role === 'mechanic') await page.selectOption('#uf-mech', { index: 1 });
      await page.click('#uf-save');
      await page.waitForSelector('#tempPw');
      const pw = (await page.textContent('#tempPw')).trim();
      if (name.startsWith('Crew')) await shot('14-temp-password');
      await page.click('#pwDone'); await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
      return pw;
    };
    secrets.crew = { email: `crew-${tag}@example.org`, pass: await mk('Crew ' + tag, `crew-${tag}@example.org`, 'crew') };
    secrets.disp = { email: `disp-${tag}@example.org`, pass: await mk('Dispatcher ' + tag, `disp-${tag}@example.org`, 'dispatcher') };
    secrets.mech = { email: `mech-${tag}@example.org`, pass: await mk('Mechanic ' + tag, `mech-${tag}@example.org`, 'mechanic') };
    if (!(await page.getByText(`crew-${tag}@example.org`).count())) throw new Error('new user not listed');
    if (!(await page.getByText('hand temporary passwords', { exact: false }).count()) && !(await page.getByText('Give it to the person yourself').count())) throw new Error('hand-over notice missing');
  }, tag);
  await check(page, 'backups panel (system administrator)', async () => {
    await page.waitForSelector('#backupsPanel');
    await page.click('#backupNow');
    await page.waitForSelector('#backupsPanel a[download]', { timeout: 30000 });
    await page.locator('#backupsPanel').scrollIntoViewIfNeeded();
    await shot('15-backups');
  }, tag);
  await check(page, 'logout', async () => { await logout(page); }, tag);
}

/** Google Fonts is answered locally so the run works without internet access; the CSP still lists those hosts. */
async function newCtx(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return ctx;
}
async function roleFlow(browser, ctxOpts, tag, who, secrets, kind) {
  const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}-${n}.png` });
  const rec = secrets[who];
  await check(page, `${kind}: first login forces a new password`, async () => {
    await login(page, rec.email, rec.pass);
    await forcedChange(page, rec.pass, rec.pass + '-new-9');
    rec.pass = rec.pass + '-new-9';
    await page.waitForSelector(kind === 'dispatcher' ? '.wall, [data-act="open-unit"]' : '.tile', { timeout: 10000 });
  }, tag);
  if (kind === 'crew') {
    await check(page, 'crew: restricted UI', async () => {
      await shot('20-crew-board'); await noOverflow(page);
      if (await page.locator('#nav a[data-r="users"]').count()) throw new Error('Users in nav');
      if (await page.locator('#addVehicle, #boardMove').count()) throw new Error('crew sees manager buttons');
      await page.goto(BASE + '/#users'); await page.waitForTimeout(300);
      if (await page.locator('#addUser').count()) throw new Error('crew reached users screen');
      await page.goto(BASE + '/#setup'); await page.waitForSelector('#view h1');
      if (await page.locator('#addBase, #addProg, #st-save').count()) throw new Error('crew can edit setup');
      await shot('21-crew-setup-readonly');
      await page.goto(BASE + '/#board');
      await page.waitForSelector('#boardReport'); // crew can report a problem
    }, tag);
  }
  if (kind === 'dispatcher') {
    await check(page, 'dispatcher: Dispatch only', async () => {
      await shot('22-dispatcher'); await noOverflow(page);
      const links = await page.$$eval('#nav a', (a) => a.map((x) => x.dataset.r));
      if (links.join() !== 'dispatch') throw new Error('nav is ' + links.join());
      await page.goto(BASE + '/#board'); await page.waitForTimeout(400);
      if (!(await page.evaluate(() => document.body.classList.contains('wall')))) throw new Error('dispatcher left the dispatch screen');
      // the dispatcher feed is redacted: no cost, parts or notes are fetched
      const r = await page.evaluate(async () => (await fetch('/api/sync?since=0', { credentials: 'same-origin' })).json());
      if (r.data.parts?.length) throw new Error('dispatcher received parts');
      if ((r.data.workOrders || []).some((w) => (w.lines || []).length || w.notes)) throw new Error('dispatcher received work order lines or notes');
      errs.length = 0; // the next request is refused on purpose and the browser logs that
      const denied = await page.evaluate(async () => (await fetch('/api/users', { credentials: 'same-origin' })).status);
      if (denied !== 403) throw new Error('users API status ' + denied);
      errs.length = 0;
    }, tag);
  }
  if (kind === 'mechanic') {
    await check(page, 'mechanic: only own work orders', async () => {
      await page.goto(BASE + '/#work-orders'); await page.waitForSelector('#view h1');
      const r = await page.evaluate(async () => ({ me: (await (await fetch('/api/auth/session', { credentials: 'same-origin' })).json()).user, sync: await (await fetch('/api/sync?since=0', { credentials: 'same-origin' })).json() }));
      const wos = r.sync.data.workOrders || [];
      if (!r.me.mechanicId) throw new Error('mechanic has no linked mechanic');
      // Mechanics only receive work orders assigned to them.
      const other = wos.find((w) => w.mechanicId !== r.me.mechanicId);
      if (other) throw new Error('mechanic received work order ' + other.number + ' assigned to someone else');
      await shot('23-mechanic-wos');
    }, tag);
  }
  await check(page, `${kind}: no console errors`, async () => { if (errs.length) throw new Error(errs.slice(0, 3).join(' | ')); }, tag);
  await ctx.close();
}

/* ---------- main ---------- */
(async () => {
  mkdirSync(SHOTS, { recursive: true });
  for (const f of ['FAIL']) void f;
  await startServer();
  // seed demo data and the first admin directly in the e2e database
  const sql = sh('npx', ['tsx', 'scripts/e2e-seed.ts'], { encoding: 'utf8' });
  if (sql.status) throw new Error(sql.stderr);
  writeFileSync('.wrangler/e2e-seed.sql', sql.stdout); d1('.wrangler/e2e-seed.sql');
  rmSync('.wrangler/e2e-seed.sql');

  const exe = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
  const secrets = { adminEmail: 'admin@example.org', adminPass: 'Temp-pass-1234', adminPass2: 'E2E-admin-pass-77', adminForced: true };
  const configs = [
    { tag: 'w1280-light', viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
    { tag: 'w1280-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
    { tag: 'w390-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, hasTouch: true },
    { tag: 'w390-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true },
  ];
  for (const cfg of configs.filter((c) => !process.env.E2E_ONLY || c.tag.includes(process.env.E2E_ONLY))) {
    log(`\n== ${cfg.tag}`);
    const { tag, ...ctxOpts } = cfg;
    const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(8000);
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
    let expected401 = 0; // the deliberate wrong-password login returns 401, which the browser logs as a console error
    page.on('response', (r) => { if (r.status() === 401 && r.request().method() === 'POST' && r.url().endsWith('/api/auth/login')) expected401++; });
    await adminFlow(page, cfg, tag, secrets, errs);
    await check(page, 'admin: no console errors', async () => { let skip = expected401; const real = errs.filter((e) => !(skip > 0 && /401/.test(e) && skip--)); if (real.length) throw new Error(real.slice(0, 3).join(' | ')); }, tag);
    await ctx.close();
    await roleFlow(browser, ctxOpts, tag, 'crew', secrets, 'crew');
    await roleFlow(browser, ctxOpts, tag, 'disp', secrets, 'dispatcher');
    await roleFlow(browser, ctxOpts, tag, 'mech', secrets, 'mechanic');
  }
  await browser.close();
  server.kill('SIGTERM'); sh('pkill', ['-f', 'workerd']);
  log(`\n${results.filter((r) => r[0] === 'ok').length} checks passed, ${failures} failed.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server?.kill('SIGTERM'); } catch { /* ignore */ } process.exit(2); });
