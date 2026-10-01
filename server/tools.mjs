import { z } from 'zod';
import { assertMode, assertTableAllowed, buildWhere, classifySql, hasMultipleStatements, qualifiedTable, quoteId, validateColumnType, validateFreeSql } from './security.mjs';
import { queryWithTimeout } from './mysqlManager.mjs';
import { compatibilityWarnings, describeVersion, indexKeyBudget } from './mysqlVersion.mjs';

const json = (value) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const result = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }] });
const failure = (err) => ({ content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }], isError: true });

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric default value.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('default_value must be a string, number, boolean or null.');
}

// Engine, charset, collation and row format names are emitted unquoted because
// that is the syntax MySQL expects, so they are allowlisted instead.
const OPTION_TOKEN = /^[A-Za-z0-9_]+$/;

function optionToken(value, label) {
  const token = String(value || '').trim();
  if (!OPTION_TOKEN.test(token)) throw new Error(`Invalid ${label}: ${value}`);
  return token;
}

function effectiveDb(settings, database) {
  return database || settings.mysql?.database || '';
}

function requireCapability(ctx, flag, message) {
  if (!ctx.capabilities?.[flag]) {
    throw new Error(`${message} (server reports ${ctx.capabilities?.serverVersion || 'unknown'})`);
  }
}

function approvalResponse(approvals, { action, summary, sql, approvalId, required }) {
  if (!required) return null;
  if (approvalId && approvals.consume(approvalId, action)) return null;
  if (approvalId) {
    const existing = approvals.get(approvalId);
    if (existing) {
      return {
        content: [{ type: 'text', text: json({
          approval_required: true,
          approval_id: approvalId,
          status: existing.status,
          message: existing.status === 'denied'
            ? 'The operation was denied by the user in the desktop app.'
            : 'Open MySQL MCP Bridge, approve the request, then repeat the call with the same approval_id.'
        }) }],
        isError: true
      };
    }
  }
  const id = approvals.request({ action, summary, sql });
  return {
    content: [{ type: 'text', text: json({
      approval_required: true,
      approval_id: id,
      status: 'pending',
      message: 'Approval required in the desktop app. Once approved, repeat the same call passing approval_id.'
    }) }],
    isError: true
  };
}

async function query(ctx, sql, values = []) {
  ctx.log('query', { sql, valuesCount: values.length });
  const [rows, fields] = await queryWithTimeout(ctx.pool, sql, values, ctx.settings.mcp?.queryTimeoutMs);
  return { rows, fields: fields?.map?.(f => ({ name: f.name, table: f.table, type: f.columnType })) || undefined };
}

/**
 * information_schema hands back its columns in upper case, so the key on a row
 * depends on which statement produced it. Reading through this keeps the
 * callers on the lower case names they were written with.
 */
function field(row, name) {
  if (!row) return undefined;
  return row[name] ?? row[name.toUpperCase()];
}

async function tableInfo(ctx, database, table) {
  const { rows } = await query(
    ctx,
    'SELECT engine, row_format, table_collation, create_options FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [database, table]
  );
  const info = rows[0] || {};
  return {
    engine: field(info, 'engine') || '',
    rowFormat: field(info, 'row_format') || '',
    collation: field(info, 'table_collation') || '',
    createOptions: field(info, 'create_options') || ''
  };
}

/** Bytes one character of a character set occupies, used to size index prefixes. */
const MAX_BYTES_PER_CHAR = {
  utf8mb4: 4,
  utf8: 3,
  utf8mb3: 3,
  latin1: 1,
  ascii: 1,
  binary: 1,
  ucs2: 2,
  utf16: 4,
  utf32: 4
};

function bytesPerChar(collationName) {
  const key = String(collationName || '').toLowerCase();
  for (const [name, size] of Object.entries(MAX_BYTES_PER_CHAR)) {
    if (key.startsWith(name)) return size;
  }
  return 4;
}

/**
 * INPLACE and COPY exist from MySQL 5.6, but ALGORITHM=INSTANT for adding a column
 * only arrived in 8.0.12.
 */
function assertDdlAlgorithmSupported(ctx, algorithm) {
  if (!algorithm || algorithm === 'DEFAULT') return;
  if (algorithm === 'INSTANT') requireCapability(ctx, 'instantAddColumn', 'ALGORITHM=INSTANT is not supported on this server');
  else requireCapability(ctx, 'onlineDdl', `ALGORITHM=${algorithm} is not supported on this server`);
}

export function registerTools(server, ctx) {
  const tool = (name, spec, handler) => server.registerTool(name, spec, async (args) => {
    try {
      ctx.log('tool', { name, args: redact(args) });
      return await handler(args || {});
    } catch (err) {
      ctx.log('error', { tool: name, message: err?.message || String(err) });
      return failure(err);
    }
  });

  tool('mysql_server_info', {
    description: 'Reports the connected server version, SQL mode, capabilities and any compatibility limitations. Call this first when you need to know which SQL features are available.',
    inputSchema: {}
  }, async () => {
    assertMode(ctx.settings, 'read');
    // CURRENT_USER is a reserved word from MySQL 8.3 on, so the alias is quoted.
    const { rows } = await query(ctx, 'SELECT DATABASE() AS database_name, CURRENT_USER() AS `current_user`, CONNECTION_ID() AS connection_id');
    const version = ctx.serverVersion;
    return result({
      server: version ? describeVersion(version) : 'unknown',
      raw_version: version?.raw,
      vendor: version?.vendorLabel,
      sql_mode: ctx.capabilities?.sqlMode,
      character_set_server: ctx.capabilities?.characterSetServer,
      max_allowed_packet: ctx.capabilities?.maxAllowedPacket,
      tls: ctx.tlsMode,
      session: rows[0],
      capabilities: ctx.capabilities,
      compatibility_warnings: version ? compatibilityWarnings(version, ctx.capabilities || {}) : []
    });
  });

  tool('list_databases', {
    description: 'Lists the databases visible to the configured MySQL user. System schemas are excluded unless explicitly requested.',
    inputSchema: { include_system_schemas: z.boolean().optional() }
  }, async ({ include_system_schemas }) => {
    assertMode(ctx.settings, 'read');
    const { rows } = await query(ctx, 'SHOW DATABASES');
    const names = rows.map(r => r.Database || r.database);
    const visible = include_system_schemas ? names : names.filter(n => !SYSTEM_SCHEMAS.has(String(n).toLowerCase()));
    return result(visible.map(name => ({ database: name })));
  });

  tool('list_tables', {
    description: 'Lists tables in a database, defaulting to the configured one. Row counts are omitted unless explicitly requested because they force the server to open every table.',
    inputSchema: {
      database: z.string().optional(),
      include_row_counts: z.boolean().optional()
    }
  }, async ({ database, include_row_counts }) => {
    assertMode(ctx.settings, 'read');
    const db = effectiveDb(ctx.settings, database);
    if (!db) throw new Error('A database must be specified.');
    const columns = include_row_counts
      ? 'table_name, table_type, engine, row_format, table_collation, table_rows, table_comment'
      : 'table_name, table_type, engine, row_format, table_collation, table_comment';
    const { rows } = await query(ctx,
      `SELECT ${columns} FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [db]
    );
    const allow = ctx.settings.mcp?.allowedTables || [];
    const visible = allow.length ? rows.filter(r => allow.includes(r.table_name || r.TABLE_NAME)) : rows;
    return result(visible);
  });

  tool('describe_table', {
    description: 'Describes the columns, types, nullability, keys, defaults and extras of a table.',
    inputSchema: { table: z.string(), database: z.string().optional() }
  }, async ({ table, database }) => {
    assertMode(ctx.settings, 'read');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    if (!db) throw new Error('A database must be specified.');
    const { rows } = await query(ctx,
      `SELECT column_name, column_type, data_type, is_nullable, column_key, column_default, extra, column_comment, ordinal_position
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [db, table]
    );
    const info = await tableInfo(ctx, db, table);
    return result({ table, engine: info.engine, row_format: info.rowFormat, collation: info.collation, columns: rows });
  });

  tool('show_create_table', {
    description: 'Returns the exact DDL the server reports for a table. Works on every supported MySQL version and is the most reliable way to see indexes, engine and charset.',
    inputSchema: { table: z.string(), database: z.string().optional() }
  }, async ({ table, database }) => {
    assertMode(ctx.settings, 'read');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    if (!db) throw new Error('A database must be specified.');
    const target = qualifiedTable(db, table);
    const { rows } = await query(ctx, `SHOW CREATE TABLE ${target}`);
    const row = rows[0] || {};
    return result({
      table,
      ddl: row['Create Table'] || row['Create View'] || null
    });
  });

  tool('get_foreign_keys', {
    description: 'Shows the foreign keys of a table.',
    inputSchema: { table: z.string(), database: z.string().optional() }
  }, async ({ table, database }) => {
    assertMode(ctx.settings, 'read');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const { rows } = await query(ctx,
      `SELECT constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
       ORDER BY constraint_name, ordinal_position`,
      [db, table]
    );
    return result(rows);
  });

  tool('select_rows', {
    description: 'Runs a parameterized SELECT with a controlled limit. Filters accept plain values, arrays (IN) or operators such as $gt, $lt, $gte, $lte, $ne, $like, $between, $in, $isNull and $isNotNull.',
    inputSchema: {
      table: z.string(),
      database: z.string().optional(),
      columns: z.array(z.string()).optional(),
      where: z.record(z.any()).optional(),
      order_by: z.string().optional(),
      order_direction: z.enum(['ASC', 'DESC']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional()
    }
  }, async ({ table, database, columns, where, order_by, order_direction, limit, offset }) => {
    assertMode(ctx.settings, 'read');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const cols = !columns?.length || columns.includes('*') ? '*' : columns.map(quoteId).join(', ');
    const w = buildWhere(where);
    const max = Math.max(1, Number(ctx.settings.mcp?.selectLimit || 1000));
    const actualLimit = Math.min(Math.max(1, Number(limit || max)), max);
    let sql = `SELECT ${cols} FROM ${qualifiedTable(db, table)}${w.sql}`;
    if (order_by) sql += ` ORDER BY ${quoteId(order_by)} ${order_direction || 'ASC'}`;
    sql += ` LIMIT ${actualLimit}`;
    if (Number(offset) > 0) sql += ` OFFSET ${Number(offset)}`;
    const { rows } = await query(ctx, sql, w.values);
    return result({ count: rows.length, limit: actualLimit, rows });
  });

  tool('insert_rows', {
    description: 'Inserts a single row into a table. Requires READ + WRITE or ADMIN mode.',
    inputSchema: { table: z.string(), database: z.string().optional(), values: z.record(z.any()) }
  }, async ({ table, database, values }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const entries = Object.entries(values || {});
    if (!entries.length) throw new Error('values cannot be empty.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `INSERT INTO ${qualifiedTable(db, table)} (${entries.map(([k]) => quoteId(k)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
    const { rows } = await query(ctx, sql, entries.map(([, v]) => v));
    return result({ affectedRows: rows.affectedRows, insertId: rows.insertId });
  });

  tool('update_rows', {
    description: 'Updates rows. A WHERE clause is required by default and the operation may require approval in the desktop app.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), values: z.record(z.any()), where: z.record(z.any()), approval_id: z.string().optional()
    }
  }, async ({ table, database, values, where, approval_id }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const sets = Object.entries(values || {});
    if (!sets.length) throw new Error('values cannot be empty.');
    const w = buildWhere(where);
    if (ctx.settings.mcp?.requireWhereForUpdateDelete !== false && !w.sql) throw new Error('UPDATE without WHERE is blocked.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `UPDATE ${qualifiedTable(db, table)} SET ${sets.map(([k]) => `${quoteId(k)} = ?`).join(', ')}${w.sql}`;
    const gate = approvalResponse(ctx.approvals, {
      action: `update:${db}.${table}`, summary: `UPDATE on ${db}.${table}`, sql, approvalId: approval_id,
      required: ctx.settings.mcp?.confirmUpdate !== false
    });
    if (gate) return gate;
    const { rows } = await query(ctx, sql, [...sets.map(([, v]) => v), ...w.values]);
    return result({ affectedRows: rows.affectedRows, changedRows: rows.changedRows });
  });

  tool('delete_rows', {
    description: 'Deletes rows. A WHERE clause is required by default and the operation may require approval in the desktop app.',
    inputSchema: { table: z.string(), database: z.string().optional(), where: z.record(z.any()), approval_id: z.string().optional() }
  }, async ({ table, database, where, approval_id }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const w = buildWhere(where);
    if (ctx.settings.mcp?.requireWhereForUpdateDelete !== false && !w.sql) throw new Error('DELETE without WHERE is blocked.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `DELETE FROM ${qualifiedTable(db, table)}${w.sql}`;
    const gate = approvalResponse(ctx.approvals, {
      action: `delete:${db}.${table}`, summary: `DELETE on ${db}.${table}`, sql, approvalId: approval_id,
      required: ctx.settings.mcp?.confirmDelete !== false
    });
    if (gate) return gate;
    const { rows } = await query(ctx, sql, w.values);
    return result({ affectedRows: rows.affectedRows });
  });

  tool('create_database', {
    description: 'Creates a MySQL database. Requires ADMIN mode and DDL approval when enabled.',
    inputSchema: {
      database: z.string(), charset: z.string().optional(), collation: z.string().optional(),
      if_not_exists: z.boolean().optional(), approval_id: z.string().optional()
    }
  }, async ({ database, charset, collation, if_not_exists, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    const options = [];
    if (charset) options.push(`CHARACTER SET ${optionToken(charset, 'character set')}`);
    if (collation) options.push(`COLLATE ${optionToken(collation, 'collation')}`);
    const sql = `CREATE DATABASE ${if_not_exists ? 'IF NOT EXISTS ' : ''}${quoteId(database)}${options.length ? ` ${options.join(' ')}` : ''}`;
    const gate = approvalResponse(ctx.approvals, { action: `create_database:${database}`, summary: `CREATE DATABASE ${database}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_database', {
    description: 'Drops a database. Destructive ADMIN operation, always requires approval.',
    inputSchema: { database: z.string(), if_exists: z.boolean().optional(), approval_id: z.string().optional() }
  }, async ({ database, if_exists, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    const sql = `DROP DATABASE ${if_exists ? 'IF EXISTS ' : ''}${quoteId(database)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_database:${database}`, summary: `DROP DATABASE ${database}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('create_table', {
    description: 'Creates a table from a structured column definition. Column types are validated against the server version, so unsupported types are rejected with a clear message instead of failing at the server.',
    inputSchema: {
      table: z.string(),
      database: z.string().optional(),
      if_not_exists: z.boolean().optional(),
      engine: z.string().optional(),
      charset: z.string().optional(),
      collation: z.string().optional(),
      row_format: z.string().optional(),
      comment: z.string().optional(),
      approval_id: z.string().optional(),
      columns: z.array(z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean().optional(),
        primary_key: z.boolean().optional(),
        auto_increment: z.boolean().optional(),
        unique: z.boolean().optional(),
        default_value: z.any().optional(),
        comment: z.string().optional(),
        charset: z.string().optional(),
        on_update_current_timestamp: z.boolean().optional()
      })).min(1)
    }
  }, async ({ table, database, if_not_exists, engine, charset, collation, row_format, comment, columns, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);

    const defs = columns.map(c => {
      let d = `${quoteId(c.name)} ${validateColumnType(c.type, ctx.capabilities)}`;
      if (c.charset) d += ` CHARACTER SET ${quoteId(c.charset)}`;
      d += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.default_value !== undefined) d += ` DEFAULT ${sqlLiteral(c.default_value)}`;
      if (c.on_update_current_timestamp) {
        requireCapability(ctx, 'datetimeDefault', 'ON UPDATE CURRENT_TIMESTAMP is not supported on this server');
        d += ' ON UPDATE CURRENT_TIMESTAMP';
      }
      if (c.auto_increment) d += ' AUTO_INCREMENT';
      if (c.unique) d += ' UNIQUE';
      if (c.comment) d += ` COMMENT ${sqlLiteral(c.comment)}`;
      if (c.primary_key) d += ' PRIMARY KEY';
      return d;
    });

    const options = [];
    if (engine) options.push(`ENGINE=${optionToken(engine, 'engine')}`);
    if (charset) options.push(`CHARACTER SET=${optionToken(charset, 'character set')}`);
    if (collation) options.push(`COLLATE=${optionToken(collation, 'collation')}`);
    if (row_format) {
      requireCapability(ctx, 'onlineDdl', 'ROW_FORMAT is not supported on this server');
      options.push(`ROW_FORMAT=${optionToken(row_format, 'row format')}`);
    }
    if (comment) options.push(`COMMENT=${sqlLiteral(comment)}`);

    const sql = `CREATE TABLE ${if_not_exists ? 'IF NOT EXISTS ' : ''}${qualifiedTable(db, table)} (${defs.join(', ')})${options.length ? ` ${options.join(' ')}` : ''}`;
    const gate = approvalResponse(ctx.approvals, { action: `create_table:${db}.${table}`, summary: `CREATE TABLE ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_table', {
    description: 'Permanently drops a table. Requires ADMIN mode and approval.',
    inputSchema: { table: z.string(), database: z.string().optional(), if_exists: z.boolean().optional(), approval_id: z.string().optional() }
  }, async ({ table, database, if_exists, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `DROP TABLE ${if_exists ? 'IF EXISTS ' : ''}${qualifiedTable(db, table)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_table:${db}.${table}`, summary: `DROP TABLE ${db}.${table}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('add_column', {
    description: 'Adds a column to a table, with optional position, default value and comment.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), column: z.string(), type: z.string(),
      nullable: z.boolean().optional(), default_value: z.any().optional(), comment: z.string().optional(),
      position: z.enum(['FIRST', 'AFTER']).optional(), after_column: z.string().optional(),
      algorithm: z.enum(['DEFAULT', 'INSTANT', 'INPLACE', 'COPY']).optional(),
      approval_id: z.string().optional()
    }
  }, async ({ table, database, column, type, nullable, default_value, comment, position, after_column, algorithm, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    assertDdlAlgorithmSupported(ctx, algorithm);

    let d = `ADD COLUMN ${quoteId(column)} ${validateColumnType(type, ctx.capabilities)} ${nullable ? 'NULL' : 'NOT NULL'}`;
    if (default_value !== undefined) d += ` DEFAULT ${sqlLiteral(default_value)}`;
    if (comment) d += ` COMMENT ${sqlLiteral(comment)}`;
    if (position === 'FIRST') d += ' FIRST';
    if (position === 'AFTER') {
      if (!after_column) throw new Error('after_column is required when position is AFTER.');
      d += ` AFTER ${quoteId(after_column)}`;
    }
    if (algorithm && algorithm !== 'DEFAULT') d += `, ALGORITHM=${algorithm}`;

    const sql = `ALTER TABLE ${qualifiedTable(db, table)} ${d}`;
    const gate = approvalResponse(ctx.approvals, { action: `add_column:${db}.${table}.${column}`, summary: `ADD COLUMN ${column} on ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_column', {
    description: 'Drops a column. Destructive ADMIN operation, always requires approval.',
    inputSchema: { table: z.string(), database: z.string().optional(), column: z.string(), approval_id: z.string().optional() }
  }, async ({ table, database, column, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `ALTER TABLE ${qualifiedTable(db, table)} DROP COLUMN ${quoteId(column)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_column:${db}.${table}.${column}`, summary: `DROP COLUMN ${column} from ${db}.${table}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('modify_column', {
    description: 'Changes the type, nullability, default or position of a column.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), column: z.string(), type: z.string().optional(),
      nullable: z.boolean().optional(), default_value: z.any().optional(), comment: z.string().optional(),
      position: z.enum(['FIRST', 'AFTER']).optional(), after_column: z.string().optional(),
      approval_id: z.string().optional()
    }
  }, async ({ table, database, column, type, nullable, default_value, comment, position, after_column, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    if (!type && nullable === undefined && default_value === undefined && comment === undefined && !position) {
      throw new Error('Nothing to change. Provide type, nullable, default_value, comment or position.');
    }
    const db = effectiveDb(ctx.settings, database);
    const { rows: current } = await query(ctx,
      'SELECT column_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
      [db, table, column]
    );
    if (!current?.length) throw new Error(`Column '${column}' does not exist on ${db}.${table}.`);

    const finalType = validateColumnType(type || field(current[0], 'column_type'), ctx.capabilities);
    const finalNullable = nullable === undefined ? field(current[0], 'is_nullable') === 'YES' : nullable;

    let d = `MODIFY COLUMN ${quoteId(column)} ${finalType} ${finalNullable ? 'NULL' : 'NOT NULL'}`;
    if (default_value !== undefined) d += ` DEFAULT ${sqlLiteral(default_value)}`;
    if (comment !== undefined) d += ` COMMENT ${sqlLiteral(comment)}`;
    if (position === 'FIRST') d += ' FIRST';
    if (position === 'AFTER') {
      if (!after_column) throw new Error('after_column is required when position is AFTER.');
      d += ` AFTER ${quoteId(after_column)}`;
    }

    const sql = `ALTER TABLE ${qualifiedTable(db, table)} ${d}`;
    const gate = approvalResponse(ctx.approvals, { action: `modify_column:${db}.${table}.${column}`, summary: `MODIFY COLUMN ${column} on ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const result_ = await query(ctx, sql);
    return result({ affectedRows: result_.rows.affectedRows ?? 0 });
  });

  tool('create_index', {
    description: 'Creates an index on one or more columns. On servers with a small InnoDB key limit (MySQL 5.6) a prefix length is computed automatically so the statement still succeeds.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), index: z.string(),
      columns: z.array(z.string()).min(1),
      unique: z.boolean().optional(),
      index_type: z.enum(['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']).optional(),
      prefix_length: z.number().int().positive().optional(),
      algorithm: z.enum(['DEFAULT', 'INPLACE', 'COPY']).optional(),
      approval_id: z.string().optional()
    }
  }, async ({ table, database, index, columns, unique, index_type, prefix_length, algorithm, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    assertDdlAlgorithmSupported(ctx, algorithm);
    const db = effectiveDb(ctx.settings, database);

    const info = await tableInfo(ctx, db, table);
    if (!info.engine) throw new Error(`Table ${db}.${table} does not exist.`);
    const budget = indexKeyBudget(ctx.capabilities || {}, info);

    const { rows: columnRows } = await query(ctx,
      'SELECT column_name, data_type, character_maximum_length, character_set_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
      [db, table]
    );
    const byName = new Map(columnRows.map(c => [field(c, 'column_name'), c]));

    const notes = [];
    const parts = columns.map((name) => {
      const meta = byName.get(name);
      if (!meta) throw new Error(`Column '${name}' does not exist on ${db}.${table}.`);
      const type = String(field(meta, 'data_type')).toLowerCase();
      const isString = ['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(type);
      const isBinary = ['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(type);

      if (isString || isBinary) {
        const perChar = isBinary ? 1 : bytesPerChar(field(meta, 'character_set_name') || info.collation);
        const maxChars = Math.max(1, Math.floor(budget.perColumn / perChar));
        if (prefix_length) {
          if (prefix_length > maxChars) {
            throw new Error(`prefix_length ${prefix_length} exceeds the ${budget.perColumn} byte index limit for ${name} (max ${maxChars} characters).`);
          }
          return `${quoteId(name)}(${prefix_length})`;
        }
        const maxLength = Number(field(meta, 'character_maximum_length'));
        if (maxLength > maxChars || !maxLength) {
          notes.push(`${name} indexed with a ${maxChars} character prefix to stay under the ${budget.perColumn} byte limit`);
          return `${quoteId(name)}(${maxChars})`;
        }
      }
      return quoteId(name);
    });

    const unique_ = unique ? 'UNIQUE ' : '';
    const type_ = index_type ? ` USING ${index_type}` : '';
    const algo_ = algorithm && algorithm !== 'DEFAULT' ? `, ALGORITHM=${algorithm}` : '';
    const sql = `CREATE ${unique_}INDEX ${quoteId(index)} ON ${qualifiedTable(db, table)}${type_} (${parts.join(', ')})${algo_}`;

    const gate = approvalResponse(ctx.approvals, { action: `create_index:${db}.${table}.${index}`, summary: `CREATE INDEX ${index} on ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0, notes });
  });

  tool('drop_index', {
    description: 'Drops an index from a table.',
    inputSchema: { table: z.string(), database: z.string().optional(), index: z.string(), approval_id: z.string().optional() }
  }, async ({ table, database, index, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `DROP INDEX ${quoteId(index)} ON ${qualifiedTable(db, table)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_index:${db}.${table}.${index}`, summary: `DROP INDEX ${index} on ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('explain_query', {
    description: 'Returns the execution plan for a read statement without running it. Useful before running an expensive query.',
    inputSchema: { sql: z.string() }
  }, async ({ sql }) => {
    assertMode(ctx.settings, 'read');
    const text = String(sql || '').trim();
    if (!text) throw new Error('An SQL statement is required.');
    if (ctx.settings.mcp?.blockMultipleStatements !== false && hasMultipleStatements(text)) {
      throw new Error('Multiple statements are blocked. Explain one statement at a time.');
    }
    if (classifySql(text).kind !== 'read') throw new Error('Only read statements can be explained.');
    const { rows } = await query(ctx, `EXPLAIN ${text}`);
    return result(rows);
  });

  tool('execute_sql', {
    description: 'Runs a single free-form SQL statement. Access mode is always enforced; administrative SQL requires ADMIN mode plus the explicit free administrative SQL option.',
    inputSchema: { sql: z.string(), values: z.array(z.any()).optional(), approval_id: z.string().optional() }
  }, async ({ sql, values, approval_id }) => {
    const info = validateFreeSql(ctx.settings, sql);
    const shouldApprove = info.keyword === 'DELETE' ? ctx.settings.mcp?.confirmDelete !== false
      : info.keyword === 'UPDATE' ? ctx.settings.mcp?.confirmUpdate !== false
        : info.requiredMode === 'admin' ? ctx.settings.mcp?.confirmDdl !== false
          : false;
    const action = `execute_sql:${info.keyword}`;
    const gate = approvalResponse(ctx.approvals, { action, summary: `${info.keyword || 'SQL'} via execute_sql`, sql, approvalId: approval_id, required: shouldApprove });
    if (gate) return gate;
    const { rows } = await query(ctx, sql, values || []);
    if (Array.isArray(rows)) return result({ count: rows.length, rows });
    return result({ affectedRows: rows.affectedRows, changedRows: rows.changedRows, insertId: rows.insertId });
  });
}

function redact(args) {
  if (!args || typeof args !== 'object') return args;
  const copy = { ...args };
  if ('values' in copy && Array.isArray(copy.values)) copy.values = `[${copy.values.length} parameters]`;
  return copy;
}
