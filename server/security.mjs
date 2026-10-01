const IDENTIFIER = /^[A-Za-z0-9_$]+$/;

// Kept deliberately small. Anything not proven read-only falls through to
// ADMIN, because a procedure call or a DO expression can write arbitrarily.
const READ_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH']);

const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'LOAD', 'TRUNCATE', 'LOCK', 'UNLOCK',
  'START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'XA', 'IMPORT',
  'CHANGE', 'CLONE', 'PURGE'
]);

const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME']);

// DML/DDL that can hide behind a leading WITH. MySQL 8.0 accepts
// "WITH cte AS (...) DELETE FROM t", which would otherwise look like a read.
const HIDDEN_BEHIND_CTE = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP',
  'RENAME', 'TRUNCATE', 'LOAD'
]);

const DESTRUCTIVE_KEYWORDS = new Set([
  'DELETE', 'UPDATE', 'DROP', 'TRUNCATE', 'ALTER', 'RENAME', 'OPTIMIZE', 'REPAIR',
  'REPLACE', 'LOAD', 'PURGE', 'IMPORT'
]);

const FILE_CONSTRUCTS = [
  { id: 'into-outfile', pattern: /\bINTO\s+(?:OUT|DUMP)FILE\b/i, reason: 'INTO OUTFILE / INTO DUMPFILE writes a file on the server.' },
  { id: 'load-file', pattern: /\bLOAD_FILE\s*\(/i, reason: 'LOAD_FILE() reads a file from the server filesystem.' }
];

const DOS_CONSTRUCTS = [
  { id: 'sleep', pattern: /\bSLEEP\s*\(/i, reason: 'SLEEP() can hold connections open indefinitely.' },
  { id: 'benchmark', pattern: /\bBENCHMARK\s*\(/i, reason: 'BENCHMARK() can saturate the server.' }
];

export function quoteId(name) {
  if (typeof name !== 'string' || !name || !IDENTIFIER.test(name)) {
    throw new Error(`Invalid MySQL identifier: ${String(name)}`);
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

export function qualifiedTable(database, table) {
  return database ? `${quoteId(database)}.${quoteId(table)}` : quoteId(table);
}

export function assertTableAllowed(settings, table) {
  const allow = settings.mcp?.allowedTables || [];
  if (allow.length > 0 && !allow.includes(table)) {
    throw new Error(`Table '${table}' is not in the table whitelist.`);
  }
}

export function assertMode(settings, required) {
  const current = settings.mcp?.accessMode || 'read';
  const rank = { read: 0, write: 1, admin: 2 };
  if ((rank[current] ?? 0) < (rank[required] ?? 0)) {
    throw new Error(`Operation not allowed in ${current.toUpperCase()} mode. Requires ${required.toUpperCase()}.`);
  }
}

export function normalizeSql(sql) {
  return String(sql || '').trim();
}

function stripQuoted(sql) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of sql) {
    if (escaped) { escaped = false; out += ' '; continue; }
    if (ch === '\\') { escaped = true; out += ' '; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

export function hasMultipleStatements(sql) {
  const clean = stripQuoted(sql)
    .replace(/--.*$/gm, '')
    .replace(/#[^\n]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const pieces = clean.split(';').map(s => s.trim()).filter(Boolean);
  return pieces.length > 1;
}

export function findForbiddenConstructs(sql, { includeDos = true } = {}) {
  const clean = stripQuoted(normalizeSql(sql)).replace(/\/\*[\s\S]*?\*\//g, '');
  const list = includeDos ? [...FILE_CONSTRUCTS, ...DOS_CONSTRUCTS] : FILE_CONSTRUCTS;
  return list.filter(item => item.pattern.test(clean));
}

function classifyKeyword(keyword) {
  if (READ_KEYWORDS.has(keyword)) {
    return { keyword, kind: 'read', requiredMode: 'read', destructive: false, admin: false };
  }
  if (WRITE_KEYWORDS.has(keyword)) {
    return { keyword, kind: 'write', requiredMode: 'write', destructive: DESTRUCTIVE_KEYWORDS.has(keyword), admin: false };
  }
  if (DDL_KEYWORDS.has(keyword)) {
    return { keyword, kind: 'ddl', requiredMode: 'admin', destructive: DESTRUCTIVE_KEYWORDS.has(keyword), admin: true };
  }
  return { keyword, kind: 'admin', requiredMode: 'admin', destructive: DESTRUCTIVE_KEYWORDS.has(keyword), admin: true };
}

/**
 * Collects every statement keyword inside a WITH expression, including the one
 * that finally executes. MySQL 8.0 accepts "WITH cte AS (...) DELETE FROM t" and
 * "WITH cte AS (DELETE FROM t RETURNING *) SELECT * FROM cte", so the leading WITH
 * says nothing about what runs. The most restrictive match wins, which can only
 * ever over-restrict, never under-restrict.
 */
function collectCteKeywords(clean) {
  const found = new Set();
  for (const match of stripQuoted(clean).matchAll(/\b([A-Za-z]+)\b/g)) {
    const word = match[1].toUpperCase();
    if (HIDDEN_BEHIND_CTE.has(word)) found.add(word);
  }
  return found;
}

const MODE_RANK = { read: 0, write: 1, admin: 2 };

export function classifySql(sql) {
  const clean = normalizeSql(sql).replace(/^\(+/, '');
  const leading = (clean.match(/^([A-Za-z]+)/)?.[1] || '').toUpperCase();

  if (leading === 'WITH') {
    let chosen = '';
    let chosenRank = -1;
    for (const word of collectCteKeywords(clean.slice(4))) {
      const rank = MODE_RANK[classifyKeyword(word).requiredMode];
      if (rank > chosenRank) { chosen = word; chosenRank = rank; }
    }
    if (!chosen) return { ...classifyKeyword('SELECT'), leadingKeyword: 'WITH', wrappedInCte: false };
    return { ...classifyKeyword(chosen), leadingKeyword: 'WITH', wrappedInCte: true };
  }

  return classifyKeyword(leading);
}

export function validateFreeSql(settings, sql) {
  const text = normalizeSql(sql);
  if (!text) throw new Error('Empty query.');

  if (settings.mcp?.blockMultipleStatements !== false && hasMultipleStatements(text)) {
    throw new Error('Multiple statements are blocked. Run one SQL statement per request.');
  }

  if (settings.mcp?.blockFileAccess !== false) {
    const files = findForbiddenConstructs(text, { includeDos: false });
    if (files.length) throw new Error(`Blocked construct: ${files.map(f => f.reason).join(' ')}`);
  }

  if (settings.mcp?.allowSlowFunctions !== true) {
    const dos = findForbiddenConstructs(text).filter(c => c.id === 'sleep' || c.id === 'benchmark');
    if (dos.length) throw new Error(`Blocked construct: ${dos.map(f => f.reason).join(' ')}`);
  }

  const info = classifySql(text);
  assertMode(settings, info.requiredMode);

  if ((settings.mcp?.allowedTables || []).length > 0) {
    throw new Error('execute_sql is disabled while a table whitelist is active. Use the structured tools.');
  }

  if (info.requiredMode === 'admin' && settings.mcp?.enableExecuteSql !== true) {
    throw new Error('Administrative SQL is disabled. Enable "execute_sql" in the security settings.');
  }

  return info;
}

const BASE_TYPES = /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL\(\d{1,3},\d{1,3}\)|NUMERIC\(\d{1,3},\d{1,3}\)|FLOAT|DOUBLE|REAL|BIT(?:\(\d{1,2}\))?|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|TIME|YEAR|CHAR\(\d{1,5}\)|VARCHAR\(\d{1,5}\)|BINARY\(\d{1,5}\)|VARBINARY\(\d{1,5}\)|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB)(?:\s+UNSIGNED)?$/;

// The JSON data type arrived in MySQL 5.7.8 and does not exist on older servers.
const MODERN_TYPES = {
  JSON: { requires: 'jsonType', since: 'MySQL 5.7.8', alternative: 'LONGTEXT' }
};

export function validateColumnType(type, capabilities = null) {
  const t = String(type || '').trim().toUpperCase();
  const base = t.replace(/\s+UNSIGNED$/, '');
  const modern = MODERN_TYPES[base];

  if (modern) {
    if (capabilities && !capabilities[modern.requires]) {
      throw new Error(
        `Column type ${base} requires ${modern.since} (server reports ${capabilities.serverVersion}). Use ${modern.alternative} instead.`
      );
    }
    return t;
  }

  if (!BASE_TYPES.test(t)) throw new Error(`Column type not allowed: ${type}`);
  return t;
}

const COMPARISON_OPERATORS = {
  $eq: '=',
  $ne: '!=',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $like: 'LIKE',
  $notLike: 'NOT LIKE'
};

function conditionFor(key, raw) {
  if (raw === null) return { sql: `${quoteId(key)} IS NULL`, values: [] };
  if (raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    return { sql: `${quoteId(key)} IN (${raw.map(() => '?').join(', ')})`, values: [...raw] };
  }

  if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw);
    if (entries.length !== 1) {
      throw new Error(`Filter for '${key}' must use exactly one operator. Allowed: ${[...Object.keys(COMPARISON_OPERATORS), '$in', '$between', '$isNull', '$isNotNull'].join(', ')}, or a plain value.`);
    }
    const [op, value] = entries[0];

    if (op === '$isNull') return value ? { sql: `${quoteId(key)} IS NULL`, values: [] } : { sql: `${quoteId(key)} IS NOT NULL`, values: [] };
    if (op === '$isNotNull') return value ? { sql: `${quoteId(key)} IS NOT NULL`, values: [] } : { sql: `${quoteId(key)} IS NULL`, values: [] };
    if (op === '$in') {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length) return null;
      return { sql: `${quoteId(key)} IN (${list.map(() => '?').join(', ')})`, values: [...list] };
    }
    if (op === '$between') {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error(`Filter $between for '${key}' needs an array of exactly two values.`);
      }
      return { sql: `${quoteId(key)} BETWEEN ? AND ?`, values: [...value] };
    }

    const operator = COMPARISON_OPERATORS[op];
    if (!operator) throw new Error(`Unsupported filter operator '${op}' for '${key}'.`);
    return { sql: `${quoteId(key)} ${operator} ?`, values: [value] };
  }

  return { sql: `${quoteId(key)} = ?`, values: [raw] };
}

/**
 * Parameterized filters. Every value is bound, never interpolated.
 *
 *   { id: 3 }                    -> `id` = ?
 *   { id: [1, 2] }              -> `id` IN (?, ?)
 *   { id: { $gt: 5 } }          -> `id` > ?
 *   { id: { $like: 'a%' } }     -> `id` LIKE ?
 *   { id: { $between: [1, 5] } }-> `id` BETWEEN ? AND ?
 *   { deleted: null }           -> `deleted` IS NULL
 *   { deleted: { $isNotNull: true } } -> `deleted` IS NOT NULL
 */
export function buildWhere(where = {}) {
  const entries = Object.entries(where || {});
  if (!entries.length) return { sql: '', values: [] };

  const chunks = [];
  const values = [];

  for (const [key, raw] of entries) {
    const condition = conditionFor(key, raw);
    if (!condition) continue;
    chunks.push(condition.sql);
    values.push(...condition.values);
  }

  if (!chunks.length) return { sql: '', values: [] };
  return { sql: ` WHERE ${chunks.join(' AND ')}`, values };
}

export const __testing = {
  stripQuoted,
  classifyKeyword,
  collectCteKeywords,
  FILE_CONSTRUCTS,
  DOS_CONSTRUCTS,
  COMPARISON_OPERATORS
};
