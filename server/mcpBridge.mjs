import http from 'node:http';
import { createRequire } from 'node:module';
import express from 'express';
import ngrok from '@ngrok/ngrok';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { connectWithFallback, openSession, queryWithTimeout, testConnection } from './mysqlManager.mjs';
import { ApprovalManager } from './approvalManager.mjs';
import { registerTools } from './tools.mjs';
import { compatibilityWarnings, describeVersion } from './mysqlVersion.mjs';
import { validateFreeSql } from './security.mjs';

export { testConnection as testMySql };

const require = createRequire(import.meta.url);
const SERVER_INFO = { name: 'mysql-mcp-bridge', version: require('../package.json').version };

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

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export async function startBridge(settings, hooks = {}) {
  if (Array.isArray(settings.sources) && settings.sources.length) {
    const { startMultiBridge } = await import('./multiBridge.mjs');
    return startMultiBridge(settings, hooks);
  }
  const log = makeLogger(hooks.onLog);
  const approvals = new ApprovalManager(hooks.onApproval);
  let listener = null;
  let httpServer = null;
  let stopping = false;
  let publicBase = '';
  let pool = null;
  let serverVersion = null;
  let capabilities = null;
  let tlsMode = 'off';
  let collationKey = '';

  const cleanupStartup = async () => {
    if (listener) {
      try { await listener.close(); } catch { /* tunnel already closed */ }
      try { await ngrok.disconnect(); } catch { /* nothing to disconnect */ }
      listener = null;
    }
    if (httpServer) {
      await new Promise(resolve => httpServer.close(() => resolve()));
      httpServer = null;
    }
    if (pool) {
      try { await pool.end(); } catch { /* pool already closed */ }
      pool = null;
    }
  };

  try {
    const connected = await connectWithFallback(settings, {
      onAttempt: info => log('connect', {
        message: `Retrying connection with ${info.label}.`,
        attempt: info.attempt,
        of: info.of,
        previous_error: info.reason?.message || String(info.reason)
      })
    });
    pool = connected.pool;
    serverVersion = connected.version;
    capabilities = connected.capabilities;
    tlsMode = connected.tlsMode;
    collationKey = connected.collation?.key || '';

    log('status', { message: `Connected to ${describeVersion(serverVersion)}.` });

    await openSession(pool, settings, {
      onSession: applied => log('session', { message: 'Session defaults applied.', applied }),
      onWarn: message => log('warn', { message })
    });

    await queryWithTimeout(pool, 'SELECT 1 AS ok', [], settings.mcp?.queryTimeoutMs || 30000);

    for (const warning of compatibilityWarnings(serverVersion, capabilities)) {
      log('compat', warning);
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    app.get('/health', (req, res) => {
      // Through the tunnel the payload stays generic; the details are only
      // exposed to loopback callers.
      if (!isLoopback(req)) return res.json({ ok: true, service: SERVER_INFO.name });
      return res.json({
        ok: true,
        service: SERVER_INFO.name,
        version: SERVER_INFO.version,
        mysql: describeVersion(serverVersion),
        mysql_version: serverVersion.raw,
        access_mode: settings.mcp?.accessMode || 'read',
        tls: tlsMode
      });
    });

    const bearer = settings.mcp?.bearerToken || '';

    app.post('/mcp', async (req, res) => {
      if (bearer && req.get('authorization') !== `Bearer ${bearer}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Resolved per request because the tunnel host is only known once ngrok is up.
      const allowedHosts = buildAllowedHosts(settings, publicBase);
      const allowedOrigins = buildAllowedOrigins(settings, publicBase);

      const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });
      registerTools(server, { pool, settings, approvals, log, capabilities, serverVersion, tlsMode });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Most remote MCP clients expect application/json rather than an SSE
        // stream, so JSON is the default and SSE stays opt-in.
        enableJsonResponse: settings.mcp?.jsonResponses !== false,
        enableDnsRebindingProtection: Boolean(allowedHosts.length || allowedOrigins.length),
        ...(allowedHosts.length ? { allowedHosts } : {}),
        ...(allowedOrigins.length ? { allowedOrigins } : {})
      });

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
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP port.');
    httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', resolve);
    });

    if (settings.ngrok?.enabled) {
      if (!settings.ngrok?.authtoken) throw new Error('ngrok is enabled but the authtoken is missing.');
      const options = {
        addr: `127.0.0.1:${port}`,
        authtoken: settings.ngrok.authtoken,
        onStatusChange: status => log('ngrok', { status })
      };
      const domain = normalizeDomain(settings.ngrok.domain);
      if (domain) options.domain = domain;
      listener = await ngrok.forward(options);
      publicBase = String(listener.url() || '').replace(/\/+$/, '');
      log('ngrok', { message: 'ngrok tunnel is online.', url: publicBase });
    }

    const state = () => ({
      running: !stopping,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      publicUrl: publicBase ? `${publicBase}/mcp` : '',
      healthUrl: publicBase ? `${publicBase}/health` : `http://127.0.0.1:${port}/health`,
      mysqlHost: settings.mysql?.host || '',
      mysqlDatabase: settings.mysql?.database || '',
      mysqlVersion: serverVersion?.raw || '',
      mysqlVendor: serverVersion?.vendorLabel || '',
      accessMode: settings.mcp?.accessMode || 'read',
      tlsMode,
      collation: collationKey,
      capabilities,
      compatibilityWarnings: compatibilityWarnings(serverVersion, capabilities)
    });

    hooks.onStatus?.(state());
    log('status', { message: 'MCP server started.', ...state() });

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
        log('status', { message: 'Bridge stopped.' });
      }
    };
  } catch (err) {
    await cleanupStartup();
    log('error', { message: `Startup failed: ${err?.message || String(err)}` });
    throw err;
  }
}

/**
 * The MCP endpoint can be published publicly through a tunnel, so the Host and
 * Origin headers are pinned to the local interface plus the live tunnel domain.
 */
function buildAllowedHosts(settings, publicBase) {
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const extra of settings.mcp?.allowedHosts || []) {
    if (extra) hosts.add(String(extra));
  }
  if (publicBase) {
    try { hosts.add(new URL(publicBase).host); } catch { /* ignore malformed tunnel url */ }
  }
  return [...hosts];
}

function buildAllowedOrigins(settings, publicBase) {
  const origins = new Set(['http://127.0.0.1', 'http://localhost']);
  for (const extra of settings.mcp?.allowedOrigins || []) {
    if (extra) origins.add(String(extra));
  }
  if (publicBase) origins.add(publicBase);
  return [...origins];
}

export async function runLocalSql(settings, sql) {
  let pool = null;
  try {
    // Inside the try so a rejected statement returns the same shape as a failed one.
    const info = validateFreeSql(settings, sql);
    const connected = await connectWithFallback(settings);
    pool = connected.pool;
    await openSession(pool, settings);
    const [rows] = await queryWithTimeout(pool, sql, [], settings.mcp?.queryTimeoutMs || 30000);
    return {
      ok: true,
      kind: info.kind,
      server: describeVersion(connected.version),
      result: Array.isArray(rows)
        ? { count: rows.length, rows }
        : { affectedRows: rows.affectedRows, changedRows: rows.changedRows, insertId: rows.insertId }
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
