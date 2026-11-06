/** Shared helpers for the maintenance scripts. They talk to D1 through wrangler, so the Cloudflare login you already use for deploys is what they use. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Target { remote: boolean; env: string | null }

export function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}
export const targetFrom = (flags: Record<string, string | true>): Target => ({ remote: !!flags.remote, env: typeof flags.env === 'string' ? flags.env : null });
export const describe = (t: Target) => `${t.remote ? 'REMOTE (live Cloudflare D1)' : 'local (wrangler dev database)'}${t.env ? `, environment "${t.env}"` : ''}`;

function wrangler(args: string[], t: Target) {
  const full = ['wrangler', 'd1', 'execute', 'DB', t.remote ? '--remote' : '--local', ...(t.env ? ['--env', t.env] : []), ...args];
  const r = spawnSync('npx', full, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
/** Run a whole SQL script (many statements). */
export function execFile(sql: string, t: Target) {
  const dir = mkdtempSync(join(tmpdir(), 'gema-'));
  const f = join(dir, 'script.sql');
  try { writeFileSync(f, sql); return wrangler(['--file', f, '--yes'], t); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function query(sql: string, t: Target): any[] {
  const out = wrangler(['--command', sql, '--json'], t);
  const j = JSON.parse(out.slice(out.indexOf('[')));
  return j[0]?.results ?? [];
}
