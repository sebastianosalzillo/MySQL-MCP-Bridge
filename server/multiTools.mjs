import { z } from 'zod';

function success(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function failure(error) {
  return { isError: true, content: [{ type: 'text', text: error?.message || String(error) }] };
}

/** Explicitly read-only MCP tools. There are no INSERT, UPDATE or ADMIN tools. */
export function registerMultiTools(server, registry) {
  const tool = (name, description, schema, action) => server.registerTool(
    name, { description, inputSchema: schema }, async args => {
      try { return success(await action(args || {})); } catch (error) { return failure(error); }
    }
  );

  tool('list_sources', 'List configured read-only MySQL and Access connections.', {},
    () => registry.listSources());

  tool('list_tables', 'List authorized tables in one configured source.', {
    source_id: z.string()
  }, ({ source_id }) => registry.execute(source_id, 'list_tables'));

  tool('describe_table', 'List the columns of one authorized table.', {
    source_id: z.string(), table: z.string()
  }, ({ source_id, table }) => registry.execute(source_id, 'describe_table', { table }));

  tool('select_rows', 'Read a limited number of rows from one table. Supports filters and ordering on MySQL; Access currently supports columns and limits.', {
    source_id: z.string(),
    table: z.string(),
    columns: z.array(z.string()).optional(),
    where: z.record(z.any()).optional(),
    order_by: z.string().optional(),
    order_direction: z.enum(['ASC', 'DESC']).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'select_rows', args));

  tool('read_query', 'Run a single bounded SELECT on one MySQL source. Not available for Access or sources with table whitelists.', {
    source_id: z.string(), sql: z.string(), values: z.array(z.any()).optional(),
    limit: z.number().int().positive().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'read_query', args));
}
