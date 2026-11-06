// Turns a nightly backup file into a SQL script that replaces the database contents with the backup.
//   node scripts/restore-from-backup.mjs backups/2026-11-05.json.gz > restore.sql
//   npx wrangler d1 execute DB --remote --file restore.sql --yes      (leave off --remote to try it locally first)
// It DELETES the current data. Users get logged out because sessions are cleared.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/restore-from-backup.mjs <backup.json.gz> > restore.sql'); process.exit(1); }
const raw = readFileSync(file);
const json = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8'));
if (json.app !== 'gema-fleet' || !json.tables) { console.error('That does not look like a GEMA Fleet backup.'); process.exit(1); }

const ORDER = ['counter', 'tombstones', 'bases', 'pm_programs', 'pm_tasks', 'mechanics', 'parts', 'settings', 'vehicles', 'vehicle_pm', 'meter_readings', 'status_events', 'moves',
  'issues', 'work_orders', 'work_order_lines', 'wo_issue_links', 'wo_pm_tasks', 'attachments', 'users', 'audit_log'];
const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const out = ['PRAGMA defer_foreign_keys = ON;', 'DELETE FROM sessions;', 'DELETE FROM login_attempts;'];
for (const t of [...ORDER].reverse()) out.push(`DELETE FROM ${t};`);
for (const t of ORDER) for (const row of json.tables[t] || []) {
  const cols = Object.keys(row);
  out.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(row[c])).join(', ')});`);
}
console.log(out.join('\n'));
console.error(`Backup from ${json.createdAt}: ${ORDER.map((t) => `${t} ${(json.tables[t] || []).length}`).join(', ')}`);
