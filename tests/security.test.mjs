import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhere, classifySql, findForbiddenConstructs, hasMultipleStatements, quoteId, validateColumnType, validateFreeSql } from '../server/security.mjs';
import { buildCapabilities, indexKeyBudget, parseServerVersion } from '../server/mysqlVersion.mjs';
import { normalizeCollation, normalizeTlsMode, resolveCollation } from '../server/mysqlManager.mjs';
import { ApprovalManager } from '../server/approvalManager.mjs';

const readOnly = { mcp: { accessMode: 'read' } };
const adminMode = { mcp: { accessMode: 'admin', enableExecuteSql: true } };

test('SQL classifier assigns access levels', () => {
  assert.equal(classifySql('SELECT * FROM t').requiredMode, 'read');
  assert.equal(classifySql('UPDATE t SET a=1').requiredMode, 'write');
  assert.equal(classifySql('ALTER TABLE t ADD x INT').requiredMode, 'admin');
});

test('unknown and indirectly writable statements fall back to ADMIN', () => {
  for (const sql of ['CALL do_something()', 'DO 1', 'GRANT ALL ON *.* TO u', 'OPTIMIZE TABLE t', 'KILL 1', 'SET GLOBAL x=1']) {
    assert.equal(classifySql(sql).requiredMode, 'admin', sql);
  }
});

test('a DELETE hidden behind WITH is not treated as a read', () => {
  const info = classifySql('WITH c AS (SELECT 1) DELETE FROM t WHERE id=1');
  assert.equal(info.requiredMode, 'write');
  assert.equal(info.keyword, 'DELETE');
  assert.equal(info.wrappedInCte, true);
  assert.throws(() => validateFreeSql(readOnly, 'WITH c AS (SELECT 1) DELETE FROM t'), /Requires WRITE/);
});

test('the most restrictive keyword inside a WITH wins', () => {
  assert.equal(classifySql('WITH c AS (SELECT 1) SELECT * FROM c').requiredMode, 'read');
  assert.equal(classifySql('WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c').requiredMode, 'write');
  assert.equal(classifySql('WITH a AS (SELECT 1), b AS (SELECT 2) DROP TABLE t').requiredMode, 'admin');
  assert.equal(classifySql('WITH cte AS (DELETE FROM t RETURNING *) SELECT * FROM cte').requiredMode, 'write');
  assert.equal(classifySql('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT * FROM r').requiredMode, 'read');
});

test('backtick quoted identifiers are not mistaken for keywords', () => {
  assert.equal(classifySql('WITH c AS (SELECT id FROM `drop`) SELECT * FROM c').requiredMode, 'read');
});

test('multiple statements detector ignores semicolons inside strings and comments', () => {
  assert.equal(hasMultipleStatements("SELECT ';' AS x"), false);
  assert.equal(hasMultipleStatements('SELECT 1; SELECT 2'), true);
  assert.equal(hasMultipleStatements('SELECT 1 # a; b'), false);
  assert.equal(hasMultipleStatements('SELECT 1 -- a; b'), false);
  assert.equal(hasMultipleStatements('SELECT 1 /* a; b */'), false);
});

test('file access and DoS constructs are blocked', () => {
  assert.deepEqual(findForbiddenConstructs("SELECT * FROM t INTO OUTFILE '/tmp/x'").map(c => c.id), ['into-outfile']);
  assert.deepEqual(findForbiddenConstructs("SELECT LOAD_FILE('/etc/passwd')").map(c => c.id), ['load-file']);
  assert.deepEqual(findForbiddenConstructs('SELECT SLEEP(10)').map(c => c.id), ['sleep']);
  assert.deepEqual(findForbiddenConstructs("SELECT 'INTO OUTFILE' AS x").map(c => c.id), []);
  assert.throws(() => validateFreeSql(readOnly, "SELECT 1 INTO OUTFILE '/tmp/x'"), /Blocked construct/);
  assert.throws(() => validateFreeSql(readOnly, 'SELECT SLEEP(10)'), /Blocked construct/);
  assert.doesNotThrow(() => validateFreeSql(readOnly, 'SELECT 1'));
});

test('execute_sql stays disabled for administrative statements until enabled', () => {
  assert.throws(() => validateFreeSql({ mcp: { accessMode: 'admin' } }, 'ALTER TABLE t ADD x INT'), /Administrative SQL is disabled/);
  assert.doesNotThrow(() => validateFreeSql(adminMode, 'ALTER TABLE t ADD x INT'));
});

test('identifiers and types are constrained', () => {
  assert.equal(quoteId('operatori'), '`operatori`');
  assert.throws(() => quoteId('operatori; DROP TABLE x'));
  assert.equal(validateColumnType('varchar(255)'), 'VARCHAR(255)');
  assert.throws(() => validateColumnType('VARCHAR(10); DROP TABLE x'));
});

test('JSON columns are gated on the detected server version', () => {
  const v56 = buildCapabilities(parseServerVersion('5.6.51'));
  const v57 = buildCapabilities(parseServerVersion('5.7.44'));
  assert.throws(() => validateColumnType('JSON', v56), /requires MySQL 5\.7\.8/);
  assert.equal(validateColumnType('JSON', v57), 'JSON');
});

test('version parsing handles the real shapes servers report', () => {
  assert.equal(parseServerVersion('8.0.36').version, '8.0.36');
  assert.equal(parseServerVersion('5.7.44-log').version, '5.7.44');
  assert.equal(parseServerVersion('9.1.0').version, '9.1.0');

  const maria = parseServerVersion('5.5.5-10.6.18-MariaDB');
  assert.equal(maria.version, '10.6.18');
  assert.equal(maria.isMariaDB, true);

  const aurora = parseServerVersion('8.0.mysql_aurora.3.04.0');
  assert.equal(aurora.version, '8.0.0');
  assert.equal(aurora.isAurora, true);
  assert.equal(aurora.auroraVersion, '3.04.0');

  assert.equal(parseServerVersion('5.7.44-48', 'Percona Server (GPL), Release 44').isPercona, true);
});

test('capability gates follow the documented minimum versions', () => {
  const caps = (raw) => buildCapabilities(parseServerVersion(raw));
  assert.equal(caps('5.6.51').jsonType, false);
  assert.equal(caps('5.7.8').jsonType, true);
  assert.equal(caps('5.7.7').jsonType, false);
  assert.equal(caps('5.6.5').datetimeDefault, true);
  assert.equal(caps('5.6.4').datetimeDefault, false);
  assert.equal(caps('8.0.0').cte, true);
  assert.equal(caps('5.7.44').cte, false);
  assert.equal(caps('8.0.13').defaultExpressions, true);
  assert.equal(caps('8.0.12').defaultExpressions, false);
  assert.equal(caps('8.0.12').instantAddColumn, true);
  assert.equal(caps('5.6.51').maxIndexKeyBytes, 767);
  assert.equal(caps('5.7.44').maxIndexKeyBytes, 3072);
  assert.equal(caps('8.4.0').maxIndexKeyBytes, 3072);
});

test('MariaDB is recognised as MySQL compatible and keeps its own version', () => {
  const caps = buildCapabilities(parseServerVersion('10.11.6-MariaDB'));
  assert.equal(caps.vendor, 'mariadb');
  // MariaDB 10.2+ implements the JSON alias and CTEs.
  assert.equal(caps.jsonType, true);
  assert.equal(caps.cte, true);
});

test('index key budget follows the row format, not just the version', () => {
  const v56 = buildCapabilities(parseServerVersion('5.6.51'));
  const v84 = buildCapabilities(parseServerVersion('8.4.0'));
  assert.equal(indexKeyBudget(v56, { engine: 'InnoDB', rowFormat: 'Compact' }).perColumn, 767);
  assert.equal(indexKeyBudget(v84, { engine: 'InnoDB', rowFormat: 'Dynamic' }).perColumn, 3072);
  assert.equal(indexKeyBudget(v84, { engine: 'InnoDB', rowFormat: 'Redundant' }).perColumn, 767);
  assert.equal(indexKeyBudget(v84, { engine: 'MyISAM' }).perColumn, 1000);
});

test('the MySQL 8 only collation is downgraded for older servers', () => {
  assert.equal(resolveCollation('utf8mb4-unicode', { major: 8 }).name, 'UTF8MB4_UNICODE_CI');
  assert.equal(resolveCollation('utf8mb4-unicode', { major: 5 }).name, 'UTF8MB4_GENERAL_CI');
  assert.equal(resolveCollation('utf8mb4-unicode', { major: 5 }).downgraded, true);
  // The default must be a collation that exists on every supported server.
  assert.equal(resolveCollation('utf8mb4', { major: 5 }).name, 'UTF8MB4_GENERAL_CI');
  assert.equal(normalizeCollation(undefined), 'utf8mb4');
  assert.equal(normalizeCollation('nonsense'), 'utf8mb4');
});

test('TLS mode normalisation accepts legacy boolean values', () => {
  assert.equal(normalizeTlsMode(true), 'required');
  assert.equal(normalizeTlsMode('true'), 'required');
  assert.equal(normalizeTlsMode(false), 'off');
  assert.equal(normalizeTlsMode('verify-full'), 'verify-full');
  assert.equal(normalizeTlsMode('nonsense'), 'off');
});

test('WHERE builder parameterizes values', () => {
  assert.deepEqual(buildWhere({ id: 3, deleted: null }), {
    sql: ' WHERE `id` = ? AND `deleted` IS NULL',
    values: [3]
  });
});

test('WHERE builder supports the operator forms without interpolating values', () => {
  assert.deepEqual(buildWhere({ tags: ['a', 'b'] }), {
    sql: ' WHERE `tags` IN (?, ?)',
    values: ['a', 'b']
  });
  assert.deepEqual(buildWhere({ age: { $gte: 18 }, name: { $like: 'a%' } }), {
    sql: ' WHERE `age` >= ? AND `name` LIKE ?',
    values: [18, 'a%']
  });
  assert.deepEqual(buildWhere({ r: { $between: [1, 5] }, x: { $isNotNull: true } }), {
    sql: ' WHERE `r` BETWEEN ? AND ? AND `x` IS NOT NULL',
    values: [1, 5]
  });
  assert.deepEqual(buildWhere({}), { sql: '', values: [] });
  assert.throws(() => buildWhere({ id: { $nope: 1 } }), /Unsupported filter operator/);
});

test('approvals are one-shot', () => {
  const mgr = new ApprovalManager();
  const id = mgr.request({ action: 'delete:test', summary: 'delete', sql: 'DELETE FROM t WHERE id=1' });
  assert.equal(mgr.consume(id, 'delete:test'), false);
  assert.equal(mgr.decide(id, true), true);
  assert.equal(mgr.consume(id, 'delete:test'), true);
  assert.equal(mgr.consume(id, 'delete:test'), false);
});
