import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.md', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.yaml', '.yml', '.ini', '.cfg',
  '.conf', '.sql', '.ps1', '.bat', '.cmd', '.py', '.java', '.c', '.cpp', '.h', '.cs'
]);
export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 100000;
const MAX_ENTRIES = 250;
const MAX_WALK_ENTRIES = 1500;
const MAX_DEPTH = 5;
const BLOCKED = new Set([
  '.git', '.ssh', '.aws', '.azure', '.npmrc', '.netrc', '.env',
  'node_modules', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json'
]);

function permittedName(name) {
  const n = String(name || '').toLowerCase();
  return !!n && !BLOCKED.has(n) && !n.startsWith('.env.') &&
    !/(\.pem|\.key|\.p12|\.pfx|\.kdbx)$/i.test(n);
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function relativeParts(relative = '.') {
  const value = String(relative || '.');
  if (value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value) ||
      path.posix.isAbsolute(value)) throw new Error('Only relative paths inside the authorized root are allowed.');
  const parts = value.split(/[/\\]+/).filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || !permittedName(p) || p.includes(':'))) {
    throw new Error('The requested path is not authorized.');
  }
  return parts;
}

async function resolveAuthorized(rootPath, requested = '.') {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw new Error('Filesystem source root must be an absolute path.');
  }
  const root = await fs.realpath(rootPath);
  const parts = relativeParts(requested);
  const lexical = path.resolve(root, ...parts);
  if (!inside(root, lexical)) throw new Error('Path escapes the authorized root.');
  const target = await fs.realpath(lexical);
  if (!inside(root, target)) throw new Error('Path escapes the authorized root through a link.');
  return { root, target, relative: path.relative(root, target).split(path.sep).join('/') || '.' };
}

async function checkFile(rootPath, requested) {
  const location = await resolveAuthorized(rootPath, requested);
  const stats = await fs.stat(location.target);
  if (!stats.isFile()) throw new Error('The requested path is not a regular file.');
  if (stats.size > MAX_FILE_BYTES) throw new Error('File is too large for safe MCP reading (12 MB max).');
  return { ...location, stats };
}

async function safeBuffer(target) {
  const handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('File is not safely readable (max 12 MB).');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function truncate(text, count = MAX_TEXT_CHARS) {
  const value = String(text ?? '');
  const cap = Math.min(MAX_TEXT_CHARS, Math.max(1, Number(count) || MAX_TEXT_CHARS));
  return { text: value.slice(0, cap), truncated: value.length > cap };
}

async function extractDocument(filename, ext) {
  const data = await safeBuffer(filename);
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const output = await mammoth.extractRawText({ buffer: data });
    return { format: 'docx', text: output.value };
  }
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      // Reading extracted text does not execute JavaScript/actions embedded in PDFs.
      const output = await parser.getText({ first: 1, last: 40 });
      return { format: 'pdf', text: output.text || '' };
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data);
    const lines = [];
    for (const sheet of workbook.worksheets.slice(0, 6)) {
      lines.push('# Sheet: ' + sheet.name);
      const rows = Math.min(sheet.rowCount, 300);
      for (let number = 1; number <= rows; number++) {
        const row = sheet.getRow(number);
        const cells = [];
        for (let column = 1; column <= Math.min(row.cellCount, 35); column++) {
          const cell = row.getCell(column);
          const value = cell.value;
          if (value && typeof value === 'object') {
            cells.push(String(value.result ?? value.text ?? (value.richText
              ? value.richText.map(t => t.text).join('') : '')));
          } else {
            cells.push(value == null ? '' : String(value));
          }
        }
        lines.push(cells.join('\t'));
      }
    }
    return { format: 'xlsx', text: lines.join('\n') };
  }
  throw new Error('Unsupported document format; use PDF, Word .docx or Excel .xlsx.');
}

async function readText(rootPath, requested, maxChars) {
  const file = await checkFile(rootPath, requested);
  const ext = path.extname(file.target).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) throw new Error('This extension is not a supported plain-text file.');
  const data = await safeBuffer(file.target);
  if (data.includes(0)) throw new Error('Binary data cannot be read using read_text_file.');
  return { path: file.relative, format: 'text', ...truncate(data.toString('utf8'), maxChars) };
}

async function readDocument(rootPath, requested, maxChars) {
  const file = await checkFile(rootPath, requested);
  const ext = path.extname(file.target).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) throw new Error('Supported documents: .pdf, .docx, .xlsx (not .doc or .xls).');
  const output = await extractDocument(file.target, ext);
  return { path: file.relative, ...truncate(output.text, maxChars), format: output.format };
}

async function directory(rootPath, requested, limit = 100) {
  const location = await resolveAuthorized(rootPath, requested);
  const info = await fs.stat(location.target);
  if (!info.isDirectory()) throw new Error('Path is not a directory.');
  const names = await fs.readdir(location.target, { withFileTypes: true });
  const cap = Math.min(MAX_ENTRIES, Math.max(1, Number(limit) || 100));
  const items = [];
  for (const entry of names) {
    if (items.length >= cap) break;
    if (!permittedName(entry.name) || entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (entry.isFile() && !TEXT_EXTENSIONS.has(ext) && !DOCUMENT_EXTENSIONS.has(ext)) continue;
    // Windows reparse points may be exposed as directory entries. Real-path check below
    // ensures these entries cannot point outside an authorized root.
    try {
      const resolved = await fs.realpath(path.join(location.target, entry.name));
      if (!inside(location.root, resolved)) continue;
      items.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file',
        path: location.relative === '.' ? entry.name : location.relative + '/' + entry.name });
    } catch { /* Ignore inaccessible or disappearing entries. */ }
  }
  return { path: location.relative, entries: items, limit: cap, truncated: names.length > items.length };
}

async function info(rootPath, requested) {
  const file = await resolveAuthorized(rootPath, requested);
  const stats = await fs.stat(file.target);
  return {
    path: file.relative, type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
    size: stats.size, modified: stats.mtime.toISOString(),
    extension: path.extname(file.target).toLowerCase()
  };
}

async function scan(rootPath, requested, options) {
  const location = await resolveAuthorized(rootPath, requested);
  const st = await fs.stat(location.target);
  if (!st.isDirectory()) throw new Error('Search path is not a directory.');
  const maxDepth = Math.min(MAX_DEPTH, Math.max(0, Number(options.max_depth) || 3));
  const found = [];
  let visited = 0;
  const q = [{ absolute: location.target, relative: location.relative, depth: 0 }];
  while (q.length && visited < MAX_WALK_ENTRIES && found.length < 100) {
    const next = q.shift();
    const entries = await fs.readdir(next.absolute, { withFileTypes: true }).catch(() => []);
    for (const item of entries) {
      if (++visited > MAX_WALK_ENTRIES || found.length >= 100) break;
      if (!permittedName(item.name) || item.isSymbolicLink()) continue;
      const absolute = path.join(next.absolute, item.name);
      const relative = next.relative === '.' ? item.name : next.relative + '/' + item.name;
      let real;
      try { real = await fs.realpath(absolute); } catch { continue; }
      if (!inside(location.root, real)) continue;
      if (item.isDirectory() && next.depth < maxDepth) {
        q.push({ absolute: real, relative, depth: next.depth + 1 });
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if ((TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext)) &&
            (!options.name || item.name.toLowerCase().includes(String(options.name).toLowerCase()))) {
          found.push(relative);
        }
      }
    }
  }
  return { paths: found, scanned: visited, truncated: visited >= MAX_WALK_ENTRIES || found.length >= 100 };
}

export async function executeFileSource(source, operation, args = {}) {
  if (source.type !== 'filesystem') throw new Error('This tool only works with filesystem sources.');
  const root = source.rootPath;
  const relative = args.path || '.';
  if (operation === 'list_directory') return directory(root, relative, args.limit);
  if (operation === 'get_file_info') return info(root, relative);
  if (operation === 'read_text_file') return readText(root, args.path, args.max_chars);
  if (operation === 'read_document') return readDocument(root, args.path, args.max_chars);
  if (operation === 'search_files') return scan(root, relative, args);
  if (operation === 'search_text') {
    if (!args.query || typeof args.query !== 'string' || args.query.length > 200) {
      throw new Error('Specify a search string of 1-200 characters.');
    }
    const scanned = await scan(root, relative, { ...args, name: args.name });
    const matches = [];
    for (const candidate of scanned.paths.slice(0, 30)) {
      try {
        const ext = path.extname(candidate).toLowerCase();
        const result = TEXT_EXTENSIONS.has(ext)
          ? await readText(root, candidate, MAX_TEXT_CHARS)
          : await readDocument(root, candidate, MAX_TEXT_CHARS);
        const position = result.text.toLowerCase().indexOf(args.query.toLowerCase());
        if (position >= 0) matches.push({
          path: candidate, excerpt: result.text.slice(Math.max(0, position - 90), position + args.query.length + 130)
        });
      } catch { /* skip unreadable, unsupported or oversized file */ }
      if (matches.length >= 30) break;
    }
    return { matches, scannedFiles: Math.min(scanned.paths.length, 30),
      truncated: scanned.truncated || scanned.paths.length > 30 };
  }
  throw new Error('Unsupported filesystem read operation.');
}
