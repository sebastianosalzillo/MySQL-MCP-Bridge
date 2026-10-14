import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeFileSource } from '../server/fileSources.mjs';

const samples = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const perform = (rootPath, operation, args) =>
  executeFileSource({ id: 'docs', type: 'filesystem', rootPath }, operation, args);

test('legacy DOC and XLS files appear in authorized source search/list', async () => {
  const listed = await perform(samples, 'list_directory', { path: '.' });
  assert.ok(listed.entries.some(item => item.name === 'legacy-sample.doc'));
  assert.ok(listed.entries.some(item => item.name === 'legacy-numbers.xls'));
  const found = await perform(samples, 'search_files', { name: 'legacy-' });
  assert.ok(found.paths.includes('legacy-sample.doc'));
  assert.ok(found.paths.includes('legacy-numbers.xls'));
});

test('read_document reads authentic legacy Microsoft Word .doc (OLE2)', async () => {
  const doc = await perform(samples, 'read_document', { path: 'legacy-sample.doc' });
  assert.equal(doc.format, 'doc');
  assert.match(doc.text, /A second test of reviewing/);
  assert.ok(doc.text.length > 30);
});

test('read_document reads authentic Excel .xls BIFF8 numbers without Office', async () => {
  const xls = await perform(samples, 'read_document', { path: 'legacy-numbers.xls' });
  assert.equal(xls.format, 'xls');
  assert.match(xls.text, /# Sheet:/);
  assert.match(xls.text, /3\.14159/);
  assert.match(xls.text, /2500000000/);
  const hits = await perform(samples, 'search_text', { query: '3.14159', name: 'legacy-numbers.xls' });
  assert.equal(hits.matches.length, 1);
  assert.equal(hits.matches[0].path, 'legacy-numbers.xls');
});

test('legacy readers reject fake OLE containers and remain read-only', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-legacy-bad-'));
  t.after(async () => fs.rm(folder, { recursive: true, force: true }));
  await fs.writeFile(path.join(folder, 'renamed.doc'), 'fake binary Word document');
  await fs.writeFile(path.join(folder, 'renamed.xls'), 'fake Excel document');
  await assert.rejects(() => perform(folder, 'read_document', { path: 'renamed.doc' }), /expected an OLE2/);
  await assert.rejects(() => perform(folder, 'read_document', { path: 'renamed.xls' }), /expected an OLE2/);
  await assert.rejects(() => perform(samples, 'read_document', { path: '../package.json' }), /not authorized/);
  await assert.rejects(() => perform(samples, 'read_text_file', { path: 'legacy-sample.doc' }), /plain-text/);
  await assert.rejects(() => perform(samples, 'write_file', {
    path: 'legacy-sample.doc', text: 'malicious modification'
  }), /Unsupported filesystem read operation/);
});
