import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
});

// Every test starts from an empty database and an empty bucket.
beforeEach(async () => {
  const db = (env as any).DB as D1Database;
  const tables = [
    'audit_log', 'login_attempts', 'sessions', 'attachments', 'users', 'wo_pm_tasks', 'wo_issue_links', 'work_order_lines', 'work_orders', 'issues', 'moves', 'status_events', 'meter_readings',
    'vehicle_pm', 'vehicles', 'pm_tasks', 'pm_programs', 'parts', 'mechanics', 'settings', 'bases', 'tombstones', 'backup_jobs',
  ];
  await db.batch([...tables.map((t) => db.prepare(`DELETE FROM ${t}`)), db.prepare('UPDATE counter SET v = 0')]);
  const bucket = (env as any).FILES as R2Bucket;
  let cursor: string | undefined;
  do {
    const l = await bucket.list({ cursor });
    if (l.objects.length) await bucket.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
});
