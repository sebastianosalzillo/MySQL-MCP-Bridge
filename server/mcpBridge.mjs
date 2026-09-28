import http from 'node:http';
import express from 'express';
import ngrok from '@ngrok/ngrok';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPool, queryWithTimeout, testConnection } from './mysqlManager.mjs';
import { ApprovalManager } from './approvalManager.mjs';
import { registerTools } from './tools.mjs';
import { validateFreeSql } from './security.mjs';

export { testConnection as testMySql };

function normalizeDomain(domain) {
  return String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function makeLogger(callback = () => {}) {
  return (type, data) => callback({
    time: new Date().toISOString(),
    type,
    data
  });
}

export async function startBridge(settings, hooks = {}) {
  const log = makeLogger(hooks.onLog);
  const pool = createPool(settings);
  const approvals = new ApprovalManager(hooks.onApproval);
  let listener = null;
  let httpServer = null;
  let stopping = false;
  let publicBase = '';

  const cleanupStartup = async () => {
    if (listener) {
      try { await listener.close(); } catch {}
      try { await ngrok.disconnect(); } catch {}
      listener = null;
    }
    if (httpServer) {
      await new Promise(resolve => httpServer.close(() => resolve()));
      httpServer = null;
    }
    try { await pool.end(); } catch {}
  };

  try {
    await queryWithTimeout(pool, 'SELECT 1 AS ok', [], settings.mcp?.queryTimeoutMs || 30000);
    log('status', { message: 'MySQL connesso.' });

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    app.get('/health', (_req, res) => res.json({ ok: true, service: 'mysql-mcp-bridge' }));

    app.post('/mcp', async (req, res) => {
      const token = settings.mcp?.bearerToken || '';
      if (token && req.get('authorization') !== `Bearer ${token}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const server = new McpServer({ name: 'mysql-mcp-bridge', version: '0.1.0' }, { capabilities: { logging: {} } });
      registerTools(server, { pool, settings, approvals, log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          Promise.resolve(transport.close()).catch(() => {});
          Promise.resolve(server.close()).catch(() => {});
        });
      } catch (err) {
        log('error', { message: err?.message || String(err) });
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
      }
    });

    app.all('/mcp', (req, res) => {
      if (req.method === 'POST') return;
      res.status(405).json({ error: 'Method not allowed. Use POST for MCP Streamable HTTP.' });
    });

    const port = Number(settings.mcp?.port || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta MCP non valida.');
    httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', resolve);
    });

    if (settings.ngrok?.enabled) {
      if (!settings.ngrok?.authtoken) throw new Error('ngrok abilitato ma Authtoken mancante.');
      const options = {
        addr: `127.0.0.1:${port}`,
        authtoken: settings.ngrok.authtoken,
        onStatusChange: status => log('ngrok', { status })
      };
      const domain = normalizeDomain(settings.ngrok.domain);
      if (domain) options.domain = domain;
      listener = await ngrok.forward(options);
      publicBase = String(listener.url() || '').replace(/\/+$/, '');
      log('ngrok', { message: 'Tunnel ngrok online.', url: publicBase });
    }

    const state = () => ({
      running: !stopping,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      publicUrl: publicBase ? `${publicBase}/mcp` : '',
      healthUrl: publicBase ? `${publicBase}/health` : `http://127.0.0.1:${port}/health`,
      mysqlHost: settings.mysql?.host || '',
      mysqlDatabase: settings.mysql?.database || '',
      accessMode: settings.mcp?.accessMode || 'read'
    });

    hooks.onStatus?.(state());
    log('status', { message: 'MCP server avviato.', ...state() });

    return {
      status: state,
      listApprovals: () => approvals.list(),
      decideApproval: (id, approved) => {
        const ok = approvals.decide(id, approved);
        log('approval', { id, approved, ok });
        return ok;
      },
      stop: async () => {
        if (stopping) return;
        stopping = true;
        await cleanupStartup();
        log('status', { message: 'Bridge arrestato.' });
      }
    };
  } catch (err) {
    await cleanupStartup();
    log('error', { message: `Avvio fallito: ${err?.message || String(err)}` });
    throw err;
  }
}

export async function runLocalSql(settings, sql) {
  const info = validateFreeSql(settings, sql);
  const pool = createPool(settings);
  try {
    const [rows] = await queryWithTimeout(pool, sql, [], settings.mcp?.queryTimeoutMs || 30000);
    return {
      ok: true,
      kind: info.kind,
      result: Array.isArray(rows)
        ? { count: rows.length, rows }
        : { affectedRows: rows.affectedRows, changedRows: rows.changedRows, insertId: rows.insertId }
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    await pool.end();
  }
}
