// End-to-end check in a real browser, against a throwaway local database. Nothing here touches Cloudflare.
//   npm run e2e            runs everything at 390 px and 1280 px, light and dark
// Uses the Chrome that is installed on the machine (set CHROME_PATH to point at another one), so no browser download is needed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

let PORT = 8799, BASE = `http://localhost:${PORT}`, PERSIST = '.wrangler/e2e';
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
/** vars: extra --var NAME:value pairs. `email: true` turns on the development mail sink (see docs/EMAIL.md) so emails can be read back. */
async function startServer({ port = 8799, persist = '.wrangler/e2e', email = false } = {}) {
  PORT = port; BASE = `http://localhost:${PORT}`; PERSIST = persist;
  rmSync(persist, { recursive: true, force: true });
  const common = ['--persist-to', persist];
  const vars = ['--var', 'PBKDF2_ITERATIONS:2000', '--var', 'SUPERUSER_EMAILS:admin@example.org', ...(email ? ['--var', `APP_URL:${BASE}`, '--var', 'RESEND_API_KEY:re_e2e_not_a_real_key', '--var', 'MAIL_FROM:GEMA Fleet <no-reply@gema.test>', '--var', 'MAIL_SINK:1'] : [])];
  log('Building...');
  let r = sh('npx', ['vite', 'build'], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr);
  r = sh('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', ...common], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr);
  // the scripts use the default local state, so point them at the e2e one through an env var wrangler understands
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), ...common, ...vars], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 90; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 1000)); if (i === 89) throw new Error('server did not start\n' + out); }
}
function d1(file) { const r = sh('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--file', file, '--yes'], { stdio: 'pipe' }); if (r.status) throw new Error(r.stdout + r.stderr); }

/* ---------- checks ---------- */
const results = [];
let failures = 0;
async function check(page, name, fn, tag) {
  try { await fn(); results.push(['ok', tag, name]); log('  ok  ', name); }
  catch (e) {
    if (process.env.E2E_DEBUG) console.log(String(e.stack || e.message).slice(0, 3000));
    failures++; results.push(['FAIL', tag, name, String(e.message).split('\n')[0]]); log('  FAIL', name, '-', String(e.message).split('\n')[0]);
    try { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/FAIL-${tag}-${name.replace(/\W+/g, '-')}.png` }); } catch { /* ignore */ }
  }
}
const noOverflow = async (page) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => { if (e.closest('.tscroll,.kan,.mvlist')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).slice(0, 3).map((e) => e.tagName + '.' + e.className + '#' + e.id) }));
  if (o.sw > o.iw + 1) throw new Error(`horizontal overflow: page ${o.sw}px in ${o.iw}px viewport ${o.wide.join(' ')}`);
};

async function login(page, email, password, agency = 'GEMA') {
  await page.goto(BASE + '/#board');
  await page.waitForSelector('#lg-email');
  await page.fill('#lg-agency', agency);
  await page.fill('#lg-email', email); await page.fill('#lg-pass', password);
  await page.click('#lg-submit');
}
async function forcedChange(page, from, to) {
  await page.waitForSelector('#cp-new');
  await page.fill('#cp-cur', from); await page.fill('#cp-new', to); await page.fill('#cp-new2', to);
  await page.click('#cp-submit');
}
async function logout(page) {
  if (await page.locator('#menuBtn').isVisible()) await page.click('#menuBtn'); // below 1024 px the sidebar is a drawer
  await page.click('#userMenuBtn'); await page.click('#logoutBtn'); await page.waitForSelector('#lg-email');
}
const toastText = (page) => page.locator('#toasts').innerText();

/* ---------- the walk-through ---------- */
async function adminFlow(page, cfg, tag, secrets, errs) {
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}-${n}.png`, fullPage: false });
  await check(page, 'login page, wrong password', async () => {
    await page.goto(BASE + '/'); await page.waitForSelector('#lg-email');
    await shot('01-login');
    await noOverflow(page);
    await page.fill('#lg-agency', 'GEMA'); await page.fill('#lg-email', secrets.adminEmail); await page.fill('#lg-pass', 'not-the-password'); await page.click('#lg-submit');
    await page.waitForSelector('#lg-err:not([hidden])');
    errs.length = 0; // the browser logs the deliberate 401 of a wrong password; that is not a fault
  }, tag);
  await check(page, 'login and board', async () => {
    await page.fill('#lg-pass', secrets.adminPass);
    await page.click('#lg-submit');
    if (secrets.adminForced) { await shot('02-forced-change'); await noOverflow(page); await forcedChange(page, secrets.adminPass, secrets.adminPass2); secrets.adminForced = false; secrets.adminPass = secrets.adminPass2; }
    await page.waitForSelector('.urow');
    if ((await page.locator('.urow').count()) < 10) throw new Error('board shows too few units');
    await shot('03-board'); await noOverflow(page);
  }, tag);
  await check(page, 'no role switcher, no load-sample button', async () => {
    if (await page.locator('#roleSel').count()) throw new Error('role switcher present');
    await page.goto(BASE + '/#setup'); await page.waitForSelector('#removeSample');
    if (await page.locator('#loadSample').count()) throw new Error('load sample button present');
    await shot('04-setup'); await noOverflow(page);
  }, tag);
  await check(page, 'dispatch wall and unit drawer', async () => {
    await page.goto(BASE + '/#dispatch'); await page.waitForSelector('.dcell', { timeout: 8000 });
    await shot('05-dispatch'); await noOverflow(page);
    // the top bar stays on Dispatch so the tabs can still be switched
    if (!(await page.locator('#topbar').isVisible())) throw new Error('top bar missing on dispatch');
    if (await page.locator('#menuBtn').isVisible()) { await page.click('#menuBtn'); await page.waitForSelector('#nav a[data-r="board"]', { state: 'visible' }); await page.keyboard.press('Escape'); await page.waitForSelector('#nav a', { state: 'hidden' }); }
    else if (!(await page.locator('#nav a[data-r="board"]').isVisible())) throw new Error('sidebar missing on dispatch');
    const t = page.locator('[data-act="open-unit"]').first();
    await t.click(); await page.waitForSelector('#drawerRoot .drawer');
    await shot('06-dispatch-drawer');
    await page.click('#dClose'); await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
  }, tag);
  await check(page, 'dispatch wall display: toggle, exit button, Esc, remembered', async () => {
    await page.click('#wallToggle');
    await page.waitForFunction(() => document.body.classList.contains('wallmode'));
    if (await page.locator('#topbar').isVisible() || await page.locator('#sidebar').isVisible()) throw new Error('chrome still visible in wall mode');
    if (!(await page.locator('#wallExit').isVisible())) throw new Error('no exit button');
    await shot('05w-dispatch-wall'); await noOverflow(page);
    await page.reload(); await page.waitForSelector('.dcell');
    if (!(await page.evaluate(() => document.body.classList.contains('wallmode')))) throw new Error('wall mode not remembered');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('wallmode'));
    if (!(await page.locator('#topbar').isVisible())) throw new Error('top bar not back after Esc');
    await page.click('#wallToggle'); await page.click('#wallExit');
    await page.waitForFunction(() => !document.body.classList.contains('wallmode'));
    await page.evaluate(() => { try { localStorage.removeItem('gema-fleet-wall'); } catch { /* ignore */ } });
  }, tag);
  await check(page, 'sidebar: collapse is remembered (desktop) / drawer traps focus (mobile)', async () => {
    await page.goto(BASE + '/#board'); await page.waitForSelector('.urow');
    if (await page.locator('#menuBtn').isVisible()) {
      await page.click('#menuBtn');
      const inside = async () => page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
      for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); if (!(await inside())) throw new Error('focus left the open menu'); }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('navopen'));
      if (!(await page.evaluate(() => document.activeElement.id === 'menuBtn'))) throw new Error('focus not returned to the menu button');
      await page.click('#menuBtn'); await page.click('#nav a[data-r="vehicles"]');
      await page.waitForFunction(() => location.hash === '#vehicles' && !document.body.classList.contains('navopen'));
    } else {
      await page.click('#collapseBtn');
      const w = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
      if (Math.round(w) !== 64) throw new Error('rail width ' + w);
      await noOverflow(page);
      await page.reload(); await page.waitForSelector('.urow');
      if (!(await page.evaluate(() => document.body.classList.contains('rail')))) throw new Error('rail not remembered');
      await page.click('#collapseBtn');
      if (Math.round(await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width)) !== 232) throw new Error('did not expand');
    }
  }, tag);
  await check(page, 'vehicle detail and back', async () => {
    await page.goto(BASE + '/#vehicles'); await page.waitForSelector('[data-act="open-vehicle"]');
    await page.locator('[data-act="open-vehicle"]').first().click();
    await page.waitForSelector('#navBack');
    await shot('07-vehicle'); await noOverflow(page);
    await page.click('#vMoreBtn'); await page.waitForSelector('#vMorePop', { state: 'visible' });
    await page.keyboard.press('Escape'); await page.waitForSelector('#vMorePop', { state: 'hidden' });
    for (const tab of ['pm', 'issues', 'history', 'costs']) { const b = page.locator(`[data-act="vtab"][data-tab="${tab}"]`); if (await b.count()) { await b.click(); } }
    await page.click('#navBack');
    await page.waitForFunction(() => location.hash === '#vehicles');
  }, tag);
  const NOTE = 'Photo and PDF uploads are turned off for now.';
  const setUploadsInSetup = async (on) => {
    await page.goto(BASE + '/#setup'); await page.waitForSelector('#ft-uploads');
    if ((await page.locator('#ft-uploads').isChecked()) !== on) { await page.locator('#ft-uploads').setChecked(on); await page.click('#ft-save'); await page.waitForFunction(() => /Photo and PDF uploads turned o/.test(document.querySelector('#toasts')?.innerText || '')); }
  };
  const disabledBtn = async (loc) => {
    if (!(await loc.isVisible())) throw new Error('not visible');
    if (!(await loc.isDisabled())) throw new Error('not disabled');
    if ((await loc.getAttribute('aria-disabled')) !== 'true') throw new Error('no aria-disabled');
    if (!/turned off for now/.test((await loc.getAttribute('title')) || '')) throw new Error('no tooltip');
  };
  await check(page, 'super user: Setup shows the Features panel, uploads OFF by default, no uploads switch in the ordinary settings', async () => {
    await page.goto(BASE + '/#setup'); await page.waitForSelector('#featuresPanel');
    if (await page.locator('#ft-uploads').isChecked()) throw new Error('uploads switch is on by default');
    if (!/Photo and PDF uploads/.test(await page.locator('label[for=ft-uploads]').innerText())) throw new Error('label');
    if (!/upload buttons stay visible but disabled/.test(await page.locator('label[for=ft-uploads]').innerText())) throw new Error('help text');
    if (await page.locator('#settingsForm #ft-uploads, #st-uploads').count()) throw new Error('uploads switch in ordinary settings');
    await page.locator('#featuresPanel').scrollIntoViewIfNeeded();
    await shot('04a-setup-features-uploads-off'); await noOverflow(page);
  }, tag);
  await check(page, 'uploads off: report a problem shows disabled Add photo and Attach PDF, and still saves', async () => {
    await page.goto(BASE + '/#vehicles'); await page.waitForSelector('[data-act="open-vehicle"]');
    await page.locator('[data-act="open-vehicle"]').first().click();
    await page.waitForSelector('#vReport'); await page.click('#vReport');
    await page.waitForSelector('#issueForm');
    if (await page.locator('#issueForm input[type=file]').count()) throw new Error('a file picker exists while uploads are off');
    const photo = page.locator('#issueForm button.attlabel', { hasText: 'Add photo' }), pdf = page.locator('#issueForm button.attlabel', { hasText: 'Attach PDF' });
    await disabledBtn(photo); await disabledBtn(pdf);
    await photo.click({ force: true, timeout: 1000 }).catch(() => {}); // a disabled button must do nothing
    if (await page.locator('#ri-thumbs img').count()) throw new Error('clicking a disabled button added a photo');
    if ((await page.locator('#upnote').innerText()).trim() !== NOTE) throw new Error('note text: ' + (await page.locator('#upnote').innerText()));
    if (!(await page.locator('#upnote svg.ic').count())) throw new Error('no info icon');
    await page.fill('#ri-title', `Wiper fault ${tag}`); await page.fill('#ri-desc', 'Left wiper sticks.');
    await shot('08a-report-uploads-off'); await noOverflow(page);
    await page.click('#ri-submit');
    await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await page.goto(BASE + '/#issues'); await page.getByText(`Wiper fault ${tag}`).first().click();
    await page.waitForSelector('#attSec');
    await disabledBtn(page.locator('#attSec button.attlabel', { hasText: 'Attach file' }));
    if (!/turned off for now/.test(await page.locator('#attSec .upnote').innerText())) throw new Error('no note in the problem drawer');
    if (await page.locator('#attSec input[type=file]').count()) throw new Error('file picker in drawer');
    await page.keyboard.press('Escape');
  }, tag);
  await check(page, 'uploads off: work order drawer shows the disabled attach control', async () => {
    await page.goto(BASE + '/#work-orders'); await page.waitForSelector('[data-act="open-wo"]');
    await page.locator('[data-act="open-wo"]').first().click();
    await page.waitForSelector('#attSec');
    await disabledBtn(page.locator('#attSec button.attlabel', { hasText: 'Attach file' }));
    if (!/turned off for now/.test(await page.locator('#attSec .upnote').innerText())) throw new Error('no note in the work order drawer');
    await page.locator('#attSec').scrollIntoViewIfNeeded();
    await shot('10a-wo-uploads-off'); await noOverflow(page);
    await page.keyboard.press('Escape');
  }, tag);
  await check(page, 'super user: turn uploads on in Features', async () => {
    await setUploadsInSetup(true);
    await page.reload(); await page.waitForSelector('#ft-uploads');
    if (!(await page.locator('#ft-uploads').isChecked())) throw new Error('switch did not stick');
    await shot('04b-setup-uploads-on');
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
  await check(page, 'users: create crew, dispatcher, mechanic with chosen passwords', async () => {
    await page.goto(BASE + '/#users'); await page.waitForSelector('#addUser');
    await shot('13-users'); await noOverflow(page);
    if (!(await page.locator('#usersNote').innerText()).includes('Email isn’t set up, so you choose people’s passwords here')) throw new Error('email-not-set-up note missing');
    const mk = async (name, email, role, how) => {
      await page.click('#addUser'); await page.waitForSelector('#userForm');
      if (await page.locator('#uf-how-invite').count()) throw new Error('invite option offered although email is not set up');
      await page.fill('#uf-name', name); await page.fill('#uf-email', email); await page.selectOption('#uf-role', role);
      if (role === 'crew' || role === 'base_supervisor') await page.locator('input[name=ufb]').first().check();
      if (role === 'mechanic') await page.selectOption('#uf-mech', { index: 1 });
      let pw;
      if (how === 'generate') {
        await page.click('#uf-gen');
        pw = await page.inputValue('#uf-pw');
        if (pw !== (await page.inputValue('#uf-pw2')) || !/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2}$/.test(pw)) throw new Error('generated password looks wrong: ' + pw);
        await shot('14-add-user-password');
        await noOverflow(page);
      } else {
        pw = `Typed-${role}-${tag}-9`;
        await page.fill('#uf-pw', pw); await page.fill('#uf-pw2', pw);
        if ((await page.getAttribute('#uf-pw', 'type')) !== 'password') throw new Error('password not hidden');
        await page.click('#uf-show');
        if ((await page.getAttribute('#uf-pw', 'type')) !== 'text') throw new Error('Show did not reveal the password');
      }
      await page.click('#uf-save');
      await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
      if (!/Account created\. Give .* their password\./.test(await toastText(page))) throw new Error('no confirmation toast');
      if (await page.getByText(pw).count()) throw new Error('password is shown again after creation');
      return pw;
    };
    secrets.crew = { email: `crew-${tag}@example.org`, pass: await mk('Crew ' + tag, `crew-${tag}@example.org`, 'crew', 'generate') };
    secrets.disp = { email: `disp-${tag}@example.org`, pass: await mk('Dispatcher ' + tag, `disp-${tag}@example.org`, 'dispatcher') };
    secrets.mech = { email: `mech-${tag}@example.org`, pass: await mk('Mechanic ' + tag, `mech-${tag}@example.org`, 'mechanic') };
    if (!(await page.getByText(`crew-${tag}@example.org`).count())) throw new Error('new user not listed');
  }, tag);
  await check(page, 'users: super user badge, Permissions drawer for a crew member, a fleet manager and a system administrator are created', async () => {
    await page.goto(BASE + '/#users'); await page.waitForSelector('#usersTable');
    const me = page.locator('#usersTable tr', { hasText: secrets.adminEmail });
    if (!/Super user/.test(await me.innerText())) throw new Error('no Super user badge');
    if (await me.getByRole('button', { name: 'Permissions' }).count()) throw new Error('Permissions offered for yourself');
    if (!/Super user/.test(await page.locator('#userbar').textContent())) throw new Error('no Super user label in the sidebar');
    const crewRow = page.locator('#usersTable tr', { hasText: secrets.crew.email });
    await crewRow.getByRole('button', { name: 'Permissions' }).click();
    await page.waitForSelector('#permsForm');
    if ((await page.locator('#permsForm input[data-perm]').count()) < 19) throw new Error('too few permission switches');
    if (await page.locator('#permsForm input[data-perm]:disabled').count()) throw new Error('the super user should be able to change every switch');
    if (!(await page.locator('#perm-report').isChecked()) || (await page.locator('#perm-move').isChecked())) throw new Error('crew defaults wrong');
    await page.locator('#perm-move').check();
    if (!(await page.locator('#chg-move').isVisible())) throw new Error('no Changed badge');
    await page.click('#rst-move'); if (await page.locator('#perm-move').isChecked()) throw new Error('reset to role default did not work');
    await shot('16-permissions-drawer'); await noOverflow(page);
    await page.click('#perm-cancel'); await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    // a fleet manager and a non-super system administrator, for the checks further down (created through the API as the super user)
    for (const [k, role] of [['fm', 'fleet_manager'], ['sysadm', 'system_admin']]) {
      secrets[k] = { email: `${k}-${tag}@example.org`, pass: `Typed-${k}-${tag}-9` };
      const st = await page.evaluate(async ([email, password, role]) => (await fetch('/api/users', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gema-fleet' }, body: JSON.stringify({ email, name: 'Person ' + email, role, password }) })).status, [secrets[k].email, secrets[k].pass, role]);
      if (st !== 200) throw new Error('could not create ' + role + ': ' + st);
    }
  }, tag);
  await check(page, 'users: Set password for someone, no email actions without email', async () => {
    const row = page.locator('#usersTable tr', { hasText: `disp-${tag}@example.org` });
    if (await row.getByRole('button', { name: /reset link|resend invite/i }).count()) throw new Error('email actions shown although email is not set up');
    await row.getByRole('button', { name: 'Set password' }).click();
    await page.waitForSelector('#setPwForm'); await shot('14b-set-password'); await noOverflow(page);
    await page.fill('#sp-pw', 'short'); await page.fill('#sp-pw2', 'short'); await page.click('#sp-save');
    if (!/at least 10/i.test(await toastText(page))) throw new Error('weak password not refused');
    await page.click('#sp-gen');
    secrets.disp.pass = await page.inputValue('#sp-pw');
    await page.click('#sp-save');
    await page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    if (!/Password set\./.test(await toastText(page))) throw new Error('no confirmation toast');
    // your own row has no Set password button
    if (await page.locator('#usersTable tr', { hasText: secrets.adminEmail }).getByRole('button', { name: 'Set password' }).count()) throw new Error('Set password offered for yourself');
  }, tag);
  await check(page, 'backups panel (system administrator)', async () => {
    await page.waitForSelector('#backupsPanel');
    await page.click('#backupNow');
    await page.waitForSelector('#backupsPanel a[download]', { timeout: 30000 });
    await page.locator('#backupsPanel').scrollIntoViewIfNeeded().catch(() => {}); // the panel can redraw while it loads
    await shot('15-backups');
  }, tag);
  await check(page, 'uploads turned off while a form is open: the problem is saved, a message explains, then back to default off', async () => {
    await page.goto(BASE + '/#vehicles'); await page.waitForSelector('[data-act="open-vehicle"]');
    await page.locator('[data-act="open-vehicle"]').first().click();
    await page.waitForSelector('#vReport'); await page.click('#vReport'); await page.waitForSelector('#issueForm');
    await page.fill('#ri-title', `Race fault ${tag}`);
    await page.setInputFiles('#ri-photos', { name: 'race.png', mimeType: 'image/png', buffer: png(64, 48) });
    await page.waitForSelector('#ri-thumbs img');
    await page.evaluate(async () => { const r = await fetch('/api/features', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gema-fleet' }, body: JSON.stringify({ uploads: false }) }); if (!r.ok) throw new Error('settings ' + r.status); });
    await page.click('#ri-submit');
    await page.waitForFunction(() => /turned off for now/.test(document.querySelector('#toasts')?.innerText || ''));
    await page.goto(BASE + '/#issues'); await page.getByText(`Race fault ${tag}`).first().waitFor();
    await setUploadsInSetup(false); // leave the database as a fresh install would be
    for (let i = errs.length - 1; i >= 0; i--) if (/403/.test(errs[i])) errs.splice(i, 1); // the browser logs the deliberate 403 as a console error
  }, tag);
  await check(page, 'logout', async () => { await logout(page); }, tag);
}

/** A fleet manager and a non-super system administrator: no Features panel, disabled upload buttons, hierarchy in the Users screen; and a permission change reaching a crew member's open screen. */
async function managersFlow(browser, ctxOpts, tag, secrets) {
  const mk = async (who) => {
    const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(10000);
    const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
    await login(page, secrets[who].email, secrets[who].pass); await page.waitForSelector('.urow', { timeout: 15000 });
    return { ctx, page, errs };
  };
  const mkSuper = async () => {
    const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(10000);
    const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
    await login(page, secrets.adminEmail, secrets.adminPass); await page.waitForSelector('.urow', { timeout: 15000 });
    return { ctx, page, errs };
  };
  const fm = await mk('fm'), crew = await mk('crew'), sa = await mk('sysadm');
  const su = await mkSuper();
  const shot = (pg, n) => pg.screenshot({ path: `${SHOTS}/${tag}-${n}.png` });
  await check(fm.page, 'fleet manager: no Features panel and no uploads switch in Setup', async () => {
    await fm.page.goto(BASE + '/#setup'); await fm.page.waitForSelector('#settingsForm');
    if (await fm.page.locator('#featuresPanel, #ft-uploads, #st-uploads').count()) throw new Error('fleet manager sees a features control');
    if (/uploads/i.test(await fm.page.locator('#view').innerText())) throw new Error('uploads mentioned in Setup');
  }, tag);
  await check(fm.page, 'fleet manager: upload buttons are visible but disabled while uploads are off', async () => {
    await fm.page.goto(BASE + '/#board'); await fm.page.waitForSelector('#boardReport'); await fm.page.click('#boardReport'); await fm.page.waitForSelector('#issueForm');
    for (const t of ['Add photo', 'Attach PDF']) { const b = fm.page.locator('#issueForm button.attlabel', { hasText: t }); if (!(await b.isVisible()) || !(await b.isDisabled())) throw new Error(t + ' not visible+disabled'); }
    if (!/turned off for now/.test(await fm.page.locator('#upnote').innerText())) throw new Error('note');
    await shot(fm.page, '08b-report-uploads-off-fleet-manager');
    await fm.page.keyboard.press('Escape');
  }, tag);
  await check(fm.page, 'fleet manager: Users screen hierarchy', async () => {
    await fm.page.goto(BASE + '/#users'); await fm.page.waitForSelector('#usersTable tr:has-text("' + secrets.crew.email + '")');
    const row = (email) => fm.page.locator('#usersTable tr', { hasText: email });
    for (const email of [secrets.adminEmail, secrets.sysadm.email]) if (await row(email).getByRole('button').count()) throw new Error('fleet manager has actions on ' + email);
    if (await row(secrets.fm.email).getByRole('button', { name: 'Permissions' }).count()) throw new Error('Permissions on yourself');
    if (await fm.page.getByRole('button', { name: 'Permissions' }).count()) throw new Error('fleet manager is offered Permissions');
    if (await fm.page.locator('#nav a[data-r="roles"]').count()) throw new Error('fleet manager sees Roles & permissions');
    if (await fm.page.locator('#backupsPanel').count()) throw new Error('fleet manager sees Backups');
    await fm.page.click('#addUser'); await fm.page.waitForSelector('#uf-role');
    const roles = await fm.page.$$eval('#uf-role option', (o) => o.map((x) => x.value));
    if (roles.includes('system_admin') || roles.includes('fleet_manager')) throw new Error('fleet manager may assign ' + roles.join());
    await fm.page.keyboard.press('Escape');
  }, tag);
  await check(fm.page, 'fleet manager: can still create a crew account and change a crew member\'s role to base supervisor; no role screen', async () => {
    await fm.page.goto(BASE + '/#users'); await fm.page.waitForSelector('#usersTable');
    await fm.page.click('#addUser'); await fm.page.waitForSelector('#userForm');
    const email = `newbie-${tag}@example.org`;
    await fm.page.fill('#uf-name', 'FM Crew ' + tag); await fm.page.fill('#uf-email', email); await fm.page.selectOption('#uf-role', 'crew');
    await fm.page.locator('input[name=ufb]').first().check();
    await fm.page.fill('#uf-pw', `Typed-newbie-${tag}-9`); await fm.page.fill('#uf-pw2', `Typed-newbie-${tag}-9`);
    await fm.page.click('#uf-save'); await fm.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    const row = fm.page.locator('#usersTable tr', { hasText: email });
    await row.waitFor();
    await row.getByRole('button', { name: 'Edit' }).click(); await fm.page.waitForSelector('#userForm');
    await fm.page.selectOption('#uf-role', 'base_supervisor'); await fm.page.click('#uf-save');
    await fm.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await fm.page.waitForFunction((e) => [...document.querySelectorAll('#usersTable tr')].some((r) => r.innerText.includes(e) && /Base supervisor/.test(r.innerText)), email);
    if (await fm.page.getByRole('button', { name: 'Permissions' }).count()) throw new Error('Permissions button visible to a fleet manager');
    await fm.page.goto(BASE + '/#roles'); await fm.page.waitForTimeout(400);
    if (await fm.page.locator('#roleMatrix').count()) throw new Error('fleet manager reached the Roles & permissions screen');
  }, tag);
  await check(su.page, 'super user: Roles & permissions matrix, revoke Report problems from crew; the crew member loses the button within one sync; reset brings it back', async () => {
    await crew.page.goto(BASE + '/#board'); await crew.page.waitForSelector('#boardReport');
    await su.page.goto(BASE + '/#roles'); await su.page.waitForSelector('#roleMatrix');
    if (!/These are the defaults for each role\. You can still adjust one person under Users/.test(await su.page.locator('#rolesNote').innerText())) throw new Error('help text missing');
    if (await su.page.locator('#rp-crew-backups, #rrow-backups').count()) throw new Error('Backups in the role matrix');
    for (const g of ['Units', 'Problems', 'Work orders', 'Parts and mechanics', 'Admin']) if (!(await su.page.locator('#roleMatrix tr.grp', { hasText: g }).count())) throw new Error('no group ' + g);
    const picker = await su.page.locator('#rp-pick').isVisible();
    if (picker) await su.page.selectOption('#rp-pick', 'crew');
    await su.page.waitForTimeout(150);
    if (await su.page.locator('#rp-crew-report').isDisabled()) throw new Error('crew cell not editable for the super user');
    if (await su.page.locator('#rp-system_admin-report').isDisabled()) throw new Error('super user cannot edit the system_admin column');
    await su.page.locator('#rp-crew-report').uncheck();
    await su.page.locator('#rchg-crew-report').waitFor({ timeout: 3000 }).catch(() => { throw new Error('no Changed from default marker'); });
    // one Save for the whole page, at the top right; nothing is saved until it is pressed
    if (await su.page.locator('[id^="rs-"]').count()) throw new Error('per-role Save buttons are still there');
    await su.page.waitForSelector('#rolesSave:not([disabled])');
    if (!/1 unsaved change/.test(await su.page.locator('#rolesDirty').innerText())) throw new Error('no unsaved count');
    if (!(await su.page.locator('td.unsaved[data-role="crew"]').count())) throw new Error('the unsaved box is not highlighted');
    if (!(await su.page.locator('#topact #rolesSave').isVisible())) throw new Error('Save changes is not in the top bar');
    if (!/Save changes/.test(await su.page.locator('#rolesSave').innerText())) throw new Error('Save changes has no visible label');
    if (await su.page.locator('#roleMatrix .rstate').count()) throw new Error('Yes/No words are still next to the boxes');
    // Discard puts the boxes back without saving
    await su.page.click('#rolesDiscard'); await su.page.waitForSelector('#cfT'); await su.page.click('#cfYes');
    await su.page.waitForSelector('#rolesSave[disabled]');
    if (!(await su.page.locator('#rp-crew-report').isChecked())) throw new Error('Discard did not put the box back');
    await su.page.locator('#rp-crew-report').uncheck();
    await su.page.waitForSelector('#rolesSave:not([disabled])');
    await shot(su.page, '17-roles-matrix'); await noOverflow(su.page);
    await su.page.click('#rolesSave');
    await su.page.waitForSelector('#cfT');
    if (!/This changes what \d+ crew members? can do/.test(await su.page.locator('#cfM').innerText())) throw new Error('confirmation does not name the people: ' + await su.page.locator('#cfM').innerText());
    await shot(su.page, '17b-roles-confirm');
    await su.page.click('#cfYes');
    await su.page.waitForFunction(() => /permissions saved/i.test(document.querySelector('#toasts')?.innerText || ''));
    await crew.page.evaluate(() => window.dispatchEvent(new Event('focus'))); // wakes the sync that normally runs every 20 s
    await crew.page.waitForFunction(() => !document.querySelector('#boardReport'), null, { timeout: 15000 });
    // the per-person drawer says where each state comes from
    await su.page.goto(BASE + '/#users'); await su.page.waitForSelector('#usersTable');
    await su.page.locator('#usersTable tr', { hasText: secrets.crew.email }).getByRole('button', { name: 'Permissions' }).click();
    await su.page.waitForSelector('#permsForm');
    if (!/Role change/.test(await su.page.locator('#src-report').innerText())) throw new Error('report should say Role change: ' + await su.page.locator('#src-report').innerText());
    if (!/Role default/.test(await su.page.locator('#src-move').innerText())) throw new Error('move should say Role default');
    await su.page.locator('#perm-move').check();
    if (!/Personal change/.test(await su.page.locator('#src-move').innerText())) throw new Error('move should say Personal change');
    await su.page.locator('#perm-move').uncheck();
    if (await su.page.locator('#perm-backups').count()) throw new Error('Backups in the per-person drawer');
    await shot(su.page, '16c-permissions-drawer-sources'); await noOverflow(su.page);
    await su.page.click('#perm-cancel'); await su.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    // reset the role to its built-in defaults
    await su.page.goto(BASE + '/#roles'); await su.page.waitForSelector('#roleMatrix');
    if (await su.page.locator('#rp-pick').isVisible()) await su.page.selectOption('#rp-pick', 'crew');
    // Reset to default only fills the boxes in; Save changes keeps them
    await su.page.click('#rr-crew');
    await su.page.waitForSelector('#rolesSave:not([disabled])');
    if (!(await su.page.locator('#rp-crew-report').isChecked())) throw new Error('Reset to default did not fill in the default');
    await su.page.click('#rolesSave'); await su.page.waitForSelector('#cfT'); await su.page.click('#cfYes');
    await su.page.waitForFunction(() => /permissions saved/i.test(document.querySelector('#toasts')?.innerText || ''));
    await su.page.waitForSelector('#rolesSave[disabled]');
    await crew.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await crew.page.waitForSelector('#boardReport', { timeout: 15000 });
  }, tag);
  await check(sa.page, 'system administrator: Roles & permissions with the system_admin column read-only; Permissions drawer for a crew member; no Backups', async () => {
    await sa.page.goto(BASE + '/#roles'); await sa.page.waitForSelector('#roleMatrix');
    if (await sa.page.locator('#rp-pick').isVisible()) { await sa.page.selectOption('#rp-pick', 'system_admin'); await sa.page.waitForTimeout(100); await shot(sa.page, '17c-roles-readonly-sysadmin'); }
    const dis = await sa.page.$$eval('input[data-role="system_admin"]', (x) => x.every((i) => i.disabled));
    if (!dis) throw new Error('system_admin column is editable by a system admin');
    if (!/View only/.test(await sa.page.locator('th[data-role="system_admin"]').innerText())) throw new Error('no View only label');
    if (await sa.page.locator('input[data-role="fleet_manager"]:disabled').count() === await sa.page.locator('input[data-role="fleet_manager"]').count()) throw new Error('fleet_manager column not editable');
    if (!(await sa.page.locator('#rp-crew-users').isDisabled())) throw new Error('system admin can switch on Manage people for crew');
    await shot(sa.page, '17d-roles-system-admin'); await noOverflow(sa.page);
    await sa.page.goto(BASE + '/#users'); await sa.page.waitForSelector('#usersTable');
    if (await sa.page.locator('#backupsPanel').count()) throw new Error('system admin sees the Backups panel');
    const st = await sa.page.evaluate(async () => (await fetch('/api/admin/backups', { credentials: 'same-origin' })).status);
    if (st !== 403) throw new Error('backups list answered ' + st);
    await crew.page.goto(BASE + '/#board'); await crew.page.waitForSelector('#boardReport');
    await sa.page.locator('#usersTable tr', { hasText: secrets.crew.email }).getByRole('button', { name: 'Permissions' }).click();
    await sa.page.waitForSelector('#permsForm');
    for (const k of ['users', 'setup']) {
      if (!(await sa.page.locator(`#perm-${k}`).isDisabled())) throw new Error(k + ' should be disabled');
      if (!/Only the super user can grant this/.test(await sa.page.locator(`#why-${k}`).innerText())) throw new Error('no reason for ' + k);
    }
    if (await sa.page.locator('#perm-backups').count()) throw new Error('Backups listed in the drawer');
    await sa.page.locator('#perm-report').uncheck();
    if (!(await sa.page.locator('#chg-report').isVisible())) throw new Error('no Changed badge');
    await shot(sa.page, '16b-permissions-drawer-system-admin'); await noOverflow(sa.page);
    await sa.page.click('#perm-save'); await sa.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    if (!/Permissions saved/.test(await toastText(sa.page))) throw new Error('no saved toast');
    await crew.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await crew.page.waitForFunction(() => !document.querySelector('#boardReport'), null, { timeout: 15000 });
    await sa.page.locator('#usersTable tr', { hasText: secrets.crew.email }).getByRole('button', { name: 'Permissions' }).click();
    await sa.page.waitForSelector('#permsForm'); await sa.page.click('#perm-resetall'); await sa.page.click('#perm-save');
    await sa.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await crew.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await crew.page.waitForSelector('#boardReport', { timeout: 15000 });
    for (let i = sa.errs.length - 1; i >= 0; i--) if (/403/.test(sa.errs[i])) sa.errs.splice(i, 1);
  }, tag);
  await check(sa.page, 'system administrator (not super): no Features panel, no actions on the super user, cannot assign system admin', async () => {
    await sa.page.goto(BASE + '/#setup'); await sa.page.waitForSelector('#settingsForm');
    if (await sa.page.locator('#featuresPanel').count()) throw new Error('system admin sees Features');
    await sa.page.goto(BASE + '/#users'); await sa.page.waitForSelector('#usersTable tr:has-text("' + secrets.fm.email + '")');
    if (await sa.page.locator('#usersTable tr', { hasText: secrets.adminEmail }).getByRole('button').filter({ hasNotText: 'View activity' }).count()) throw new Error('actions on the super user');
    if (!(await sa.page.locator('#usersTable tr', { hasText: secrets.fm.email }).getByRole('button', { name: 'Permissions' }).count())) throw new Error('no Permissions for fleet manager');
    await sa.page.click('#addUser'); await sa.page.waitForSelector('#uf-role');
    if ((await sa.page.$$eval('#uf-role option', (o) => o.map((x) => x.value))).includes('system_admin')) throw new Error('system admin can assign system admin');
    await sa.page.keyboard.press('Escape');
  }, tag);
  /* ---- Activity history ---- */
  const gotoActivity = async (pg) => {
    // after a reload the shell may not be drawn yet; wait for it before deciding whether the phone menu needs opening
    await pg.waitForSelector('#nav a[data-r="activity"]', { state: 'attached' });
    if (await pg.locator('#menuBtn').isVisible() && !(await pg.locator('#nav a[data-r="activity"]').isVisible())) await pg.click('#menuBtn');
    await pg.click('#nav a[data-r="activity"]');
    await pg.waitForFunction(() => location.hash === '#activity');
    await pg.waitForSelector('#actFilters');
  };
  /** Below 640 px the filters sit behind a Filters button. */
  const openFilters = async (pg) => { if ((await pg.locator('#actFiltersBtn').isVisible()) && !(await pg.locator('#actMore').isVisible())) await pg.click('#actFiltersBtn'); };
  const rowsOf = (pg) => pg.locator('.actrow');
  const waitRows = (pg) => pg.waitForSelector('.actrow');
  const panelText = (pg) => pg.locator('#actPanel').innerText();
  await check(su.page, 'activity history: the super user opens it from the sidebar and reads the earlier role and permission changes as sentences', async () => {
    await gotoActivity(su.page); await waitRows(su.page);
    if (!/Activity history/.test(await su.page.locator('#view h1').innerText())) throw new Error('title');
    if (!/(Admin\s*\/\s*)?Activity history/.test((await su.page.locator('#crumbs').innerText()).replace(/\n/g, ' '))) throw new Error('breadcrumb: ' + await su.page.locator('#crumbs').innerText());
    const t = await panelText(su.page);
    if (!/Turned off 'Report problems' for Crew/.test(t)) throw new Error("no role permission sentence:\n" + t.slice(0, 600));
    if (!/Changed FM Crew .+'s role from Crew to Base supervisor/.test(t)) throw new Error('no role change sentence:\n' + t.slice(0, 600));
    if (!/Signed in/.test(t)) throw new Error('no sign-in');
    if (!/^(Today|Yesterday)$/.test((await su.page.locator('.actday').first().innerText()).trim())) throw new Error('day heading');
    if (!/^\d\d:\d\d$/.test((await su.page.locator('.at-t').first().innerText()).trim())) throw new Error('time is not HH:MM');
    if (/[{}]|baseId|before_json/.test(t)) throw new Error('raw JSON or field names on screen');
    await shot(su.page, '18-activity'); await noOverflow(su.page);
    if (await su.page.locator('#actFiltersBtn').isVisible()) { await su.page.click('#actFiltersBtn'); await su.page.waitForSelector('#actMore.open #act-type', { state: 'visible' }); await noOverflow(su.page); await shot(su.page, '18c-activity-filters-open'); await su.page.click('#actFiltersBtn'); await su.page.waitForSelector('#actMore', { state: 'hidden' }); }
  }, tag);
  await check(su.page, 'activity history: filter by type, see the moves, expand a row for before -> after, keyboard works', async () => {
    await openFilters(su.page);
    await su.page.selectOption('#act-type', 'vehicles');
    await su.page.waitForFunction(() => { const r = [...document.querySelectorAll('.actrow')]; return r.length > 0 && r.every((x) => x.dataset.cat === 'vehicles'); });
    const mv = rowsOf(su.page).filter({ hasText: /^.*Moved GEMA-\S+ from .+ to .+/s }).first();
    await mv.waitFor();
    const btn = mv.locator('.at-x');
    if ((await btn.getAttribute('aria-expanded')) !== 'false') throw new Error('should start collapsed');
    await btn.click();
    const diff = su.page.locator('.actdiff').first();
    await diff.waitFor();
    if ((await btn.getAttribute('aria-expanded')) !== 'true' || !(await btn.getAttribute('aria-controls'))) throw new Error('aria state');
    const d = await diff.innerText();
    if (!/What changed/i.test(d) || !/Before/i.test(d) || !/After/i.test(d) || !/Base/.test(d)) throw new Error('diff content: ' + d);
    if (/[{}"]|baseId|tempUntil/.test(d)) throw new Error('raw JSON in the diff: ' + d);
    const cells = await diff.locator('tbody tr').first().locator('td').allInnerTexts();
    if (cells.length !== 3 || !cells[2].includes('\u2192')) throw new Error('before / after columns: ' + cells.join(' | '));
    await shot(su.page, '18b-activity-expanded'); await noOverflow(su.page);
    await su.page.locator('.actrow .at-x[aria-expanded="true"]').first().focus();
    await su.page.keyboard.press('Enter');
    await su.page.waitForFunction(() => !document.querySelector('.actdiff'));
    await su.page.locator('.actrow .at-x').first().focus();
    await su.page.keyboard.press('Space');
    await su.page.waitForSelector('.actdiff');
  }, tag);
  await check(su.page, 'activity history: work orders by type; a unit link opens the unit and Back returns to Activity history, filters kept', async () => {
    await openFilters(su.page);
    await su.page.selectOption('#act-type', 'work_orders');
    await su.page.waitForFunction(() => { const r = [...document.querySelectorAll('.actrow')]; return r.length > 0 && r.every((x) => x.dataset.cat === 'work_orders'); });
    if (!/Closed work order WO-\d+/.test(await panelText(su.page))) throw new Error('no closed work order sentence:\n' + (await panelText(su.page)).slice(0, 500));
    // the work order number opens the drawer, and Back goes to Activity history
    await su.page.locator('#actPanel .ulink[data-act="open-wo"]').first().click();
    await su.page.waitForSelector('#drawerRoot .drawer');
    if (!/Back to Activity history/.test(await su.page.locator('#dBack').innerText())) throw new Error('drawer back label: ' + await su.page.locator('#dBack').innerText());
    await su.page.keyboard.press('Escape'); await su.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    await openFilters(su.page);
    await su.page.selectOption('#act-type', 'vehicles');
    await su.page.waitForFunction(() => { const r = [...document.querySelectorAll('.actrow')]; return r.length > 0 && r.every((x) => x.dataset.cat === 'vehicles'); });
    await su.page.locator('#actPanel .ulink[data-act="open-vehicle"]').first().click();
    await su.page.waitForSelector('#navBack');
    if (!/Back to Activity history/.test((await su.page.locator('#navBack').getAttribute('aria-label')) || '')) throw new Error('crumb: ' + await su.page.locator('#navBack').getAttribute('aria-label'));
    await su.page.click('#navBack');
    await su.page.waitForFunction(() => location.hash === '#activity');
    await waitRows(su.page);
    await openFilters(su.page);
    if ((await su.page.inputValue('#act-type')) !== 'vehicles') throw new Error('type filter lost after Back');
    await su.page.selectOption('#act-type', '');
  }, tag);
  await check(su.page, 'activity history: filter by person, date range, empty state, clear', async () => {
    await openFilters(su.page);
    await su.page.selectOption('#act-user', { label: 'E2E Admin' });
    await su.page.waitForFunction(() => { const w = [...document.querySelectorAll('.actrow .at-who b')]; return w.length > 0 && w.every((x) => x.textContent === 'E2E Admin'); });
    await su.page.selectOption('#act-user', '');
    const today = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
    await su.page.fill('#act-from', today); await su.page.fill('#act-to', today);
    await su.page.waitForFunction(() => document.querySelectorAll('.actrow').length > 0);
    await su.page.fill('#act-from', '2031-01-01'); // a From later than To moves To along with it (no error)
    await su.page.waitForFunction(() => document.getElementById('act-to').value === '2031-01-01');
    await su.page.waitForSelector('#actClear');
    if (!/No activity found/.test(await su.page.locator('.empty').innerText())) throw new Error('empty state text');
    await shot(su.page, '18d-activity-empty'); await noOverflow(su.page);
    await su.page.click('#actClear');
    await waitRows(su.page);
    if ((await su.page.inputValue('#act-from')) !== '') throw new Error('Clear filters did not clear the date');
  }, tag);
  await check(su.page, 'activity history: failed and successful sign-ins, search, Load more, CSV export of the filtered view', async () => {
    // 55 failed sign-ins from unknown addresses (the browser logs each 401 as a console error; that is expected)
    await su.page.evaluate(async (tg) => { for (let i = 0; i < 55; i++) await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gema-fleet' }, body: JSON.stringify({ agencyId: 'GEMA', email: `bad-${i}-${tg}@example.org`, password: 'not-a-real-password' }) }); }, tag);
    await su.page.reload(); await gotoActivity(su.page);
    await openFilters(su.page);
    await su.page.selectOption('#act-type', 'sign_ins');
    // wait for the filtered list itself, not the old one still on screen while it reloads
    await su.page.waitForFunction(() => document.querySelectorAll('.actrow').length === 50 && !/updating/.test(document.querySelector('#actPanel [role=status]')?.textContent || 'updating') && !document.querySelector('#actMoreBtn')?.disabled);
    if (!(await su.page.locator('#actMoreBtn').isVisible())) throw new Error('no Load more');
    if (!/Failed sign-in for bad-\d+-/.test(await panelText(su.page))) throw new Error('no failed sign-in sentence');
    if (!(await su.page.locator('.actrow .badge.bad', { hasText: 'Failed' }).count())) throw new Error('no Failed badge');
    await su.page.click('#actMoreBtn');
    await su.page.waitForFunction(() => document.querySelectorAll('.actrow').length > 50);
    if (await su.page.locator('#actMoreBtn').count()) { /* more may remain from earlier sign-ins; fine */ }
    if (await su.page.locator('.actrow[id]').evaluateAll((e) => new Set(e.map((x) => x.id)).size !== e.length)) throw new Error('a row appears twice after Load more');
    await su.page.fill('#act-q', `bad-3-${tag}`);
    await su.page.waitForFunction(() => document.querySelectorAll('.actrow').length === 1 && !/updating/.test(document.querySelector('#actPanel [role=status]')?.textContent || 'updating'));
    if (!(await panelText(su.page)).includes(`Failed sign-in for bad-3-${tag}@example.org`)) throw new Error('search did not find the address');
    const [dl] = await Promise.all([su.page.waitForEvent('download'), su.page.click('#actExport')]);
    if (!/^gema-fleet-activity-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename())) throw new Error('file name ' + dl.suggestedFilename());
    const csv = readFileSync(await dl.path(), 'utf8').replace(/^\ufeff/, '').trim().split('\r\n');
    if (csv.length !== 2 || !csv[0].startsWith('When (Guyana time),Person') || !csv[1].includes(`Failed sign-in for bad-3-${tag}@example.org`)) throw new Error('csv: ' + csv.join(' // '));
    if (csv.join('').includes('not-a-real-password')) throw new Error('password in the export');
    await su.page.fill('#act-q', ''); await su.page.selectOption('#act-type', '');
  }, tag);
  await check(su.page, 'activity history: "View activity" on a person (Users) and on a unit (History tab) open Activity filtered', async () => {
    await su.page.goto(BASE + '/#users'); await su.page.waitForSelector('#usersTable');
    const row = su.page.locator('#usersTable tr', { hasText: secrets.crew.email });
    await row.getByRole('button', { name: /View activity for this person/ }).click();
    await su.page.waitForFunction(() => location.hash === '#activity'); await waitRows(su.page);
    await openFilters(su.page);
    if (!(await su.page.inputValue('#act-user'))) throw new Error('person not selected');
    await su.page.waitForFunction((n) => { const w = [...document.querySelectorAll('.actrow .at-who b')]; return w.length > 0 && w.every((x) => x.textContent === n); }, 'Crew ' + tag);
    await su.page.click('#actClear').catch(() => {}); await su.page.selectOption('#act-user', '');
    await su.page.goto(BASE + '/#vehicles'); await su.page.waitForSelector('[data-act="open-vehicle"]');
    await su.page.locator('[data-act="open-vehicle"]').first().click();
    await su.page.waitForSelector('[data-act="vtab"][data-tab="history"]'); await su.page.click('[data-act="vtab"][data-tab="history"]');
    await su.page.click('#vaAct');
    await su.page.waitForFunction(() => location.hash === '#activity');
    await su.page.waitForSelector('#actEntity');
    if (!/Showing activity for GEMA-/.test(await su.page.locator('#actEntity').innerText())) throw new Error('chip: ' + await su.page.locator('#actEntity').innerText());
    await shot(su.page, '18e-activity-for-unit'); await noOverflow(su.page);
    await su.page.click('#actEntityClear'); await su.page.waitForSelector('#actEntity', { state: 'detached' });
  }, tag);
  await check(sa.page, 'activity history: a system administrator sees the link and the page', async () => {
    await gotoActivity(sa.page); await waitRows(sa.page);
    const st = await sa.page.evaluate(async () => [(await fetch('/api/admin/activity', { credentials: 'same-origin' })).status, (await fetch('/api/admin/activity/export', { credentials: 'same-origin' })).status]);
    if (st.join() !== '200,200') throw new Error('api ' + st.join());
    await shot(sa.page, '18f-activity-system-admin'); await noOverflow(sa.page);
  }, tag);
  for (const [who, x] of [['fleet manager', fm], ['crew', crew]]) {
    await check(x.page, `activity history: ${who} has no link, cannot open the page, and the API answers 403`, async () => {
      if (await x.page.locator('#nav a[data-r="activity"]').count()) throw new Error('Activity link shown');
      await x.page.goto(BASE + '/#activity'); await x.page.waitForSelector('#view h1');
      await x.page.waitForTimeout(300);
      if (/Activity history/.test(await x.page.locator('#view h1').innerText()) || (await x.page.locator('#actFilters').count())) throw new Error('page opened');
      const st = await x.page.evaluate(async () => [(await fetch('/api/admin/activity', { credentials: 'same-origin' })).status, (await fetch('/api/admin/audit', { credentials: 'same-origin' })).status, (await fetch('/api/admin/activity/export', { credentials: 'same-origin' })).status]);
      if (st.join() !== '403,403,403') throw new Error('api ' + st.join());
      await x.page.goto(BASE + '/#board');
      if (await x.page.locator('#usersTable').count()) throw new Error('unexpected users table');
    }, tag);
  }
  for (const x of [fm, crew, sa, su]) { await check(x.page, 'manager flow: no console errors', async () => { const real = x.errs.filter((e) => !/40[13]/.test(e)); if (real.length) throw new Error(real.slice(0, 3).join(' | ')); }, tag); await x.ctx.close(); }
}

/** Fonts are self-hosted (the CSP allows 'self' only), so any request to another host is a fault. */
async function newCtx(browser, opts) {
  const ctx = await browser.newContext(opts);
  ctx.on('request', (r) => { if (!/^(blob:|data:)/.test(r.url()) && !r.url().startsWith(BASE)) stray.push(r.url()); });
  return ctx;
}
const stray = [];
async function roleFlow(browser, ctxOpts, tag, who, secrets, kind) {
  const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${tag}-${n}.png` });
  const rec = secrets[who];
  await check(page, `${kind}: logs in with the password the administrator chose, no forced change`, async () => {
    await login(page, rec.email, rec.pass);
    await page.waitForSelector(kind === 'dispatcher' ? '.dcell' : '.urow', { timeout: 10000 });
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
      if (!(await page.locator('.dcell').count())) throw new Error('dispatcher left the dispatch screen');
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


/* ---------- email run: a second server with the development mail sink, so invite and reset emails can be read back ---------- */
async function lastMail(to, subjectPart, notBefore = '') {
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(`${BASE}/api/dev/last-mail?to=${encodeURIComponent(to)}`)).json();
    if (j.mail && j.mail.subject.includes(subjectPart) && j.mail.at > notBefore) return j.mail;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no "${subjectPart}" email for ${to}`);
}
const linkIn = (mail) => { const m = /(https?:\/\/\S+\/set-password#t=[A-Za-z0-9_-]+)/.exec(mail.text); if (!m) throw new Error('no link in email'); return m[1]; };

async function emailFlow(browser, cfg, secrets) {
  const { tag, ...ctxOpts } = cfg; const t = 'em-' + tag;
  log(`\n== email flow ${tag}`);
  const mkPage = async () => {
    const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(8000);
    const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
    return { ctx, page, errs };
  };
  const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${t}-${n}.png` });
  const a = await mkPage();
  const crew = { email: `invitee-${tag}@example.org`, name: 'Ines Invitee' };
  let inviteLink = '';
  await check(a.page, 'email: login page offers Forgot password', async () => {
    await a.page.goto(BASE + '/'); await a.page.waitForSelector('#forgotLink');
    await shot(a.page, '01-login'); await noOverflow(a.page);
  }, t);
  await check(a.page, 'email: admin invites a person by email (no password shown)', async () => {
    await login(a.page, secrets.adminEmail, secrets.adminPass);
    if (secrets.adminForced) { await forcedChange(a.page, secrets.adminPass, secrets.adminPass2); secrets.adminForced = false; secrets.adminPass = secrets.adminPass2; }
    await a.page.waitForSelector('.urow');
    await a.page.goto(BASE + '/#users'); await a.page.waitForSelector('#addUser');
    if (!/or by emailing them a link/.test(await a.page.locator('#usersNote').innerText())) throw new Error('email note missing');
    await a.page.click('#addUser'); await a.page.waitForSelector('#userForm');
    await a.page.fill('#uf-name', crew.name); await a.page.fill('#uf-email', crew.email); await a.page.selectOption('#uf-role', 'crew');
    await a.page.locator('input[name=ufb]').first().check();
    if (!(await a.page.isChecked('#uf-how-pw'))) throw new Error('Set a password now is not the default');
    await a.page.check('#uf-how-invite');
    if (await a.page.locator('#uf-pwwrap').isVisible()) throw new Error('password fields still visible for an invite');
    await shot(a.page, '02-add-user-invite'); await noOverflow(a.page);
    await a.page.click('#uf-save');
    await a.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    if (!new RegExp('Email sent to ' + crew.email).test(await toastText(a.page))) throw new Error('no "Email sent" toast: ' + (await toastText(a.page)));
    const row = a.page.locator('#usersTable tr', { hasText: crew.email });
    await row.getByText('Invited — not yet set up').waitFor();
    if (!(await row.getByRole('button', { name: 'Resend invite' }).count())) throw new Error('no Resend invite');
    await shot(a.page, '03-users-invited'); await noOverflow(a.page);
    const mail = await lastMail(crew.email, 'Set up your GEMA Fleet account');
    if (!mail.text.includes('Admin') && !mail.text.includes('E2E Admin')) throw new Error('inviter not named');
    inviteLink = linkIn(mail);
  }, t);
  await check(a.page, 'email: Resend invite makes a new link and retires the old one', async () => {
    const row = a.page.locator('#usersTable tr', { hasText: crew.email });
    const before = new Date().toISOString();
    await row.getByRole('button', { name: 'Resend invite' }).click();
    const mail = await lastMail(crew.email, 'Set up your GEMA Fleet account', before);
    const fresh = linkIn(mail);
    if (fresh === inviteLink) throw new Error('same link');
    secrets.oldInvite = inviteLink; inviteLink = fresh;
  }, t);
  await check(a.page, 'email: Send reset link shows for people who have a password', async () => {
    const row = a.page.locator('#usersTable tr', { hasText: secrets.adminEmail });
    if (!(await row.getByRole('button', { name: 'Send reset link' }).count())) throw new Error('no Send reset link');
    if (await row.getByRole('button', { name: 'Set password' }).count()) throw new Error('Set password offered for yourself');
  }, t);
  await check(a.page, 'email: an old (replaced) link says it was used', async () => {
    const b = await mkPage();
    await b.page.goto(secrets.oldInvite); await b.page.waitForSelector('#sp-problem');
    if (!/already used/i.test(await b.page.innerText('h1'))) throw new Error('heading: ' + await b.page.innerText('h1'));
    if (b.page.url().includes('#t=')) throw new Error('token left in the address bar');
    await shot(b.page, '04-link-used'); await noOverflow(b.page);
    await b.ctx.close();
  }, t);
  await check(a.page, 'email: an expired link says ask your fleet manager', async () => {
    const before = new Date().toISOString();
    await a.page.click('#addUser'); await a.page.waitForSelector('#userForm');
    await a.page.fill('#uf-name', 'Eddie Expired'); await a.page.fill('#uf-email', `expired-${tag}@example.org`); await a.page.selectOption('#uf-role', 'viewer');
    await a.page.check('#uf-how-invite'); await a.page.click('#uf-save');
    await a.page.waitForSelector('#drawerRoot .drawer', { state: 'detached' });
    const link = linkIn(await lastMail(`expired-${tag}@example.org`, 'Set up', before));
    writeFileSync('.wrangler/e2e-exp.sql', "UPDATE account_tokens SET expires_at = '2020-01-01T00:00:00.000Z';"); d1('.wrangler/e2e-exp.sql'); rmSync('.wrangler/e2e-exp.sql');
    const b = await mkPage();
    await b.page.goto(link); await b.page.waitForSelector('#sp-problem');
    if (!/Ask your fleet manager to send a new one\./.test(await b.page.innerText('#sp-problem'))) throw new Error('message: ' + await b.page.innerText('#sp-problem'));
    await shot(b.page, '05-link-expired'); await noOverflow(b.page);
    await b.ctx.close();
    // the crew invite was expired too; ask for a fresh one for the next check
    const row = a.page.locator('#usersTable tr', { hasText: crew.email });
    const b2 = new Date().toISOString();
    await row.getByRole('button', { name: 'Resend invite' }).click();
    inviteLink = linkIn(await lastMail(crew.email, 'Set up', b2));
  }, t);
  await logout(a.page).catch(() => {});
  await a.ctx.close();

  const c = await mkPage();
  await check(c.page, 'email: invite link, set password, land signed in', async () => {
    await c.page.goto(inviteLink); await c.page.waitForSelector('#spForm');
    if (c.page.url().includes('#t=') || !c.page.url().endsWith('/set-password')) throw new Error('fragment not cleared: ' + c.page.url());
    if (!(await c.page.innerText('#sp-hello')).includes(`Hi ${crew.name}, choose a password for GEMA Fleet`)) throw new Error('greeting: ' + await c.page.innerText('#sp-hello'));
    await shot(c.page, '06-set-password'); await noOverflow(c.page);
    await c.page.fill('#sp-new', 'short'); await c.page.fill('#sp-new2', 'short'); await c.page.click('#sp-submit');
    await c.page.waitForSelector('#sp-err:not([hidden])');
    await c.page.fill('#sp-new', 'Invitee-chosen-pass-1'); await c.page.fill('#sp-new2', 'Invitee-chosen-pass-2'); await c.page.click('#sp-submit');
    if (!/do not match/.test(await c.page.innerText('#sp-err'))) throw new Error('mismatch not reported');
    await shot(c.page, '07-set-password-error'); await noOverflow(c.page);
    await c.page.fill('#sp-new2', 'Invitee-chosen-pass-1'); await c.page.click('#sp-submit');
    await c.page.waitForSelector('.urow');
    if (!c.page.url().includes('#board')) throw new Error('did not land on the board: ' + c.page.url());
    await shot(c.page, '08-landed'); await noOverflow(c.page);
  }, t);
  await check(c.page, 'email: Forgot password -> email -> new password -> signed in', async () => {
    await logout(c.page);
    await c.page.click('#forgotLink'); await c.page.waitForSelector('#forgotForm');
    await shot(c.page, '09-forgot'); await noOverflow(c.page);
    const before = new Date().toISOString();
    await c.page.fill('#fg-agency', 'GEMA'); await c.page.fill('#fg-email', crew.email); await c.page.click('#fg-submit');
    await c.page.waitForSelector('#fg-done');
    if (!/If that email has an account, we've sent a link to reset the password\./.test(await c.page.innerText('#fg-done'))) throw new Error('confirmation text');
    await shot(c.page, '10-forgot-sent'); await noOverflow(c.page);
    const mail = await lastMail(crew.email, 'Reset your GEMA Fleet password', before);
    await c.page.goto(linkIn(mail)); await c.page.waitForSelector('#spForm');
    if (!(await c.page.innerText('h1')).includes('Reset your password')) throw new Error('reset heading');
    await shot(c.page, '11-reset'); await noOverflow(c.page);
    await c.page.fill('#sp-new', 'Invitee-reset-pass-3'); await c.page.fill('#sp-new2', 'Invitee-reset-pass-3'); await c.page.click('#sp-submit');
    await c.page.waitForSelector('.urow');
    await logout(c.page);
    await login(c.page, crew.email, 'Invitee-reset-pass-3');
    await c.page.waitForSelector('.urow');
    // the previous password no longer works
    await logout(c.page);
    await c.page.fill('#lg-agency', 'GEMA'); await c.page.fill('#lg-email', crew.email); await c.page.fill('#lg-pass', 'Invitee-chosen-pass-1'); await c.page.click('#lg-submit');
    await c.page.waitForSelector('#lg-err:not([hidden])');
    c.errs.length = 0; // the deliberate wrong password is logged by the browser as a 401
  }, t);
  await check(c.page, 'email: forgot password for an unknown address shows the same confirmation', async () => {
    await c.page.fill('#lg-email', ''); await c.page.click('#forgotLink'); await c.page.waitForSelector('#forgotForm');
    await c.page.fill('#fg-agency', 'GEMA'); await c.page.fill('#fg-email', 'nobody-here@example.org'); await c.page.click('#fg-submit');
    await c.page.waitForSelector('#fg-done');
    if (!/If that email has an account/.test(await c.page.innerText('#fg-done'))) throw new Error('different text');
  }, t);
  await check(c.page, 'email: no console errors', async () => { if (c.errs.length) throw new Error(c.errs.slice(0, 3).join(' | ')); }, t);
  await c.ctx.close();
}

/**
 * Several agencies on one site (screenshots 19-*): the super user adds an agency from Admin > Agencies; its administrator signs in with the new
 * Agency ID and sees an empty fleet, not GEMA's; a wrong Agency ID is refused; the super user opens the agency (banner) and comes back.
 * The e2e database is shared by the four screen configurations, so each one adds its own agency.
 */
async function agenciesFlow(browser, ctxOpts, tag, secrets) {
  const code = 'E2E-' + tag.replace(/\W/g, '').toUpperCase().slice(0, 14), name = 'E2E Agency ' + tag, adminEmail = `boss@${code.toLowerCase()}.example.org`;
  let adminPw = '';
  const mk = async () => {
    const ctx = await newCtx(browser, ctxOpts); const page = await ctx.newPage(); page.setDefaultTimeout(10000);
    const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
    return { ctx, page, errs };
  };
  const su = await mk();
  const shot = (pg, n) => pg.screenshot({ path: `${SHOTS}/${tag}-${n}.png` });
  const gotoHash = async (pg, h) => { await pg.evaluate((x) => { location.hash = x; }, h); };
  await check(su.page, 'agencies: the login page asks for the Agency ID above Email, is neutral, and remembers the last Agency ID', async () => {
    await su.page.goto(BASE + '/'); await su.page.waitForSelector('#lg-agency');
    const order = await su.page.evaluate(() => { const a = document.getElementById('lg-agency'), e = document.getElementById('lg-email'); return { before: !!(a.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING), ph: a.placeholder, label: a.closest('label').innerText.trim(), text: document.body.innerText, h1: document.querySelector('#view h1').innerText, title: document.title }; });
    if (!order.before) throw new Error('Agency ID is not above Email');
    if (order.ph !== 'GEMA' || order.label !== 'Agency ID') throw new Error('label/placeholder: ' + order.label + ' / ' + order.ph);
    if (/GEMA|Guyana/i.test(order.text) || /GEMA|Guyana/i.test(order.title)) throw new Error('GEMA wording on the login page');
    if (order.h1 !== 'Fleet maintenance') throw new Error('heading ' + order.h1);
    await shot(su.page, '19-login-agency'); await noOverflow(su.page);
    // case-insensitive and trimmed
    await su.page.fill('#lg-agency', '  gema '); await su.page.fill('#lg-email', secrets.adminEmail); await su.page.fill('#lg-pass', secrets.adminPass); await su.page.click('#lg-submit');
    await su.page.waitForSelector('.urow', { timeout: 15000 });
    await logout(su.page);
    if ((await su.page.inputValue('#lg-agency')) !== 'GEMA') throw new Error('the last Agency ID was not remembered: ' + (await su.page.inputValue('#lg-agency')));
    await su.page.fill('#lg-email', secrets.adminEmail); await su.page.fill('#lg-pass', secrets.adminPass); await su.page.click('#lg-submit');
    await su.page.waitForSelector('.urow', { timeout: 15000 });
  }, tag);
  let gemaUnit = '';
  await check(su.page, 'agencies: Admin > Agencies lists GEMA as the home agency', async () => {
    gemaUnit = await su.page.evaluate(async () => (await (await fetch('/api/sync?since=0')).json()).data.vehicles[0].unit);
    if (await su.page.locator('#menuBtn').isVisible()) await su.page.click('#menuBtn');
    await su.page.click('#nav a[data-r=agencies]');
    await su.page.waitForSelector('#agenciesTable tr[data-agency=GEMA]');
    const row = await su.page.innerText('#agenciesTable tr[data-agency=GEMA]');
    if (!/home/i.test(row) || !/\bactive\b/i.test(row)) throw new Error('GEMA row: ' + row);
    const head = await su.page.innerText('#agenciesTable thead');
    for (const h of ['Agency ID', 'Name', 'Active users', 'Vehicles', 'Created']) if (!head.toLowerCase().includes(h.toLowerCase())) throw new Error('missing column ' + h);
    await su.page.waitForFunction(() => !document.body.classList.contains('navopen')); await su.page.waitForTimeout(400); // the phone menu has slid away
    await shot(su.page, '19-agencies'); await noOverflow(su.page);
  }, tag);
  await check(su.page, 'agencies: add an agency with its first administrator (Generate fills the password)', async () => {
    await su.page.click('#addAgency'); await su.page.waitForSelector('#agencyForm');
    await su.page.fill('#ag-code', code.toLowerCase()); await su.page.fill('#ag-name', name);
    await su.page.fill('#ag-aname', 'Boss ' + tag); await su.page.fill('#ag-aemail', adminEmail);
    await su.page.click('#ag-gen'); adminPw = await su.page.inputValue('#ag-pw');
    if (adminPw.length < 10 || (await su.page.inputValue('#ag-pw2')) !== adminPw) throw new Error('Generate did not fill both password fields');
    await shot(su.page, '19-add-agency'); await noOverflow(su.page);
    await su.page.click('#ag-save');
    await su.page.waitForSelector(`#agenciesTable tr[data-agency="${code}"]`);
    const row = await su.page.innerText(`#agenciesTable tr[data-agency="${code}"]`);
    if (!row.includes(name) || !/\bactive\b/i.test(row)) throw new Error('new row: ' + row);
    // a duplicate code is refused with a message
    await su.page.click('#addAgency'); await su.page.waitForSelector('#agencyForm');
    await su.page.fill('#ag-code', code); await su.page.fill('#ag-name', 'Again'); await su.page.fill('#ag-aname', 'X Y'); await su.page.fill('#ag-aemail', 'x@again.example.org');
    await su.page.click('#ag-gen'); await su.page.click('#ag-save');
    await su.page.waitForFunction(() => /already in use/i.test(document.getElementById('toasts').innerText));
    await su.page.click('#ag-cancel');
  }, tag);
  const adm = await mk();
  await check(adm.page, 'agencies: the new administrator signs in with the new Agency ID and sees an empty fleet, not GEMA\'s', async () => {
    await login(adm.page, adminEmail, adminPw, code);
    await adm.page.waitForSelector('#view .empty', { timeout: 15000 });
    const t = await adm.page.innerText('body');
    if (t.includes(gemaUnit)) throw new Error('GEMA unit ' + gemaUnit + ' is visible');
    if (!/Nothing set up yet|No vehicles yet/.test(t)) throw new Error('empty state text missing');
    await adm.page.screenshot({ path: `${SHOTS}/${tag}-19-new-agency-empty-board.png` }); await noOverflow(adm.page);
    const brand = await adm.page.evaluate(() => ({ b: document.getElementById('brandName').textContent, title: document.title }));
    if (brand.b !== name) throw new Error('sidebar title ' + brand.b);
    if (brand.title !== `Status board - ${name} Fleet`) throw new Error('document title ' + brand.title);
    // every screen this person can open draws without error on an empty agency
    for (const r of ['dispatch', 'vehicles', 'pm', 'issues', 'work-orders', 'parts', 'reports', 'setup', 'users', 'roles', 'activity']) {
      await gotoHash(adm.page, '#' + r); await adm.page.waitForTimeout(250);
      if (/Something went wrong/.test(await adm.page.innerText('#view'))) throw new Error('screen ' + r + ' failed to draw');
    }
    if (await adm.page.locator('#nav a[data-r=agencies]').count()) throw new Error('an agency administrator can see the Agencies screen');
    const api403 = await adm.page.evaluate(async () => (await fetch('/api/agencies')).status);
    if (api403 !== 403) throw new Error('GET /api/agencies gave ' + api403);
    await gotoHash(adm.page, '#board'); await adm.page.waitForSelector('#view .empty');
    await logout(adm.page);
  }, tag);
  await check(adm.page, 'agencies: a wrong Agency ID is refused with the same message as a wrong password', async () => {
    const attempt = async (agency, email, pw) => {
      await adm.page.fill('#lg-agency', agency); await adm.page.fill('#lg-email', email); await adm.page.fill('#lg-pass', pw); await adm.page.click('#lg-submit');
      await adm.page.waitForSelector('#lg-err:not([hidden])');
      const t = await adm.page.innerText('#lg-err');
      await adm.page.evaluate(() => { document.getElementById('lg-err').hidden = true; });
      return t;
    };
    const a = await attempt('GEMA', adminEmail, adminPw), b = await attempt('NOPE-ZZ', adminEmail, adminPw), c = await attempt(code, adminEmail, 'not-the-password-1');
    if (a !== b || b !== c) throw new Error(`messages differ: "${a}" / "${b}" / "${c}"`);
    if (!/Agency ID/.test(a)) throw new Error('message does not mention the Agency ID: ' + a);
  }, tag);
  await adm.ctx.close();
  await check(su.page, 'agencies: Open switches into the agency with a banner; Back returns', async () => {
    await gotoHash(su.page, '#agencies');
    await su.page.waitForSelector(`#oa-${code}`);
    await su.page.click(`#oa-${code}`);
    await su.page.waitForSelector('#agencyBanner');
    const b = await su.page.innerText('#agencyBanner');
    if (!b.includes(`Viewing ${name} (${code}) as the super user`) || !b.includes('Back to GEMA')) throw new Error('banner: ' + b);
    await su.page.waitForSelector('#view .empty');
    if ((await su.page.innerText('body')).includes(gemaUnit)) throw new Error('GEMA unit visible inside the other agency');
    if ((await su.page.evaluate(() => document.getElementById('brandName').textContent)) !== name) throw new Error('sidebar title did not switch');
    await shot(su.page, '19-agency-banner'); await noOverflow(su.page);
    await su.page.click('#agencyBack');
    await su.page.waitForSelector('#agenciesTable');
    if (await su.page.locator('#agencyBanner').count()) throw new Error('banner still showing after Back');
    if ((await su.page.evaluate(() => document.getElementById('brandName').textContent)) !== 'GEMA') throw new Error('sidebar title did not come back');
    await gotoHash(su.page, '#board'); await su.page.waitForSelector('.urow');
    if (!(await su.page.innerText('body')).includes(gemaUnit)) throw new Error('GEMA data did not come back');
  }, tag);
  await check(su.page, 'agencies: rename, deactivate (people are refused), reactivate', async () => {
    await gotoHash(su.page, '#agencies');
    await su.page.click(`#ra-${code}`); await su.page.waitForSelector('#agencyRenameForm');
    await su.page.fill('#ar-name', name + ' renamed'); await su.page.click('#ar-save');
    await su.page.waitForFunction((n) => document.getElementById('agenciesTable').innerText.includes(n), name + ' renamed');
    await su.page.click(`#da-${code}`); await su.page.click('#cfYes');
    await su.page.waitForFunction((c) => /deactivated/i.test(document.querySelector(`#agenciesTable tr[data-agency="${c}"]`).innerText), code);
    const status = await su.page.evaluate(async ([c, e, p]) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gema-fleet' }, body: JSON.stringify({ agencyId: c, email: e, password: p }) })).status, [code, adminEmail, adminPw]);
    if (status !== 401) throw new Error('a deactivated agency still signs in: ' + status);
    su.errs.length = 0;
    await su.page.click(`#da-${code}`);
    await su.page.waitForFunction((c) => /\bactive\b/i.test(document.querySelector(`#agenciesTable tr[data-agency="${c}"]`).innerText), code);
  }, tag);
  await check(su.page, 'agencies: no console errors', async () => { const real = su.errs.filter((e) => !/40[13]/.test(e)); if (real.length) throw new Error(real.slice(0, 3).join(' | ')); }, tag);
  await su.ctx.close();
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
    await managersFlow(browser, ctxOpts, tag, secrets);
    await agenciesFlow(browser, ctxOpts, tag, secrets);
    await roleFlow(browser, ctxOpts, tag, 'crew', secrets, 'crew');
    await roleFlow(browser, ctxOpts, tag, 'disp', secrets, 'dispatcher');
    await roleFlow(browser, ctxOpts, tag, 'mech', secrets, 'mechanic');
  }
  server.kill('SIGTERM'); sh('pkill', ['-f', 'workerd']);
  if (!process.env.E2E_SKIP_EMAIL) {
    await startServer({ port: 8798, persist: '.wrangler/e2e-email', email: true });
    const sq = sh('npx', ['tsx', 'scripts/e2e-seed.ts'], { encoding: 'utf8' });
    if (sq.status) throw new Error(sq.stderr);
    writeFileSync('.wrangler/e2e-seed.sql', sq.stdout); d1('.wrangler/e2e-seed.sql'); rmSync('.wrangler/e2e-seed.sql');
    const es = { adminEmail: 'admin@example.org', adminPass: 'Temp-pass-1234', adminPass2: 'E2E-admin-pass-77', adminForced: true };
    for (const cfg of configs.filter((c) => c.tag.endsWith('light') && (!process.env.E2E_ONLY || c.tag.includes(process.env.E2E_ONLY)))) {
      await emailFlow(browser, cfg, es);
    }
    server.kill('SIGTERM'); sh('pkill', ['-f', 'workerd']);
  }
  await browser.close();
  if (stray.length) { failures++; log('FAIL requests to other hosts:', [...new Set(stray)].slice(0, 5).join(', ')); }
  log(`\n${results.filter((r) => r[0] === 'ok').length} checks passed, ${failures} failed.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server?.kill('SIGTERM'); } catch { /* ignore */ } process.exit(2); });
