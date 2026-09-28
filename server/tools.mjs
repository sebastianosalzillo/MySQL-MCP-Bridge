import { z } from 'zod';
import { assertMode, assertTableAllowed, buildWhere, classifySql, qualifiedTable, quoteId, validateColumnType, validateFreeSql } from './security.mjs';
import { queryWithTimeout } from './mysqlManager.mjs';

const json = (value) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const result = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }] });
const failure = (err) => ({ content: [{ type: 'text', text: `Errore: ${err?.message || String(err)}` }], isError: true });

function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Default numerico non valido.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('default_value deve essere stringa, numero, booleano o null.');
}

function effectiveDb(settings, database) {
  return database || settings.mysql?.database || '';
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
            ? 'Operazione negata dall’utente nell’app desktop.'
            : 'Apri MySQL MCP Bridge, approva la richiesta e ripeti la chiamata con lo stesso approval_id.'
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
      message: 'Approvazione richiesta nell’app desktop. Dopo l’approvazione ripeti la stessa chiamata passando approval_id.'
    }) }],
    isError: true
  };
}

async function query(ctx, sql, values = []) {
  ctx.log('query', { sql, valuesCount: values.length });
  const [rows, fields] = await queryWithTimeout(ctx.pool, sql, values, ctx.settings.mcp?.queryTimeoutMs);
  return { rows, fields: fields?.map?.(f => ({ name: f.name, table: f.table, type: f.columnType })) || undefined };
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
    description: 'Mostra versione MySQL, database corrente e utente corrente.',
    inputSchema: {}
  }, async () => {
    assertMode(ctx.settings, 'read');
    const { rows } = await query(ctx, 'SELECT VERSION() AS version, DATABASE() AS database_name, CURRENT_USER() AS current_user');
    return result(rows[0]);
  });

  tool('list_databases', {
    description: 'Elenca i database visibili dall’utente MySQL configurato.',
    inputSchema: {}
  }, async () => {
    assertMode(ctx.settings, 'read');
    const { rows } = await query(ctx, 'SHOW DATABASES');
    return result(rows);
  });

  tool('list_tables', {
    description: 'Elenca le tabelle di un database. Se non specificato usa il database configurato.',
    inputSchema: { database: z.string().optional() }
  }, async ({ database }) => {
    assertMode(ctx.settings, 'read');
    const db = effectiveDb(ctx.settings, database);
    if (!db) throw new Error('Specificare un database.');
    const { rows } = await query(ctx,
      'SELECT table_name, table_type, engine, table_rows, table_comment FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
      [db]
    );
    const allow = ctx.settings.mcp?.allowedTables || [];
    return result(allow.length ? rows.filter(r => allow.includes(r.table_name || r.TABLE_NAME)) : rows);
  });

  tool('describe_table', {
    description: 'Descrive colonne, tipi, nullabilità, chiavi, default ed extra di una tabella.',
    inputSchema: { table: z.string(), database: z.string().optional() }
  }, async ({ table, database }) => {
    assertMode(ctx.settings, 'read');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    if (!db) throw new Error('Specificare un database.');
    const { rows } = await query(ctx,
      `SELECT column_name, column_type, is_nullable, column_key, column_default, extra, column_comment
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [db, table]
    );
    return result(rows);
  });

  tool('get_foreign_keys', {
    description: 'Mostra le foreign key di una tabella.',
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
    description: 'Esegue una SELECT parametrizzata su una tabella con filtri di uguaglianza e limite controllato.',
    inputSchema: {
      table: z.string(),
      database: z.string().optional(),
      columns: z.array(z.string()).optional(),
      where: z.record(z.any()).optional(),
      order_by: z.string().optional(),
      order_direction: z.enum(['ASC', 'DESC']).optional(),
      limit: z.number().int().positive().optional()
    }
  }, async ({ table, database, columns, where, order_by, order_direction, limit }) => {
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
    const { rows } = await query(ctx, sql, w.values);
    return result({ count: rows.length, rows });
  });

  tool('insert_rows', {
    description: 'Inserisce una riga in una tabella. Richiede modalità READ+WRITE o ADMIN.',
    inputSchema: { table: z.string(), database: z.string().optional(), values: z.record(z.any()) }
  }, async ({ table, database, values }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const entries = Object.entries(values || {});
    if (!entries.length) throw new Error('values non può essere vuoto.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `INSERT INTO ${qualifiedTable(db, table)} (${entries.map(([k]) => quoteId(k)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
    const { rows } = await query(ctx, sql, entries.map(([,v]) => v));
    return result({ affectedRows: rows.affectedRows, insertId: rows.insertId });
  });

  tool('update_rows', {
    description: 'Aggiorna righe con WHERE obbligatorio di default. Può richiedere approvazione nell’app.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), values: z.record(z.any()), where: z.record(z.any()), approval_id: z.string().optional()
    }
  }, async ({ table, database, values, where, approval_id }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const sets = Object.entries(values || {});
    if (!sets.length) throw new Error('values non può essere vuoto.');
    const w = buildWhere(where);
    if (ctx.settings.mcp?.requireWhereForUpdateDelete !== false && !w.sql) throw new Error('UPDATE senza WHERE bloccato.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `UPDATE ${qualifiedTable(db, table)} SET ${sets.map(([k]) => `${quoteId(k)} = ?`).join(', ')}${w.sql}`;
    const gate = approvalResponse(ctx.approvals, {
      action: `update:${db}.${table}`, summary: `UPDATE su ${db}.${table}`, sql, approvalId: approval_id,
      required: ctx.settings.mcp?.confirmUpdate !== false
    });
    if (gate) return gate;
    const { rows } = await query(ctx, sql, [...sets.map(([,v]) => v), ...w.values]);
    return result({ affectedRows: rows.affectedRows, changedRows: rows.changedRows });
  });

  tool('delete_rows', {
    description: 'Elimina righe con WHERE obbligatorio di default. Richiede approvazione se configurata.',
    inputSchema: { table: z.string(), database: z.string().optional(), where: z.record(z.any()), approval_id: z.string().optional() }
  }, async ({ table, database, where, approval_id }) => {
    assertMode(ctx.settings, 'write');
    assertTableAllowed(ctx.settings, table);
    const w = buildWhere(where);
    if (ctx.settings.mcp?.requireWhereForUpdateDelete !== false && !w.sql) throw new Error('DELETE senza WHERE bloccato.');
    const db = effectiveDb(ctx.settings, database);
    const sql = `DELETE FROM ${qualifiedTable(db, table)}${w.sql}`;
    const gate = approvalResponse(ctx.approvals, {
      action: `delete:${db}.${table}`, summary: `DELETE su ${db}.${table}`, sql, approvalId: approval_id,
      required: ctx.settings.mcp?.confirmDelete !== false
    });
    if (gate) return gate;
    const { rows } = await query(ctx, sql, w.values);
    return result({ affectedRows: rows.affectedRows });
  });

  tool('create_database', {
    description: 'Crea un database MySQL. Richiede modalità ADMIN e approvazione DDL se attiva.',
    inputSchema: { database: z.string(), approval_id: z.string().optional() }
  }, async ({ database, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    const sql = `CREATE DATABASE ${quoteId(database)}`;
    const gate = approvalResponse(ctx.approvals, { action: `create_database:${database}`, summary: `CREATE DATABASE ${database}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_database', {
    description: 'Elimina un database. Operazione distruttiva ADMIN con approvazione.',
    inputSchema: { database: z.string(), approval_id: z.string().optional() }
  }, async ({ database, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    const sql = `DROP DATABASE ${quoteId(database)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_database:${database}`, summary: `DROP DATABASE ${database}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('create_table', {
    description: 'Crea una tabella da una definizione strutturata di colonne.',
    inputSchema: {
      table: z.string(), database: z.string().optional(), approval_id: z.string().optional(),
      columns: z.array(z.object({
        name: z.string(), type: z.string(), nullable: z.boolean().optional(), primary_key: z.boolean().optional(),
        auto_increment: z.boolean().optional(), unique: z.boolean().optional(), default_value: z.any().optional()
      })).min(1)
    }
  }, async ({ table, database, columns, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const defs = columns.map(c => {
      let d = `${quoteId(c.name)} ${validateColumnType(c.type)}`;
      d += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.default_value !== undefined) d += ` DEFAULT ${sqlLiteral(c.default_value)}`;
      if (c.auto_increment) d += ' AUTO_INCREMENT';
      if (c.unique) d += ' UNIQUE';
      if (c.primary_key) d += ' PRIMARY KEY';
      return d;
    });
    const sql = `CREATE TABLE ${qualifiedTable(db, table)} (${defs.join(', ')})`;
    const gate = approvalResponse(ctx.approvals, { action: `create_table:${db}.${table}`, summary: `CREATE TABLE ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_table', {
    description: 'Elimina definitivamente una tabella. Richiede ADMIN e approvazione.',
    inputSchema: { table: z.string(), database: z.string().optional(), approval_id: z.string().optional() }
  }, async ({ table, database, approval_id }) => {
    assertMode(ctx.settings, 'admin');
    assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `DROP TABLE ${qualifiedTable(db, table)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_table:${db}.${table}`, summary: `DROP TABLE ${db}.${table}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql);
    return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('add_column', {
    description: 'Aggiunge una colonna a una tabella.',
    inputSchema: { table: z.string(), database: z.string().optional(), column: z.string(), type: z.string(), nullable: z.boolean().optional(), approval_id: z.string().optional() }
  }, async ({ table, database, column, type, nullable, approval_id }) => {
    assertMode(ctx.settings, 'admin'); assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `ALTER TABLE ${qualifiedTable(db, table)} ADD COLUMN ${quoteId(column)} ${validateColumnType(type)} ${nullable ? 'NULL' : 'NOT NULL'}`;
    const gate = approvalResponse(ctx.approvals, { action: `add_column:${db}.${table}.${column}`, summary: `ADD COLUMN ${column} su ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql); return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_column', {
    description: 'Elimina una colonna. Operazione distruttiva ADMIN.',
    inputSchema: { table: z.string(), database: z.string().optional(), column: z.string(), approval_id: z.string().optional() }
  }, async ({ table, database, column, approval_id }) => {
    assertMode(ctx.settings, 'admin'); assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `ALTER TABLE ${qualifiedTable(db, table)} DROP COLUMN ${quoteId(column)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_column:${db}.${table}.${column}`, summary: `DROP COLUMN ${column} da ${db}.${table}`, sql, approvalId: approval_id, required: true });
    if (gate) return gate;
    const { rows } = await query(ctx, sql); return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('modify_column', {
    description: 'Modifica il tipo/nullabilità di una colonna.',
    inputSchema: { table: z.string(), database: z.string().optional(), column: z.string(), type: z.string(), nullable: z.boolean().optional(), approval_id: z.string().optional() }
  }, async ({ table, database, column, type, nullable, approval_id }) => {
    assertMode(ctx.settings, 'admin'); assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `ALTER TABLE ${qualifiedTable(db, table)} MODIFY COLUMN ${quoteId(column)} ${validateColumnType(type)} ${nullable ? 'NULL' : 'NOT NULL'}`;
    const gate = approvalResponse(ctx.approvals, { action: `modify_column:${db}.${table}.${column}`, summary: `MODIFY COLUMN ${column} su ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql); return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('create_index', {
    description: 'Crea un indice su una o più colonne.',
    inputSchema: { table: z.string(), database: z.string().optional(), index: z.string(), columns: z.array(z.string()).min(1), unique: z.boolean().optional(), approval_id: z.string().optional() }
  }, async ({ table, database, index, columns, unique, approval_id }) => {
    assertMode(ctx.settings, 'admin'); assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteId(index)} ON ${qualifiedTable(db, table)} (${columns.map(quoteId).join(', ')})`;
    const gate = approvalResponse(ctx.approvals, { action: `create_index:${db}.${table}.${index}`, summary: `CREATE INDEX ${index} su ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql); return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('drop_index', {
    description: 'Elimina un indice da una tabella.',
    inputSchema: { table: z.string(), database: z.string().optional(), index: z.string(), approval_id: z.string().optional() }
  }, async ({ table, database, index, approval_id }) => {
    assertMode(ctx.settings, 'admin'); assertTableAllowed(ctx.settings, table);
    const db = effectiveDb(ctx.settings, database);
    const sql = `DROP INDEX ${quoteId(index)} ON ${qualifiedTable(db, table)}`;
    const gate = approvalResponse(ctx.approvals, { action: `drop_index:${db}.${table}.${index}`, summary: `DROP INDEX ${index} su ${db}.${table}`, sql, approvalId: approval_id, required: ctx.settings.mcp?.confirmDdl !== false });
    if (gate) return gate;
    const { rows } = await query(ctx, sql); return result({ affectedRows: rows.affectedRows ?? 0 });
  });

  tool('execute_sql', {
    description: 'Esegue una singola query SQL libera. Rispetta modalità READ/WRITE/ADMIN; SQL amministrativo richiede ADMIN e abilitazione esplicita.',
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
  if ('values' in copy && Array.isArray(copy.values)) copy.values = `[${copy.values.length} parametri]`;
  return copy;
}
