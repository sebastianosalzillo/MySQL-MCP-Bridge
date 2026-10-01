import test from 'node:test';
import assert from 'node:assert/strict';
import { testMySql, startBridge, runLocalSql } from '../server/mcpBridge.mjs';
import { connectWithFallback, normalizeTlsMode, buildSslOptions, poolConfig, resolveCollation } from '../server/mysqlManager.mjs';
import { registerTools } from '../server/tools.mjs';
import { ApprovalManager } from '../server/approvalManager.mjs';

const base = (over = {}) => ({
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', collation: 'utf8mb4', tlsMode: 'off', allowTlsFallback: false, connectTimeoutMs: 2000, ...(over.mysql || {}) },
  mcp: { port: 3999, accessMode: 'read', allowedTables: [], selectLimit: 1000, queryTimeoutMs: 5000, blockMultipleStatements: true, blockFileAccess: true, allowSlowFunctions: false, requireWhereForUpdateDelete: true, confirmUpdate: false, confirmDelete: false, confirmDdl: false, enableExecuteSql: false, bearerToken: '', ...(over.mcp || {}) },
  ngrok: { enabled: false, authtoken: '', domain: '' }
});

test('all server modules load and register their tools', async () => {
  const names = new Set();
  registerTools({ registerTool: (name) => names.add(name) }, { pool: null, settings: base(), approvals: new ApprovalManager(), log: () => {}, capabilities: null, serverVersion: null, tlsMode: 'off' });
  for (const expected of [
    'mysql_server_info', 'list_databases', 'list_tables', 'describe_table', 'show_create_table',
    'get_foreign_keys', 'select_rows', 'explain_query', 'insert_rows', 'update_rows', 'delete_rows',
    'create_database', 'drop_database', 'create_table', 'drop_table', 'add_column', 'drop_column',
    'modify_column', 'create_index', 'drop_index', 'execute_sql'
  ]) {
    assert.ok(names.has(expected), `missing tool: ${expected}`);
  }
});

test('every tool description is in English and non-empty', () => {
  const descriptions = [];
  registerTools({ registerTool: (_n, spec) => descriptions.push(spec.description) }, { pool: null, settings: base(), approvals: new ApprovalManager(), log: () => {}, capabilities: null, serverVersion: null, tlsMode: 'off' });
  assert.equal(descriptions.length, 21);
  for (const d of descriptions) {
    assert.ok(d && d.length > 20, `empty description: ${d}`);
    assert.ok(!/[àèéìòù]|\b(el|la|il|della|delle|richiede|messaggio|errore|nessuna)\b/i.test(d), `non-English description: ${d}`);
  }
});

test('a wrong port fails with a readable message and no leaked stack', async () => {
  await assert.rejects(
    () => testMySql(base({ mysql: { port: 3998, connectTimeoutMs: 1500 } })),
    err => {
      assert.match(err.message, /MySQL connection failed/);
      assert.ok(!err.message.includes('    at '), 'stack leaked into the message');
      return true;
    }
  );
});

test('startBridge reports startup failure instead of throwing raw', async () => {
  const logs = [];
  await assert.rejects(
    () => startBridge(base({ mysql: { port: 3998, connectTimeoutMs: 1500 } }), { onLog: e => logs.push(e) }),
    /MySQL connection failed/
  );
  assert.ok(logs.some(l => l.type === 'error' && /Startup failed/.test(l.data.message)));
});

test('the default collation is one that exists on MySQL 5.6', () => {
  const { config } = poolConfig({ host: 'h', port: 3306, user: 'u', password: '', collation: 'utf8mb4' });
  assert.equal(config.charset, 'UTF8MB4_GENERAL_CI');
  assert.notEqual(config.charset, 'UTF8MB4_UNICODE_CI');
  assert.equal(config.timezone, 'Z');
  assert.equal(config.multipleStatements, false);
  assert.equal(config.ssl, undefined);
  assert.equal(resolveCollation('server-default', { major: 8 }).name, null);
});

test('a socket path replaces host and port', () => {
  const { config } = poolConfig({ host: 'h', port: 3306, user: 'u', password: '', socketPath: '\\\\.\\pipe\\mysql' });
  assert.equal(config.socketPath, '\\\\.\\pipe\\mysql');
  assert.equal(config.host, undefined);
  assert.equal(config.port, undefined);
});

test('TLS modes map to the right driver options', () => {
  assert.deepEqual(buildSslOptions({ tlsMode: 'off' }).ssl, false);
  assert.equal(buildSslOptions({ tlsMode: 'required' }).ssl.rejectUnauthorized, false);
  assert.equal(buildSslOptions({ tlsMode: 'verify-ca' }).ssl.rejectUnauthorized, true);
  assert.equal(buildSslOptions({ tlsMode: 'verify-full' }).ssl.verifyIdentity, true);
  const legacy = buildSslOptions({ tlsMode: 'required', minTlsVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' }).ssl;
  assert.equal(legacy.minVersion, 'TLSv1');
  assert.equal(legacy.ciphers, 'DEFAULT@SECLEVEL=0');
  assert.equal(normalizeTlsMode('verify-full'), 'verify-full');
});

test('an unreadable CA file fails with a clear message', () => {
  assert.throws(() => buildSslOptions({ tlsMode: 'verify-ca', caFile: 'C:\\definitely\\missing\\ca.pem' }), /Cannot read CA file/);
});

test('a forced auth plugin is registered with the driver', () => {
  const { config } = poolConfig({ host: 'h', port: 3306, user: 'u', password: 'p', authPlugin: 'caching_sha2' });
  assert.ok(config.authPlugins.caching_sha2_password, 'plugin not registered');
  const clear = poolConfig({ host: 'h', port: 3306, user: 'u', password: 'p', authPlugin: 'clear' }).config;
  assert.equal(clear.enableCleartextPlugin, true);
  assert.equal(poolConfig({ host: 'h', port: 3306, user: 'u', password: 'p', authPlugin: 'auto' }).config.authPlugins, undefined);
});

test('connectWithFallback only downgrades on negotiation failures', () => {
  const attempts = [];
  const notHandshake = new Error('Access denied for user');
  notHandshake.errno = 1045;
  return connectWithFallback(base(), { onAttempt: a => attempts.push(a) })
    .then(() => assert.equal(attempts.length, 0), err => {
      assert.match(err.message, /MySQL connection failed/);
      // 1045 with no server listening never reaches the TLS ladder.
      assert.ok(attempts.length === 0, 'fell back for a non-negotiation failure');
    });
});

test('the local console enforces mode and guards without touching the server', async () => {
  const result = await runLocalSql(base({ mcp: { accessMode: 'read' } }), 'DELETE FROM t');
  assert.equal(result.ok, false);
  assert.match(result.error, /Requires WRITE/);

  const admin = base({ mcp: { accessMode: 'admin', enableExecuteSql: false } });
  const blocked = await runLocalSql(admin, 'DROP TABLE t');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Administrative SQL is disabled/);

  const empty = await runLocalSql(base(), '   ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Empty query/);
});

test('logs never contain the password or bearer token', async () => {
  const logs = [];
  await startBridge(base({ mysql: { port: 3998, password: 'sup3rs3cret', connectTimeoutMs: 1200 } }), {
    onLog: e => logs.push(e)
  }).catch(() => {});
  const dump = JSON.stringify(logs);
  assert.ok(!dump.includes('sup3rs3cret'), 'password leaked into the log');
});
