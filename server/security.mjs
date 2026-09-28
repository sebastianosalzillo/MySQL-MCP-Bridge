const IDENTIFIER = /^[A-Za-z0-9_$]+$/;

export function quoteId(name) {
  if (typeof name !== 'string' || !name || !IDENTIFIER.test(name)) {
    throw new Error(`Identificatore MySQL non valido: ${String(name)}`);
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

export function qualifiedTable(database, table) {
  return database ? `${quoteId(database)}.${quoteId(table)}` : quoteId(table);
}

export function assertTableAllowed(settings, table) {
  const allow = settings.mcp?.allowedTables || [];
  if (allow.length > 0 && !allow.includes(table)) {
    throw new Error(`Tabella '${table}' non autorizzata dalla whitelist.`);
  }
}

export function assertMode(settings, required) {
  const current = settings.mcp?.accessMode || 'read';
  const rank = { read: 0, write: 1, admin: 2 };
  if ((rank[current] ?? 0) < (rank[required] ?? 0)) {
    throw new Error(`Operazione non consentita in modalità ${current.toUpperCase()}. Richiede ${required.toUpperCase()}.`);
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
  const clean = stripQuoted(sql).replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const pieces = clean.split(';').map(s => s.trim()).filter(Boolean);
  return pieces.length > 1;
}

export function classifySql(sql) {
  const clean = normalizeSql(sql).replace(/^\(+/, '');
  const keyword = (clean.match(/^([A-Za-z]+)/)?.[1] || '').toUpperCase();
  const read = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH']);
  const write = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
  const ddl = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
  const admin = new Set(['GRANT', 'REVOKE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'SET', 'FLUSH', 'KILL']);
  return {
    keyword,
    kind: read.has(keyword) ? 'read' : write.has(keyword) ? 'write' : ddl.has(keyword) ? 'ddl' : 'other',
    requiredMode: read.has(keyword) ? 'read' : write.has(keyword) ? 'write' : 'admin',
    destructive: ['DELETE', 'UPDATE', 'DROP', 'TRUNCATE', 'ALTER', 'RENAME'].includes(keyword),
    admin: admin.has(keyword)
  };
}

export function validateFreeSql(settings, sql) {
  const text = normalizeSql(sql);
  if (!text) throw new Error('Query vuota.');
  if (settings.mcp?.blockMultipleStatements !== false && hasMultipleStatements(text)) {
    throw new Error('Query multiple bloccate. Esegui una singola istruzione SQL per richiesta.');
  }
  const info = classifySql(text);
  assertMode(settings, info.requiredMode);
  if ((settings.mcp?.allowedTables || []).length > 0) {
    throw new Error('execute_sql è disabilitato quando è attiva una whitelist tabelle. Usa i tool strutturati.');
  }
  if (info.requiredMode === 'admin' && settings.mcp?.enableExecuteSql !== true) {
    throw new Error('SQL amministrativo disabilitato. Abilita "execute_sql" nelle impostazioni di sicurezza.');
  }
  return info;
}

export function validateColumnType(type) {
  const t = String(type || '').trim().toUpperCase();
  const safe = /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL\(\d{1,3},\d{1,3}\)|NUMERIC\(\d{1,3},\d{1,3}\)|FLOAT|DOUBLE|REAL|BIT(?:\(\d{1,2}\))?|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|TIME|YEAR|CHAR\(\d{1,5}\)|VARCHAR\(\d{1,5}\)|BINARY\(\d{1,5}\)|VARBINARY\(\d{1,5}\)|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|JSON)(?:\s+UNSIGNED)?$/;
  if (!safe.test(t)) throw new Error(`Tipo colonna non consentito: ${type}`);
  return t;
}

export function buildWhere(where = {}) {
  const entries = Object.entries(where || {});
  if (entries.length === 0) return { sql: '', values: [] };
  const chunks = [];
  const values = [];
  for (const [key, value] of entries) {
    if (value === null) chunks.push(`${quoteId(key)} IS NULL`);
    else { chunks.push(`${quoteId(key)} = ?`); values.push(value); }
  }
  return { sql: ` WHERE ${chunks.join(' AND ')}`, values };
}
