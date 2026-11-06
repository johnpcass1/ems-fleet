// Local development: build the front end, make sure the local database has its tables, then start the Worker with static assets.
import { spawnSync, spawn } from 'node:child_process';
const run = (args) => { const r = spawnSync('npx', args, { stdio: 'inherit' }); if (r.status) process.exit(r.status); };
run(['vite', 'build']);
run(['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local']);
const child = spawn('npx', ['wrangler', 'dev', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 0));
