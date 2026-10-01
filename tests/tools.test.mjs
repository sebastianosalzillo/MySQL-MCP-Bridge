import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../server/tools.mjs';
import { ApprovalManager } from '../server/approvalManager.mjs';
import { buildCapabilities, parseServerVersion } from '../server/mysqlVersion.mjs';

// MySQL 8.4 reports information_schema columns in upper case, so every fake row
// below is keyed that way on purpose: these tests fail if the tools read a row
// with lower case keys only.
const TABLE_ROWS = [{
  ENGINE: 'InnoDB',
  ROW_FORMAT: 'Dynamic',
  TABLE_COLLATION: 'utf8mb4_0900_ai_ci',
  CREATE_OPTIONS: ''
}];

const COLUMN_ROWS = [
  { COLUMN_NAME: 'id', DATA_TYPE: 'int', CHARACTER_MAXIMUM_LENGTH: null, CHARACTER_SET_NAME: null },
  { COLUMN_NAME: 'email', DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 190, CHARACTER_SET_NAME: 'utf8mb4' },
  { COLUMN_NAME: 'notes', DATA_TYPE: 'text', CHARACTER_MAXIMUM_LENGTH: 65535, CHARACTER_SET_NAME: 'utf8mb4' },
  { COLUMN_NAME: 'score', DATA_TYPE: 'double', CHARACTER_MAXIMUM_LENGTH: null, CHARACTER_SET_NAME: null }
];

const settings = (over = {}) => ({
  mysql: { database: 'shop' },
  mcp: {
    accessMode: 'admin', allowedTables: [], selectLimit: 1000, queryTimeoutMs: 5000,
    blockMultipleStatements: true, blockFileAccess: true, allowSlowFunctions: false,
    requireWhereForUpdateDelete: true, confirmUpdate: false, confirmDelete: false,
    confirmDdl: false, enableExecuteSql: true, bearerToken: '', ...(over.mcp || {})
  }
});

/**
 * Runs a tool against a scripted pool. `respond(sql, values)` returns the rows
 * the fake server would send back; every statement is recorded in `seen`.
 */
function harness(respond, settingsOverrides = {}) {
  const seen = [];
  const pool = {
    getConnection: async () => ({
      query: async ({ sql }, values) => {
        seen.push(sql);
        return [respond(sql, values), []];
      },
      release() {},
      destroy() {}
    })
  };
  const version = parseServerVersion('8.4.3');
  const tools = new Map();
  registerTools(
    { registerTool: (name, spec, handler) => tools.set(name, handler) },
    {
      pool,
      settings: settings(settingsOverrides),
      approvals: new ApprovalManager(),
      log: () => {},
      capabilities: buildCapabilities(version),
      serverVersion: version,
      tlsMode: 'off'
    }
  );

  const call = async (name, args = {}) => {
    const res = await tools.get(name)(args);
    const text = res.content?.[0]?.text ?? '';
    return { ...res, text, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };
  return { call, seen };
}

test('mysql_server_info survives the CURRENT_USER reserved word', async () => {
  // MySQL 8.3+ rejects an unquoted current_user alias, which is how the tool used
  // to fail on every call.
  const { call, seen } = harness(sql => {
    assert.doesNotMatch(sql, /AS\s+current_user\b/, 'current_user alias must be quoted');
    return [{ database_name: 'shop', current_user: 'root@localhost', connection_id: 7 }];
  });
  const res = await call('mysql_server_info');
  assert.equal(res.isError, undefined);
  assert.equal(res.body.session.current_user, 'root@localhost');
  assert.equal(res.body.server, 'MySQL 8.4.3');
  assert.ok(seen.length === 1);
});

test('create_index resolves columns from upper case information_schema rows', async () => {
  const { call, seen } = harness((sql) => {
    if (/information_schema\.tables/.test(sql)) return TABLE_ROWS;
    if (/information_schema\.columns/.test(sql)) return COLUMN_ROWS;
    return { affectedRows: 0 };
  });
  const res = await call('create_index', { table: 'people', index: 'idx_score', columns: ['score'] });
  assert.equal(res.isError, undefined);
  assert.ok(seen.at(-1).startsWith('CREATE INDEX `idx_score` ON `shop`.`people` (`score`)'), seen.at(-1));
});

test('create_index still rejects a column that really does not exist', async () => {
  const { call } = harness((sql) => (/information_schema\.tables/.test(sql) ? TABLE_ROWS : COLUMN_ROWS));
  const res = await call('create_index', { table: 'people', index: 'idx_ghost', columns: ['ghost'] });
  assert.equal(res.isError, true);
  assert.match(res.text, /Column 'ghost' does not exist/);
});

test('create_index sizes a prefix from the real character set', async () => {
  const { call, seen } = harness((sql) => {
    if (/information_schema\.tables/.test(sql)) return TABLE_ROWS;
    if (/information_schema\.columns/.test(sql)) return COLUMN_ROWS;
    return { affectedRows: 0 };
  });
  const res = await call('create_index', { table: 'people', index: 'idx_notes', columns: ['notes'] });
  assert.equal(res.isError, undefined);
  // utf8mb4 costs 4 bytes per character, so 3072 bytes allow 768 characters.
  assert.match(seen.at(-1), /\(`notes`\(768\)\)/);
  assert.match(res.body.notes[0], /768 character prefix/);
});

test('create_index rejects a prefix wider than the key budget', async () => {
  const { call } = harness((sql) => (/information_schema\.tables/.test(sql) ? TABLE_ROWS : COLUMN_ROWS));
  const res = await call('create_index', { table: 'people', index: 'idx_email', columns: ['email'], prefix_length: 9999 });
  assert.equal(res.isError, true);
  assert.match(res.text, /exceeds the 3072 byte index limit for email \(max 768 characters\)/);
});

test('modify_column can change nullability without being given the type', async () => {
  const { call, seen } = harness((sql) => {
    if (/information_schema\.columns/.test(sql)) {
      return [{ COLUMN_TYPE: 'varchar(190)', IS_NULLABLE: 'NO' }];
    }
    return { affectedRows: 0 };
  });
  const res = await call('modify_column', { table: 'people', column: 'email', nullable: true });
  assert.equal(res.isError, undefined);
  assert.equal(seen.at(-1), 'ALTER TABLE `shop`.`people` MODIFY COLUMN `email` VARCHAR(190) NULL');
});

test('modify_column keeps a nullable column nullable when only the type changes', async () => {
  const { call, seen } = harness((sql) => {
    if (/information_schema\.columns/.test(sql)) {
      return [{ COLUMN_TYPE: 'varchar(190)', IS_NULLABLE: 'YES' }];
    }
    return { affectedRows: 0 };
  });
  const res = await call('modify_column', { table: 'people', column: 'email', type: 'VARCHAR(255)' });
  assert.equal(res.isError, undefined);
  assert.equal(seen.at(-1), 'ALTER TABLE `shop`.`people` MODIFY COLUMN `email` VARCHAR(255) NULL');
});

test('modify_column keeps a NOT NULL column NOT NULL when only the type changes', async () => {
  const { call, seen } = harness((sql) => {
    if (/information_schema\.columns/.test(sql)) {
      return [{ COLUMN_TYPE: 'int', IS_NULLABLE: 'NO' }];
    }
    return { affectedRows: 0 };
  });
  await call('modify_column', { table: 'people', column: 'id', type: 'BIGINT' });
  assert.equal(seen.at(-1), 'ALTER TABLE `shop`.`people` MODIFY COLUMN `id` BIGINT NOT NULL');
});

test('modify_column reports a missing column instead of rewriting it', async () => {
  const { call, seen } = harness(() => []);
  const res = await call('modify_column', { table: 'people', column: 'ghost', type: 'INT' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Column 'ghost' does not exist/);
  assert.equal(seen.length, 1, 'no ALTER should be attempted');
});