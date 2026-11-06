/**
 * Creates the first system administrator (or another one later).
 *   npm run create-admin -- --email you@example.org --name "Your Name" [--remote] [--env staging]
 * Three ways to give them access:
 *   (default)           a temporary password is printed once; they must choose their own at first login.
 *   --password-prompt   you type the password at a hidden prompt (it never appears on the command line or in shell history);
 *                       they are NOT forced to change it.
 *   --invite            no password at all: prints a set-password link (valid 7 days) to open in a browser. No email is sent,
 *                       so this works before email is set up. Add --app-url https://... if the address below is wrong.
 */
import { readFileSync } from 'node:fs';
import { hashPassword, tempPassword, passwordProblem, sha256Hex, b64url, DEFAULT_ITERATIONS } from '../src/worker/auth';
import { sqlLiteral } from '../src/shared/docs-to-sql';
import { describe, execFile, parseArgs, promptHidden, query, targetFrom } from './lib';

const { flags } = parseArgs(process.argv.slice(2));
const email = String(flags.email ?? '').trim().toLowerCase();
const name = String(flags.name ?? '').trim();
if (!/^\S+@\S+\.\S+$/.test(email) || !name) {
  console.error('Usage: npm run create-admin -- --email you@example.org --name "Your Name" [--password-prompt | --invite] [--remote] [--env staging]');
  process.exit(1);
}
if (flags.invite && flags['password-prompt']) { console.error('Use either --invite or --password-prompt, not both.'); process.exit(1); }
const t = targetFrom(flags);
console.log('Target:', describe(t));
if (query(`SELECT 1 AS x FROM users WHERE email = ${sqlLiteral(email)}`, t).length) { console.error('A user with that email already exists.'); process.exit(1); }

const iterations = Number(process.env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS;
const L = sqlLiteral;
const now = new Date().toISOString();
const id = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

/** Where the invite link points: --app-url, else APP_URL from wrangler.jsonc (staging block for --env staging), else the local dev address. */
function appUrl(): string {
  if (typeof flags['app-url'] === 'string') return flags['app-url'].replace(/\/+$/, '');
  if (!t.remote) return 'http://localhost:8787';
  const m = [...readFileSync('wrangler.jsonc', 'utf8').matchAll(/"APP_URL":\s*"([^"]+)"/g)].map((x) => x[1]);
  return (t.env === 'staging' ? m[1] : m[0])?.replace(/\/+$/, '') ?? 'http://localhost:8787';
}

let hash: string, mustChange = 1, pw = '', token = '';
if (flags.invite) {
  hash = 'unusable$' + b64url(crypto.getRandomValues(new Uint8Array(16)));
  token = b64url(crypto.getRandomValues(new Uint8Array(32)));
} else if (flags['password-prompt']) {
  let again = '';
  try {
    pw = await promptHidden('Password for the new administrator (hidden): ');
    again = await promptHidden('Type it again: ');
  } catch (e: any) { console.error(e.message); process.exit(1); }
  const problem = pw !== again ? 'The two passwords do not match.' : passwordProblem(pw, email);
  if (problem) { console.error(problem); process.exit(1); }
  hash = await hashPassword(pw, iterations);
  mustChange = 0;
} else {
  pw = tempPassword();
  hash = await hashPassword(pw, iterations);
}
const tokenSql = token
  ? `\nINSERT INTO account_tokens (id, user_id, purpose, token_hash, expires_at, used_at, created_at, created_by) VALUES (${L('tk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20))}, ${L(id)}, 'invite', ${L(await sha256Hex(token))}, ${L(new Date(Date.now() + 7 * 864e5).toISOString())}, NULL, ${L(now)}, NULL);`
  : '';
execFile(
  `UPDATE counter SET v = v + 1 WHERE id = 1;
INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at) VALUES (${L(id)}, ${L(email)}, ${L(name)}, 'system_admin', '[]', NULL, ${L(hash)}, 1, ${mustChange}, (SELECT v FROM counter WHERE id = 1), ${L(now)}, ${L(now)});${tokenSql}
INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, created_at, updated_at) VALUES (${L(now)}, NULL, 'create-admin script', 'user.create', 'user', ${L(id)}, ${L(now)}, ${L(now)});`,
  t,
);
console.log(`\nCreated system administrator ${name} <${email}>.`);
if (flags.invite) {
  console.log(`\n  Set-password link (valid 7 days, works once):\n\n  ${appUrl()}/set-password#t=${token}\n\nOpen it in a browser to choose a password. Check that the address at the start is the real address of the app; if not, use the part from /set-password onward on the right address.`);
} else if (flags['password-prompt']) {
  console.log('\nThe password you typed is set. They are not asked to change it, but can at any time with the Password button.');
} else {
  console.log(`\n  Temporary password:  ${pw}\n\nThis is shown only once. Give it to them directly. They will be asked to choose their own password at first login.`);
}
