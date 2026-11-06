/**
 * Imports data exported from the prototype: a folder with one sub-folder per collection and one JSON file per record,
 * or a single JSON file shaped { "vehicles": [...], "bases": [...] }.
 *   npm run import:prototype -- ./export-folder [--remote] [--env staging] [--keep-sample]
 * Records keep their ids. Importing twice fails on the duplicate ids, which protects you from doubling the data.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { docsToStatements, renderSql, type DocMap } from '../src/shared/docs-to-sql';
import { describe, execFile, parseArgs, query, targetFrom } from './lib';

const { flags, rest } = parseArgs(process.argv.slice(2));
const src = rest[0];
if (!src || !existsSync(src)) { console.error('Usage: npm run import:prototype -- <folder-or-json-file> [--remote] [--env staging]'); process.exit(1); }
const t = targetFrom(flags);

function load(p: string): DocMap {
  if (statSync(p).isFile()) return JSON.parse(readFileSync(p, 'utf8'));
  const out: DocMap = {};
  for (const c of readdirSync(p)) {
    const d = join(p, c);
    if (!statSync(d).isDirectory()) continue;
    out[c] = readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => {
      let doc = JSON.parse(readFileSync(join(d, f), 'utf8'));
      // An export may wrap each record as { id, data, version }; unwrap it.
      if (doc && typeof doc.data === 'object' && doc.data && !Array.isArray(doc.data) && 'version' in doc) doc = { ...doc.data, id: doc.id };
      // The file name is the record id when the record itself does not carry one.
      if (!doc.id) doc.id = f.replace(/\.json$/, '');
      return doc;
    });
  }
  return out;
}
const data = load(src);
if (!flags['keep-sample']) for (const c of Object.keys(data)) data[c] = data[c].filter((d: any) => !d.sample);
console.log('Target:', describe(t));
const userIds = new Set<string>(query('SELECT id FROM users', t).map((r) => r.id));
const { stmts, counts, skipped } = docsToStatements(data, { userIds });
if (!stmts.length) { console.log('Nothing to import.'); process.exit(0); }
const sql = ['UPDATE counter SET v = v + 1 WHERE id = 1;', ...stmts.map((s) => renderSql(s))].join('\n');
execFile(sql, t);
console.log('Imported:', counts);
for (const s of skipped) console.log('Skipped:', s);
