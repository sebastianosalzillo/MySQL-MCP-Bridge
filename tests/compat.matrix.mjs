/**
 * Cross-version compatibility matrix.
 *
 * Boots one container per MySQL generation, detects the version through the real
 * connection layer, then drives the actual MCP tool handlers against the live
 * server. Any divergence is reported as a version x capability matrix.
 *
 *   npm run test:matrix
 *   node tests/compat.matrix.mjs 5.6 8.0        # only matching targets
 *   node tests/compat.matrix.mjs --allow-skip   # exit 0 when Docker is absent
 *
 * Requires Docker. MySQL 5.6 images are amd64 only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTools } from '../server/tools.mjs';
import { connectWithFallback, testConnection } from '../server/mysqlManager.mjs';
import { ApprovalManager } from '../server/approvalManager.mjs';

const run = promisify(execFile);

const TARGETS = [
  { image: 'mysql:5.6.51', label: 'MySQL 5.6', expect: { jsonType: false, cte: false } },
  { image: 'mysql:5.7.44', label: 'MySQL 5.7', expect: { jsonType: true, cte: false } },
  { image: 'mysql:8.0', label: 'MySQL 8.0', expect: { jsonType: true, cte: true } },
  { image: 'mysql:8.4', label: 'MySQL 8.4', expect: { jsonType: true, cte: true } },
  { image: 'mysql:9.4', label: 'MySQL 9.x', expect: { jsonType: true, cte: true } },
  { image: 'mariadb:10.11', label: 'MariaDB 10.11', expect: { jsonType: true, cte: true } }
];

const DB = 'bridge_matrix';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const allowSkip = args.includes('--allow-skip');
const filters = args.filter(a => !a.startsWith('--'));

function baseSettings(host, port, mode) {
  return {
    mysql: { host, port, user: 'root', password: '', database: '', collation: 'utf8mb4', tlsMode: 'off', allowTlsFallback: false, connectTimeoutMs: 15000 },
    mcp: {
      accessMode: mode, port: 0, allowedTables: [], selectLimit: 1000, queryTimeoutMs: 30000,
      blockMultipleStatements: true, blockFileAccess: true, allowSlowFunctions: false,
      requireWhereForUpdateDelete: true, confirmUpdate: false, confirmDelete: false,
      confirmDdl: false, enableExecuteSql: true, bearerToken: ''
    },
    ngrok: { enabled: false, authtoken: '', domain: '' }
  };
}

async function docker(args_, opts = {}) {
  return run('docker', args_, { windowsHide: true, maxBuffer: 1024 * 1024, ...opts });
}

async function dockerAvailable() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function startContainer(target) {
  const name = `mysql-mcp-matrix-${target.image.replace(/[^a-z0-9]+/gi, '-')}-${process.pid}`;
  await docker(['rm', '-f', name]).catch(() => {});
  await docker([
    'run', '-d', '--name', name, '-P',
    '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
    '-e', 'MYSQL_ROOT_HOST=%',
    target.image
  ]);
  const { stdout } = await docker(['port', name, '3306/tcp']);
  const port = Number(stdout.split('\n')[0].trim().split(':').pop());
  if (!port) throw new Error(`Could not determine the host port for ${name}: ${JSON.stringify(stdout)}`);
  return { name, port };
}

async function waitReady(port, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const result = await testConnection({
        host: '127.0.0.1', port, user: 'root', password: '', database: '',
        collation: 'utf8mb4', tlsMode: 'off', allowTlsFallback: false, connectTimeoutMs: 5000
      });
      return result;
    } catch (err) {
      lastError = err?.message || String(err);
      await sleep(3000);
    }
  }
  throw new Error(`Server did not become ready: ${lastError}`);
}

function buildHarness(settings, connected) {
  const registry = new Map();
  const logs = [];
  const ctx = {
    pool: connected.pool,
    settings,
    approvals: new ApprovalManager(),
    log: (type, data) => logs.push({ type, data }),
    capabilities: connected.capabilities,
    serverVersion: connected.version,
    tlsMode: connected.tlsMode
  };
  registerTools({ registerTool: (name, _spec, handler) => registry.set(name, handler) }, ctx);
  return { registry, logs };
}

async function call(harness, name, toolArgs) {
  const handler = harness.registry.get(name);
  if (!handler) throw new Error(`Tool ${name} is not registered`);
  const response = await handler(toolArgs || {});
  const text = response?.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { isError: !!response?.isError, text, parsed };
}

/** Assertions return a name plus whether the behaviour matched what the version implies. */
async function runSuite(target, host, port) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

  const info = await waitReady(port);
  const settings = baseSettings(host, port, 'admin');
  const connected = await connectWithFallback(settings);
  const harness = buildHarness(settings, connected);
  const caps = connected.capabilities;

  record('detected version', /^\d+\.\d+\.\d+/.test(info.version || ''), info.version);
  record('capability gate jsonType matches expectation', caps.jsonType === target.expect.jsonType, `got ${caps.jsonType}`);
  record('capability gate cte matches expectation', caps.cte === target.expect.cte, `got ${caps.cte}`);

  let created = await call(harness, 'create_database', { database: DB, if_not_exists: true, charset: 'utf8mb4' });
  record('create_database', !created.isError, created.text.slice(0, 160));

  created = await call(harness, 'list_databases', {});
  record('list_databases hides system schemas', !created.isError && (created.parsed || []).some(d => d.database === DB));
  record('list_databases excludes information_schema', !created.isError && !(created.parsed || []).some(d => d.database === 'information_schema'));

  // A plain table must work everywhere.
  let table = await call(harness, 'create_table', {
    table: 'items', database: DB, if_not_exists: true,
    columns: [
      { name: 'id', type: 'INT', nullable: false, primary_key: true, auto_increment: true },
      { name: 'label', type: 'VARCHAR(255)', nullable: false },
      { name: 'qty', type: 'INT', nullable: true, default_value: 0 }
    ]
  });
  record('create_table (base types)', !table.isError, table.text.slice(0, 200));

  // JSON is the sharpest version gate we have.
  const json = await call(harness, 'create_table', {
    table: 'json_probe', database: DB, if_not_exists: true,
    columns: [
      { name: 'id', type: 'INT', nullable: false, primary_key: true },
      { name: 'payload', type: 'JSON', nullable: true }
    ]
  });
  if (caps.jsonType) {
    record('create_table with JSON column', !json.isError, json.text.slice(0, 200));
  } else {
    record('create_table with JSON column is rejected before hitting the server', json.isError && /5\.7\.8/.test(json.text), json.text.slice(0, 200));
  }

  let ddl = await call(harness, 'insert_rows', { table: 'items', database: DB, values: { label: 'first', qty: 3 } });
  record('insert_rows', !ddl.isError, ddl.text.slice(0, 160));

  ddl = await call(harness, 'select_rows', { table: 'items', database: DB, where: { qty: { $gte: 1 }, label: { $like: 'fir%' } }, limit: 10 });
  record('select_rows with operators', !ddl.isError && ddl.parsed?.count === 1, ddl.text.slice(0, 200));

  ddl = await call(harness, 'select_rows', { table: 'items', database: DB, where: { id: 999999 } });
  record('select_rows returns no rows when nothing matches', !ddl.isError && ddl.parsed?.count === 0);

  ddl = await call(harness, 'update_rows', { table: 'items', database: DB, values: { qty: 7 }, where: { label: 'first' } });
  record('update_rows', !ddl.isError && ddl.parsed?.affectedRows === 1, ddl.text.slice(0, 160));

  ddl = await call(harness, 'describe_table', { table: 'items', database: DB });
  record('describe_table', !ddl.isError && Array.isArray(ddl.parsed?.columns) && ddl.parsed.columns.length === 3, ddl.text.slice(0, 160));

  ddl = await call(harness, 'show_create_table', { table: 'items', database: DB });
  record('show_create_table', !ddl.isError && /CREATE TABLE/.test(ddl.parsed?.ddl || ''), ddl.text.slice(0, 160));

  ddl = await call(harness, 'get_foreign_keys', { table: 'items', database: DB });
  record('get_foreign_keys', !ddl.isError, ddl.text.slice(0, 160));

  // The 767 byte InnoDB limit on 5.6 is the other sharp gate.
  ddl = await call(harness, 'create_index', { table: 'items', database: DB, index: 'idx_label', columns: ['label'] });
  record('create_index on VARCHAR(255) utf8mb4', !ddl.isError, ddl.text.slice(0, 220));

  ddl = await call(harness, 'add_column', { table: 'items', database: DB, column: 'note', type: 'VARCHAR(64)', nullable: true, position: 'AFTER', after_column: 'label' });
  record('add_column with position', !ddl.isError, ddl.text.slice(0, 200));

  ddl = await call(harness, 'modify_column', { table: 'items', database: DB, column: 'note', type: 'VARCHAR(128)', nullable: false, default_value: 'n/a' });
  record('modify_column', !ddl.isError, ddl.text.slice(0, 200));

  ddl = await call(harness, 'add_column', { table: 'items', database: DB, column: 'instant_col', type: 'INT', algorithm: 'INSTANT' });
  record(caps.instantAddColumn ? 'add_column ALGORITHM=INSTANT' : 'add_column ALGORITHM=INSTANT rejected below 8.0.12',
    caps.instantAddColumn ? !ddl.isError : (ddl.isError && /8\.0\.12|not supported/i.test(ddl.text)), ddl.text.slice(0, 200));

  ddl = await call(harness, 'drop_index', { table: 'items', database: DB, index: 'idx_label' });
  record('drop_index', !ddl.isError, ddl.text.slice(0, 160));

  ddl = await call(harness, 'explain_query', { sql: 'SELECT * FROM items' });
  record('explain_query', !ddl.isError, ddl.text.slice(0, 160));

  // Security: READ ONLY must not be bypassable.
  settings.mcp.accessMode = 'read';
  ddl = await call(harness, 'execute_sql', { sql: 'SELECT 1' });
  record('execute_sql SELECT allowed in READ ONLY', !ddl.isError, ddl.text.slice(0, 160));

  const cte = await call(harness, 'execute_sql', { sql: 'WITH c AS (SELECT 1) DELETE FROM items' });
  record('execute_sql rejects DELETE hidden behind WITH in READ ONLY', cte.isError && /Requires WRITE/.test(cte.text), cte.text.slice(0, 200));

  const fileWrite = await call(harness, 'execute_sql', { sql: "SELECT 1 INTO OUTFILE '/tmp/x'" });
  record('execute_sql rejects INTO OUTFILE', fileWrite.isError && /Blocked construct/.test(fileWrite.text), fileWrite.text.slice(0, 200));

  const multi = await call(harness, 'execute_sql', { sql: 'SELECT 1; DROP TABLE items' });
  record('execute_sql rejects multiple statements', multi.isError && /Multiple statements/.test(multi.text), multi.text.slice(0, 200));

  settings.mcp.accessMode = 'admin';
  ddl = await call(harness, 'execute_sql', { sql: 'SELECT COUNT(*) AS total FROM items' });
  record('execute_sql SELECT in ADMIN', !ddl.isError && ddl.parsed?.rows?.[0]?.total >= 1, ddl.text.slice(0, 160));

  ddl = await call(harness, 'delete_rows', { table: 'items', database: DB, where: { label: 'first' } });
  record('delete_rows with WHERE', !ddl.isError && ddl.parsed?.affectedRows === 1, ddl.text.slice(0, 160));

  ddl = await call(harness, 'drop_table', { table: 'json_probe', database: DB, if_exists: true });
  record('drop_table', !ddl.isError, ddl.text.slice(0, 160));
  ddl = await call(harness, 'drop_table', { table: 'items', database: DB });
  record('drop_table without if_exists', !ddl.isError, ddl.text.slice(0, 160));
  ddl = await call(harness, 'drop_database', { database: DB });
  record('drop_database', !ddl.isError, ddl.text.slice(0, 160));

  // A saved MySQL 8 collation must still connect to an older server.
  const legacyCollation = { ...baseSettings(host, port, 'read') };
  legacyCollation.mysql.collation = 'utf8mb4-unicode';
  legacyCollation.mysql.allowTlsFallback = true;
  let collationOk = false;
  try {
    const retry = await connectWithFallback(legacyCollation);
    collationOk = /^\d+\.\d+\.\d+/.test(await retry.pool.query('SELECT VERSION() AS v').then(([r]) => r[0].v || ''));
    await retry.pool.end();
  } catch (err) {
    collationOk = false;
    record('utf8mb4_0900_ai_ci falls back for older servers', false, err.message.slice(0, 200));
  }
  if (collationOk) record('utf8mb4_0900_ai_ci falls back for older servers', true);

  // TLS is informational: the official 5.6 image ships with TLS disabled.
  let tlsNote = 'not attempted';
  try {
    const tlsSettings = baseSettings(host, port, 'read');
    tlsSettings.mysql.tlsMode = 'verify-full';
    tlsSettings.mysql.allowTlsFallback = true;
    const tls = await connectWithFallback(tlsSettings);
    await tls.pool.query('SELECT 1');
    await tls.pool.end();
    tlsNote = 'verify-full ok (or ladder succeeded)';
  } catch (err) {
    tlsNote = `no usable TLS (${(err.message || '').slice(0, 80)})`;
  }

  await connected.pool.end();
  return { checks, tlsNote, version: info.version, capabilities: caps };
}

async function main() {
  if (!(await dockerAvailable())) {
    const message = 'Docker is not reachable. Start Docker Desktop and run this again.';
    if (allowSkip) { console.log(`SKIP: ${message}`); return 0; }
    console.error(`ERROR: ${message}`);
    console.error('Use "npm run test:matrix -- --allow-skip" to skip when Docker is unavailable.');
    return 1;
  }

  const targets = filters.length
    ? TARGETS.filter(t => filters.some(f => t.image.includes(f) || t.label.toLowerCase().includes(f.toLowerCase())))
    : TARGETS;

  if (!targets.length) {
    console.error(`No matrix target matches: ${filters.join(', ')}`);
    return 1;
  }

  const results = [];
  for (const target of targets) {
    console.log(`\n=== ${target.label} (${target.image}) ===`);
    let container = null;
    try {
      container = await startContainer(target);
      console.log(`  container ${container.name} on 127.0.0.1:${container.port}`);
      const outcome = await runSuite(target, '127.0.0.1', container.port);
      results.push({ target, ...outcome });
      for (const check of outcome.checks) {
        console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.ok || !check.detail ? '' : `\n          ${check.detail}`}`);
      }
      console.log(`  TLS: ${outcome.tlsNote}`);
    } catch (err) {
      console.log(`  FAIL  suite crashed: ${err?.message || String(err)}`);
      results.push({ target, checks: [{ name: 'suite completed', ok: false, detail: err?.message || String(err) }], tlsNote: 'n/a', version: 'n/a' });
    } finally {
      if (container) await docker(['rm', '-f', container.name]).catch(() => {});
    }
  }

  console.log('\n================ compatibility matrix ================');
  const names = [...new Set(results.flatMap(r => r.checks.map(c => c.name)))];
  const header = ['check'.padEnd(58), ...results.map(r => r.target.label.padEnd(12))].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const name of names) {
    const cells = results.map(r => {
      const check = r.checks.find(c => c.name === name);
      return (check ? (check.ok ? 'pass' : 'FAIL') : '  -  ').padEnd(12);
    });
    console.log([name.slice(0, 58).padEnd(58), ...cells].join(' '));
  }
  console.log('-'.repeat(header.length));
  for (const r of results) console.log(`${r.target.label.padEnd(14)} version=${String(r.version).padEnd(24)} json=${String(r.capabilities?.jsonType).padEnd(6)} cte=${String(r.capabilities?.cte).padEnd(6)} indexKey=${r.capabilities?.maxIndexKeyBytes}`);

  const failed = results.flatMap(r => r.checks.filter(c => !c.ok).map(c => `${r.target.label}: ${c.name}`));
  console.log(failed.length ? `\n${failed.length} failing check(s):\n- ${failed.join('\n- ')}` : '\nAll checks passed.');
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err);
  process.exit(1);
});
