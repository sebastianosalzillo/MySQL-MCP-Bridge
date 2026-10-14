import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mcpAllowedConnections } from '../server/mcpSecurity.mjs';
import { startMultiBridge } from '../server/multiBridge.mjs';

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'opencode-compat-test', version: '1.0' }
  }
});

test('allowlist includes exact Host-with-port without trusting unrelated hosts', () => {
  const { allowedHosts, allowedOrigins } = mcpAllowedConnections({ port: 3001 });
  assert.ok(allowedHosts.includes('127.0.0.1:3001'));
  assert.ok(allowedHosts.includes('localhost:3001'));
  assert.ok(allowedHosts.includes('[::1]:3001'));
  assert.ok(allowedOrigins.includes('http://127.0.0.1:3001'));
  assert.ok(!allowedHosts.includes('*'));
  assert.ok(!allowedOrigins.includes('*'));
  assert.ok(!allowedHosts.includes('evil.example'));
  assert.throws(() => mcpAllowedConnections({ port: 0 }), /Invalid/);
  const withTunnel = mcpAllowedConnections({ port: 3001, publicBase: 'https://company.ngrok.app' });
  assert.ok(withTunnel.allowedHosts.includes('company.ngrok.app'));
  assert.ok(withTunnel.allowedOrigins.includes('https://company.ngrok.app'));
});

test('actual streamable HTTP POST handshake accepts local Host with port and rejects invalid auth and DNS rebinding', async t => {
  const port = await freePort();
  const token = 'mcp-test-token-not-secret';
  const settings = {
    sources: [{
      id: 'testdb', name: 'Test read-only database', type: 'mysql',
      mysql: { host: '127.0.0.1', port: 3306, database: 'test', user: 'readonly' }
    }],
    mcp: { port, bearerToken: token, accessMode: 'read', jsonResponses: true },
    ngrok: { enabled: false }
  };
  const controller = await startMultiBridge(settings);
  t.after(async () => { await controller.stop(); });
  const url = 'http://127.0.0.1:' + port + '/mcp';
  const options = (headers = {}) => ({
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers
    },
    body: initialize
  });
  const ok = await fetch(url, options());
  assert.equal(ok.status, 200, 'Streamable HTTP POST handshake should not return 403');
  const data = await ok.json();
  assert.equal(data.jsonrpc, '2.0');
  assert.equal(data.result.serverInfo.name, 'database-mcp-bridge');

  const withoutToken = await fetch(url, options({ Authorization: 'Bearer not-the-token' }));
  assert.equal(withoutToken.status, 401);

  const invalidHost = await fetch(url, options({ Host: 'evil.example:3001' }));
  assert.equal(invalidHost.status, 403, 'DNS rebinding protection must remain enabled');

  const invalidOrigin = await fetch(url, options({ Origin: 'https://evil.example' }));
  assert.equal(invalidOrigin.status, 403, 'cross-site Origin requests must remain blocked');

  // A stateless MCP server may legitimately decline optional GET/SSE;
  // clients must use its successful POST/JSON transport.
  const get = await fetch(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }
  });
  assert.equal(get.status, 405);
});
