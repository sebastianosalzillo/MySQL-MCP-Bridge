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

  tool('list_sources', 'List configured read-only MySQL, Access and filesystem sources.', {},
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
  tool('list_directory', 'List files and folders under an authorized folder source.', {
    source_id: z.string(), path: z.string().optional(), limit: z.number().int().positive().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'list_directory', args));

  tool('get_file_info', 'Read file or directory metadata without modifying it.', {
    source_id: z.string(), path: z.string()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'get_file_info', args));

  tool('read_text_file', 'Read bounded plain text from an authorized folder. Binary files are blocked.', {
    source_id: z.string(), path: z.string(), max_chars: z.number().int().positive().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'read_text_file', args));

  tool('read_document', 'Read bounded extracted text from PDF, Word DOCX or Excel XLSX in an authorized folder. Scanned PDFs require separate OCR.', {
    source_id: z.string(), path: z.string(), max_chars: z.number().int().positive().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'read_document', args));

  tool('search_files', 'Search files by name in an authorized folder (bounded depth and results).', {
    source_id: z.string(), path: z.string().optional(), name: z.string().optional(),
    max_depth: z.number().int().nonnegative().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'search_files', args));

  tool('search_text', 'Find text in authorized text files, PDF, DOCX and XLSX with safe limits.', {
    source_id: z.string(), query: z.string(), path: z.string().optional(),
    name: z.string().optional(), max_depth: z.number().int().nonnegative().optional()
  }, ({ source_id, ...args }) => registry.execute(source_id, 'search_text', args));
}
