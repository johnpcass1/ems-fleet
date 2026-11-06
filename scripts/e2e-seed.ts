// Prints the SQL the e2e run loads: the demo fleet plus one system administrator with a known temporary password.
import { buildSample } from '../src/shared/sample';
import { docsToStatements, renderSql, sqlLiteral as L } from '../src/shared/docs-to-sql';
import { hashPassword } from '../src/worker/auth';

const { stmts } = docsToStatements(buildSample(), { sample: true });
const now = new Date().toISOString();
const h = await hashPassword('Temp-pass-1234', 2000);
console.log([
  'UPDATE counter SET v = v + 1 WHERE id = 1;',
  ...stmts.map(renderSql),
  `INSERT INTO users (id,email,name,role,base_ids,mechanic_id,password_hash,active,must_change_password,seq,created_at,updated_at) VALUES ('u_e2e','admin@example.org','E2E Admin','system_admin','[]',NULL,${L(h)},1,1,(SELECT v FROM counter WHERE id=1),${L(now)},${L(now)});`,
].join('\n'));
