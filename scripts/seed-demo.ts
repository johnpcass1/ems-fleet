/**
 * Loads the demo fleet (every record marked "sample" so an administrator can remove it in one click).
 *   npm run seed:demo                 local database
 *   npm run seed:demo -- --remote --yes   live database (only do this on a throwaway/staging database)
 */
import { buildSample } from '../src/shared/sample';
import { docsToStatements, renderSql } from '../src/shared/docs-to-sql';
import { describe, execFile, parseArgs, query, targetFrom } from './lib';

const { flags } = parseArgs(process.argv.slice(2));
const t = targetFrom(flags);
if (t.remote && !flags.yes) {
  console.error('This would add demo data to a LIVE database. If you really mean it, add --yes (use staging, not production).');
  process.exit(1);
}
console.log('Target:', describe(t));
const existing = query('SELECT COUNT(*) AS n FROM vehicles', t)[0]?.n ?? 0;
if (existing > 0) { console.error(`The database already has ${existing} vehicles. Demo data is only added to an empty fleet.`); process.exit(1); }
const { stmts, counts } = docsToStatements(buildSample(), { sample: true });
const sql = ['UPDATE counter SET v = v + 1 WHERE id = 1;', ...stmts.map((s) => renderSql(s))].join('\n');
execFile(sql, t);
console.log('Demo data loaded:', counts);
