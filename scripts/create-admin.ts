/**
 * Creates the first system administrator (or another one later).
 *   npm run create-admin -- --email you@example.org --name "Your Name" [--remote] [--env staging]
 * A temporary password is printed once. Give it to the person directly; they must choose their own at first login.
 */
import { hashPassword, tempPassword, DEFAULT_ITERATIONS } from '../src/worker/auth';
import { sqlLiteral } from '../src/shared/docs-to-sql';
import { describe, execFile, parseArgs, query, targetFrom } from './lib';

const { flags } = parseArgs(process.argv.slice(2));
const email = String(flags.email ?? '').trim().toLowerCase();
const name = String(flags.name ?? '').trim();
if (!/^\S+@\S+\.\S+$/.test(email) || !name) {
  console.error('Usage: npm run create-admin -- --email you@example.org --name "Your Name" [--remote] [--env staging]');
  process.exit(1);
}
const t = targetFrom(flags);
console.log('Target:', describe(t));
if (query(`SELECT 1 AS x FROM users WHERE email = ${sqlLiteral(email)}`, t).length) { console.error('A user with that email already exists.'); process.exit(1); }

const iterations = Number(process.env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS;
const pw = tempPassword();
const hash = await hashPassword(pw, iterations);
const now = new Date().toISOString();
const id = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const L = sqlLiteral;
execFile(
  `UPDATE counter SET v = v + 1 WHERE id = 1;
INSERT INTO users (id, email, name, role, base_ids, mechanic_id, password_hash, active, must_change_password, seq, created_at, updated_at) VALUES (${L(id)}, ${L(email)}, ${L(name)}, 'system_admin', '[]', NULL, ${L(hash)}, 1, 1, (SELECT v FROM counter WHERE id = 1), ${L(now)}, ${L(now)});
INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, created_at, updated_at) VALUES (${L(now)}, NULL, 'create-admin script', 'user.create', 'user', ${L(id)}, ${L(now)}, ${L(now)});`,
  t,
);
console.log(`\nCreated system administrator ${name} <${email}>.\n\n  Temporary password:  ${pw}\n\nThis is shown only once. Give it to them directly. They will be asked to choose their own password at first login.`);
