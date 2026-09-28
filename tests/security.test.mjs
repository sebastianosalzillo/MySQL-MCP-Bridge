import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhere, classifySql, hasMultipleStatements, quoteId, validateColumnType } from '../server/security.mjs';
import { ApprovalManager } from '../server/approvalManager.mjs';

test('SQL classifier assigns access levels', () => {
  assert.equal(classifySql('SELECT * FROM t').requiredMode, 'read');
  assert.equal(classifySql('UPDATE t SET a=1').requiredMode, 'write');
  assert.equal(classifySql('ALTER TABLE t ADD x INT').requiredMode, 'admin');
});

test('multiple statements detector ignores semicolons inside strings', () => {
  assert.equal(hasMultipleStatements("SELECT ';' AS x"), false);
  assert.equal(hasMultipleStatements('SELECT 1; SELECT 2'), true);
});

test('identifiers and types are constrained', () => {
  assert.equal(quoteId('operatori'), '`operatori`');
  assert.throws(() => quoteId('operatori; DROP TABLE x'));
  assert.equal(validateColumnType('varchar(255)'), 'VARCHAR(255)');
  assert.throws(() => validateColumnType('VARCHAR(10); DROP TABLE x'));
});

test('WHERE builder parameterizes values', () => {
  assert.deepEqual(buildWhere({ id: 3, deleted: null }), {
    sql: ' WHERE `id` = ? AND `deleted` IS NULL',
    values: [3]
  });
});

test('approvals are one-shot', () => {
  const mgr = new ApprovalManager();
  const id = mgr.request({ action: 'delete:test', summary: 'delete', sql: 'DELETE FROM t WHERE id=1' });
  assert.equal(mgr.consume(id, 'delete:test'), false);
  assert.equal(mgr.decide(id, true), true);
  assert.equal(mgr.consume(id, 'delete:test'), true);
  assert.equal(mgr.consume(id, 'delete:test'), false);
});
