import http from 'node:http';
import express from 'express';
import ngrok from '@ngrok/ngrok';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSourceRegistry } from './sourceRegistry.mjs';
import { registerMultiTools } from './multiTools.mjs';
import { mcpAllowedConnections, validMcpRequestHeaders } from './mcpSecurity.mjs';
import { selectedLanInterface, isLanPeerAllowed } from './lanNetwork.mjs';

const SERVER_INFO = { name: 'database-mcp-bridge', version: '0.2.0' };
const localClient = request => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress);

export async function startMultiBridge(settings, hooks = {}) {
  const registry = createSourceRegistry(settings);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));
  let listener = null;
  const httpServers = [];
  let active = true;
  let externalUrl = '';
  const port = Number(settings.mcp.port || 3001);
  const token = settings.mcp.bearerToken || '';
  const lanInterface = selectedLanInterface(settings.mcp.lan);
  if (lanInterface && token.length < 24) {
    throw new Error('LAN access requires a fixed Bearer Token of at least 24 characters.');
  }
  const allowedConnections = () => mcpAllowedConnections({
    port, publicBase: externalUrl,
    hosts: lanInterface ? [lanInterface.address, lanInterface.address + ':' + port] : []
  });
  const emit = (type, data) => hooks.onLog?.({ time: new Date().toISOString(), type, data });

  // Apply strict source-subnet and Host/Origin checks to ALL routes, not only POST.
  app.use((req, res, next) => {
    if (!isLanPeerAllowed(req.socket?.remoteAddress, lanInterface)) {
      return res.status(403).json({ error: 'This client is not on the permitted local subnet.' });
    }
    if (!validMcpRequestHeaders(req, allowedConnections())) {
      return res.status(403).json({ error: 'Forbidden: invalid Host or Origin header.' });
    }
    next();
  });

  app.get('/health', (req, res) => {
    if (!localClient(req)) return res.status(404).end();
    return res.json({ ok: active, service: SERVER_INFO.name, sources: registry.listSources() });
  });

  app.post('/mcp', async (req, res) => {
    if (token && req.get('authorization') !== 'Bearer ' + token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { allowedHosts, allowedOrigins } = allowedConnections();
    const server = new McpServer(SERVER_INFO);
    registerMultiTools(server, registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: settings.mcp.jsonResponses !== false,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins
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
  app.all('/mcp', (req, res) => {
    if (token && req.get('authorization') !== 'Bearer ' + token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.set('Allow', 'POST');
    return res.status(405).json({ error: 'Use MCP POST requests.' });
  });

  const stop = async () => {
    if (!active) return;
    active = false;
    if (listener) {
      await listener.close().catch(() => {});
      await ngrok.disconnect().catch(() => {});
      listener = null;
    }
    await Promise.allSettled(httpServers.map(server => new Promise(resolve => server.close(resolve))));
    await registry.close();
    emit('status', { message: 'Multi-source MCP stopped' });
  };

  try {
    const listen = async address => {
      const httpServer = http.createServer(app);
      httpServers.push(httpServer);
      await new Promise((resolve, reject) => {
        const onError = error => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, address);
      });
    };
    // Two explicit listeners: local clients keep using 127.0.0.1, and only
    // the selected private network adapter is reachable from other machines.
    await listen('127.0.0.1');
    if (lanInterface) await listen(lanInterface.address);
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
      publicUrl: externalUrl ? externalUrl + '/mcp' : '',
      lanEnabled: Boolean(lanInterface),
      lanUrl: lanInterface ? 'http://' + lanInterface.address + ':' + port + '/mcp' : '',
      lanAddress: lanInterface?.address || ''
    });
    hooks.onStatus?.(status());
    emit('status', { message: 'Multi-source MCP started.', sourceCount: settings.sources.length,
      lanEnabled: Boolean(lanInterface), lanAddress: lanInterface?.address || '' });
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
