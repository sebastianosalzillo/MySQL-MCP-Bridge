import { connectWithFallback, queryWithTimeout } from './mysqlManager.mjs';
import { assertTableAllowed, buildWhere, quoteId, qualifiedTable, validateFreeSql } from './security.mjs';
import { runAccess } from './access/runner.mjs';

function limitFor(settings, requested) {
  const cap = Math.min(5000, Math.max(1, Number(settings.mcp?.selectLimit || 200)));
  const n = requested === undefined ? cap : Number(requested);
  if (!Number.isInteger(n) || n < 1) throw new Error('limit must be a positive integer.');
  return Math.min(cap, n);
}

function safeOffset(offset = 0) {
  const n = Number(offset);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000) {
    throw new Error('offset must be an integer from 0 to 1000000.');
  }
  return n;
}

export function createSourceRegistry(settings, deps = {}) {
  const byId = new Map(settings.sources.map(s => [s.id, s]));
  const pending = new Map();
  const connections = new Map();
  const query = deps.query || queryWithTimeout;
  const open = deps.open || connectWithFallback;
  const access = deps.access || runAccess;
  let closed = false;

  const findSource = id => {
    if (closed) throw new Error('Bridge has been stopped.');
    const source = byId.get(id);
    if (!source) throw new Error('Unknown source_id.');
    return source;
  };

  const assertTable = (source, table) => {
    if (!table || typeof table !== 'string') throw new Error('table is required.');
    assertTableAllowed({ mcp: { allowedTables: source.allowedTables || [] } }, table);
  };

  async function mysqlConnection(source) {
    if (connections.has(source.id)) return connections.get(source.id);
    if (!pending.has(source.id)) {
      const promise = open({
        mysql: source.mysql,
        mcp: { accessMode: 'read', blockMultipleStatements: true, blockFileAccess: true }
      }).then(result => {
        connections.set(source.id, result);
        return result;
      }).finally(() => pending.delete(source.id));
      pending.set(source.id, promise);
    }
    return pending.get(source.id);
  }

  async function doQuery(source, sql, values = []) {
    const c = await mysqlConnection(source);
    const [rows] = await query(c.pool, sql, values, settings.mcp?.queryTimeoutMs || 30000);
    return rows;
  }

  async function execute(sourceId, operation, args = {}) {
    const source = findSource(sourceId);
    const max = limitFor(settings, args.limit);
    const offset = safeOffset(args.offset);
    if (operation === 'list_tables') {
      if (source.type === 'access') {
        const tables = await access(source, 'list_tables', { limit: max }, settings);
        return (source.allowedTables?.length ? tables.filter(t => source.allowedTables.includes(t.name)) : tables);
      }
      const rows = await doQuery(source, 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = ? ORDER BY table_name',
        [source.mysql.database, 'BASE TABLE']);
      const names = rows.map(r => ({ name: r.name || r.NAME || r.table_name || r.TABLE_NAME }));
      return source.allowedTables?.length ? names.filter(t => source.allowedTables.includes(t.name)) : names;
    }

    if (operation === 'describe_table') {
      assertTable(source, args.table);
      if (source.type === 'access') return access(source, 'describe_table', { table: args.table }, settings);
      return doQuery(source,
        'SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
        [source.mysql.database, args.table]);
    }

    if (operation === 'select_rows') {
      assertTable(source, args.table);
      const cols = !args.columns?.length || args.columns.includes('*')
        ? '*' : args.columns.map(quoteId).join(', ');
      if (source.type === 'access') {
        if (args.where && Object.keys(args.where).length) {
          throw new Error('Access structured filters are not available yet; use table, columns and limit.');
        }
        return access(source, 'select_rows',
          { table: args.table, columns: args.columns || [], limit: max, offset }, settings);
      }
      const where = buildWhere(args.where);
      let sql = 'SELECT ' + cols + ' FROM ' + qualifiedTable(source.mysql.database, args.table) + where.sql;
      if (args.order_by) sql += ' ORDER BY ' + quoteId(args.order_by) + (args.order_direction === 'DESC' ? ' DESC' : ' ASC');
      sql += ' LIMIT ' + max + ' OFFSET ' + offset;
      const rows = await doQuery(source, sql, where.values);
      return { count: rows.length, rows };
    }

    if (operation === 'read_query') {
      if (source.type !== 'mysql') throw new Error('Free SQL is disabled for Access.');
      if (source.allowedTables?.length) {
        throw new Error('Free SQL is disabled with table whitelist; use select_rows.');
      }
      const sql = String(args.sql || '').trim().replace(/;\s*$/, '');
      if (!/^SELECT\b/i.test(sql)) throw new Error('Only SELECT is accepted by the read_query tool.');
      const info = validateFreeSql({
        mcp: { accessMode: 'read', blockMultipleStatements: true, blockFileAccess: true,
          allowSlowFunctions: false, allowedTables: [] }
      }, sql);
      if (info.keyword !== 'SELECT') throw new Error('Only SELECT is allowed.');
      // An outer limit bounds the returned result at the database, not just in JavaScript.
      const rows = await doQuery(source, 'SELECT * FROM (' + sql + ') AS _mcp_result LIMIT ' + max, args.values || []);
      return { count: rows.length, rows };
    }
    throw new Error('Unsupported read operation.');
  }

  return {
    listSources: () => [...byId.values()].map(s => ({
      id: s.id, name: s.name || s.id, type: s.type,
      connected: s.type === 'mysql' ? connections.has(s.id) : undefined
    })),
    execute,
    close: async () => {
      closed = true;
      await Promise.allSettled([...pending.values()]);
      await Promise.allSettled([...connections.values()].map(c => c.pool.end()));
      connections.clear();
    }
  };
}
