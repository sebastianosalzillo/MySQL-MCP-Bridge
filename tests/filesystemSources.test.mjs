import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { executeFileSource } from '../server/fileSources.mjs';
import { validateStandaloneSettings } from '../server/standaloneConfig.mjs';

const operation = (rootPath, action, args) => executeFileSource({
  id: 'share', type: 'filesystem', rootPath
}, action, args);

function makePdf(message) {
  const stream = 'BT /F1 16 Tf 72 720 Td (' + message + ') Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const positions = [0];
  for (let i = 0; i < objects.length; i++) {
    positions.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const pos of positions.slice(1)) pdf += String(pos).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(pdf);
}

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word document sample</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('filesystem source must use an explicit absolute root', () => {
  const config = { mcp: { accessMode: 'read' }, ngrok: { enabled: false } };
  assert.throws(() => validateStandaloneSettings({
    ...config, sources: [{ id: 'docs', type: 'filesystem', rootPath: 'relative/folder' }]
  }), /absolute rootPath/);
  assert.equal(validateStandaloneSettings({
    ...config, sources: [{ id: 'docs', type: 'filesystem', rootPath: path.resolve(os.tmpdir()) }]
  }).sources[0].type, 'filesystem');
});

test('read-only filesystem tools honor root boundaries, secret filters, and text search', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'public'));
  await fs.writeFile(path.join(root, 'public', 'notes.txt'), 'Invoice 2026 is ready for review');
  await fs.writeFile(path.join(root, '.env'), 'PROTECTED_TOKEN=private');
  await fs.writeFile(path.join(root, 'secret.pem'), 'PRIVATE KEY');
  await fs.writeFile(path.join(root, 'public', 'binary.txt'), Buffer.from([0, 1, 2]));
  const listing = await operation(root, 'list_directory', { path: '.' });
  assert.deepEqual(listing.entries.map(e => e.name), ['public']);
  const nested = await operation(root, 'list_directory', { path: 'public' });
  assert.ok(nested.entries.some(e => e.name === 'notes.txt'));
  const textResult = await operation(root, 'read_text_file', { path: 'public/notes.txt' });
  assert.match(textResult.text, /Invoice 2026/);
  assert.equal(textResult.truncated, false);
  const info = await operation(root, 'get_file_info', { path: 'public/notes.txt' });
  assert.equal(info.type, 'file');
  assert.ok(info.size > 0);
  const search = await operation(root, 'search_files', { name: 'notes' });
  assert.deepEqual(search.paths, ['public/notes.txt']);
  const hits = await operation(root, 'search_text', { query: 'Invoice' });
  assert.equal(hits.matches[0].path, 'public/notes.txt');
  await assert.rejects(() => operation(root, 'read_text_file', { path: '../outside.txt' }), /not authorized/);
  await assert.rejects(() => operation(root, 'read_text_file', { path: path.join(root, 'public/notes.txt') }), /relative paths/);
  await assert.rejects(() => operation(root, 'read_text_file', { path: '.env' }), /not authorized/);
  await assert.rejects(() => operation(root, 'read_text_file', { path: 'secret.pem' }), /not authorized/);
  await assert.rejects(() => operation(root, 'read_text_file', { path: 'public/binary.txt' }), /Binary data/);
  await assert.rejects(() => operation(root, 'read_text_file', { path: 'public/not-found.txt' }), /ENOENT/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside confidential text');
  try {
    await fs.symlink(outside, path.join(root, 'public', 'linked'), 'junction');
    await assert.rejects(() => operation(root, 'read_text_file', {
      path: 'public/linked/outside.txt'
    }), /escapes the authorized root/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error.code)) throw error;
  }
});

test('read_document extracts text from genuine DOCX, XLSX and PDF files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-doc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'contract.docx'), await makeDocx());
  const docx = await operation(root, 'read_document', { path: 'contract.docx' });
  assert.match(docx.text, /Word document sample/);
  assert.equal(docx.format, 'docx');
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Invoices').addRow(['Item', 'Quantity']);
  book.worksheets[0].addRow(['Pens', 17]);
  await fs.writeFile(path.join(root, 'table.xlsx'), await book.xlsx.writeBuffer());
  const xlsx = await operation(root, 'read_document', { path: 'table.xlsx' });
  assert.match(xlsx.text, /# Sheet: Invoices/);
  assert.match(xlsx.text, /Pens\t17/);
  await fs.writeFile(path.join(root, 'text.pdf'), makePdf('Sample PDF text'));
  const pdf = await operation(root, 'read_document', { path: 'text.pdf' });
  assert.match(pdf.text, /Sample PDF text/);
  const find = await operation(root, 'search_text', { query: 'Pens' });
  assert.equal(find.matches[0].path, 'table.xlsx');
});
