import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRegistry } from '../server/sourceRegistry.mjs';
import { registerMultiTools } from '../server/multiTools.mjs';
import { validateStandaloneSettings } from '../server/standaloneConfig.mjs';

const config = () => ({
  sources: [
    { id: 'cash', name: 'Cash', type: 'mysql', mysql: { host: '10.1.1.1', port: 3306, database: 'cash', user: 'readonly' } },
    { id: 'shop02', name: 'Shop 02', type: 'mysql', mysql: { host: '10.1.1.2', port: 3307, database: 'shop', user: 'readonly' }, allowedTables: ['products'] },
    { id: 'legacy', name: 'Access', type: 'access', file: 'C:\\data\\legacy.mdb', allowedTables: ['Products'] }
  ],
  mcp: { accessMode: 'read', selectLimit: 100, blockMultipleStatements: true, blockFileAccess: true },
  ngrok: { enabled: false }
});

test('multi-source settings validate independent MySQL connections and both Access extensions', () => {
  const s = config();
  s.sources.push({ id: 'modern', type: 'access', file: 'C:\\data\\new.accdb' });
  assert.equal(validateStandaloneSettings(s).sources.length, 4);
  assert.throws(() => validateStandaloneSettings({ ...s, sources: [s.sources[0], s.sources[0]] }), /Duplicate/);
  assert.throws(() => validateStandaloneSettings({
    ...s, sources: [{ id: 'bad', type: 'access', file: 'C:\\oops.exe' }]
  }), /needs a .mdb or .accdb/);
  assert.throws(() => validateStandaloneSettings({ ...s, mcp: { accessMode: 'write' } }), /requires.*read/);
});

test('MCP multi-source exports read tools only', () => {
  const names = [];
  registerMultiTools({ registerTool: (name) => names.push(name) }, {
    listSources: () => [], execute: async () => []
  });
  assert.deepEqual(names.sort(), ['describe_table', 'get_file_info', 'list_directory', 'list_sources', 'list_tables', 'read_document', 'read_query', 'read_text_file', 'search_files', 'search_text', 'select_rows']);
});

test('MySQL pools connect lazily and query their own configured host and port', async () => {
  const starts = [];
  const sql = [];
  const closes = [];
  const registry = createSourceRegistry(config(), {
    open: async setting => {
      starts.push(setting.mysql.host + ':' + setting.mysql.port);
      return { pool: { host: setting.mysql.host, end: async () => closes.push(setting.mysql.host) } };
    },
    query: async (pool, statement, values) => {
      sql.push({ host: pool.host, statement, values });
      if (/information_schema/.test(statement)) return [[{ name: 'products' }]];
      return [[{ count: 17 }]];
    },
    access: async () => []
  });
  assert.deepEqual(starts, []);
  const result = await registry.execute('cash', 'read_query', { sql: 'SELECT COUNT(*) AS count FROM orders' });
  assert.equal(result.rows[0].count, 17);
  assert.match(sql[0].statement, /^SELECT \* FROM \(SELECT COUNT/);
  assert.match(sql[0].statement, / LIMIT 100$/);
  await registry.execute('shop02', 'list_tables');
  assert.deepEqual(starts, ['10.1.1.1:3306', '10.1.1.2:3307']);
  assert.equal(sql[1].host, '10.1.1.2');
  await registry.close();
  assert.deepEqual(closes.sort(), ['10.1.1.1', '10.1.1.2']);
});

test('whitelist, non SELECT, unknown source and Access free SQL are denied', async () => {
  const registry = createSourceRegistry(config(), {
    open: async () => { throw Error('No DB should be contacted'); },
    access: async () => []
  });
  await assert.rejects(() => registry.execute('shop02', 'read_query', { sql: 'SELECT * FROM products' }), /whitelist/);
  await assert.rejects(() => registry.execute('cash', 'read_query', { sql: 'DELETE FROM users' }), /Only SELECT/);
  await assert.rejects(() => registry.execute('cash', 'read_query', { sql: 'SELECT * FROM x; DROP TABLE x' }), /Multiple statements/);
  await assert.rejects(() => registry.execute('cash', 'read_query', { sql: "SELECT LOAD_FILE('/tmp/x')" }), /Blocked construct/);
  await assert.rejects(() => registry.execute('legacy', 'read_query', { sql: 'SELECT * FROM Products' }), /disabled for Access/);
  await assert.rejects(() => registry.execute('missing', 'list_tables'), /Unknown source_id/);
  await assert.rejects(() => registry.execute('legacy', 'select_rows', { table: 'Hidden' }), /whitelist/);
  await registry.close();
});

test('Access operations are dispatched through read-only structured adapter', async () => {
  const calls = [];
  const registry = createSourceRegistry(config(), {
    open: async () => { throw Error('MySQL must not be used'); },
    access: async (source, operation, args) => {
      calls.push({ id: source.id, operation, args });
      return operation === 'list_tables' ? [{ name: 'Products' }, { name: 'Private' }] : { count: 1, rows: [{ Name: 'Soap' }] };
    }
  });
  assert.deepEqual(await registry.execute('legacy', 'list_tables'), [{ name: 'Products' }]);
  const rows = await registry.execute('legacy', 'select_rows', { table: 'Products', limit: 20 });
  assert.equal(rows.count, 1);
  assert.equal(calls.at(-1).args.limit, 20);
  await assert.rejects(() => registry.execute('legacy', 'select_rows', {
    table: 'Products', where: { id: 1 }
  }), /structured filters/);
  await registry.close();
});
