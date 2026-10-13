import http from 'node:http';
import express from 'express';
import ngrok from '@ngrok/ngrok';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSourceRegistry } from './sourceRegistry.mjs';
import { registerMultiTools } from './multiTools.mjs';

const SERVER_INFO = { name: 'database-mcp-bridge', version: '0.2.0' };
const localClient = request => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress);

export async function startMultiBridge(settings, hooks = {}) {
  const registry = createSourceRegistry(settings);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));
  let listener = null;
  let httpServer = null;
  let active = true;
  let externalUrl = '';
  const port = Number(settings.mcp.port || 3001);
  const token = settings.mcp.bearerToken || '';
  const emit = (type, data) => hooks.onLog?.({ time: new Date().toISOString(), type, data });

  app.get('/health', (req, res) => res.json(localClient(req)
    ? { ok: active, service: SERVER_INFO.name, sources: registry.listSources() }
    : { ok: active, service: SERVER_INFO.name }));

  app.post('/mcp', async (req, res) => {
    if (token && req.get('authorization') !== 'Bearer ' + token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const hosts = ['127.0.0.1', 'localhost', '[::1]'];
    const origins = ['http://127.0.0.1', 'http://localhost'];
    if (externalUrl) {
      hosts.push(new URL(externalUrl).host);
      origins.push(externalUrl);
    }
    const server = new McpServer(SERVER_INFO);
    registerMultiTools(server, registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: settings.mcp.jsonResponses !== false,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: origins
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void Promise.resolve(transport.close()).catch(() => {});
        void Promise.resolve(server.close()).catch(() => {});
      });
    } catch (error) {
      emit('error', { message: error.message });
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Use MCP POST requests.' }));

  const stop = async () => {
    if (!active) return;
    active = false;
    if (listener) {
      await listener.close().catch(() => {});
      await ngrok.disconnect().catch(() => {});
      listener = null;
    }
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await registry.close();
    emit('status', { message: 'Multi-source MCP stopped' });
  };

  try {
    httpServer = http.createServer(app);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', resolve);
    });
    if (settings.ngrok?.enabled) {
      if (!token) throw new Error('A bearer token is mandatory when ngrok is enabled.');
      const ngrokOptions = {
        addr: '127.0.0.1:' + port,
        authtoken: settings.ngrok.authtoken
      };
      if (settings.ngrok.domain) {
        ngrokOptions.domain = String(settings.ngrok.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
      }
      listener = await ngrok.forward(ngrokOptions);
      externalUrl = String(listener.url() || '').replace(/\/+$/, '');
    }
    const status = () => ({
      running: active, accessMode: 'read', sources: registry.listSources(),
      mcpUrl: 'http://127.0.0.1:' + port + '/mcp',
      healthUrl: 'http://127.0.0.1:' + port + '/health',
      publicUrl: externalUrl ? externalUrl + '/mcp' : ''
    });
    hooks.onStatus?.(status());
    emit('status', { message: 'Multi-source MCP started.', sourceCount: settings.sources.length });
    return {
      status,
      stop,
      // Multi-source mode never offers approvals or writing operations.
      listApprovals: () => [],
      decideApproval: () => false
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
