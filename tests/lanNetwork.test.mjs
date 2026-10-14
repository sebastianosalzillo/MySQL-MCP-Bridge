import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { availableLanInterfaces, selectedLanInterface, isLanPeerAllowed } from '../server/lanNetwork.mjs';
import { validateStandaloneSettings } from '../server/standaloneConfig.mjs';
import { startMultiBridge } from '../server/multiBridge.mjs';

const interfaces = {
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true, netmask: '255.0.0.0' }],
  Private: [{ family: 'IPv4', address: '192.168.40.21', internal: false, netmask: '255.255.255.0' }],
  Office: [{ family: 'IPv4', address: '10.7.4.8', internal: false, netmask: '255.255.0.0' }],
  Public: [{ family: 'IPv4', address: '8.8.4.4', internal: false, netmask: '255.255.255.0' }],
  Carrier: [{ family: 'IPv4', address: '100.64.4.4', internal: false, netmask: '255.255.255.0' }],
  IPv6: [{ family: 'IPv6', address: 'fd00::123', internal: false, netmask: 'ffff:ffff:ffff:ffff::' }]
};

test('LAN is disabled by default and only private non-loopback IPv4 adapters are offered', () => {
  const available = availableLanInterfaces(interfaces);
  assert.deepEqual(available.map(i => i.address).sort(), ['10.7.4.8', '192.168.40.21']);
  assert.equal(selectedLanInterface({}, interfaces), null);
  assert.equal(selectedLanInterface({ enabled: false, host: '192.168.40.21' }, interfaces), null);
  assert.equal(selectedLanInterface({ enabled: true, host: '192.168.40.21' }, interfaces).name, 'Private');
  assert.throws(() => selectedLanInterface({ enabled: true, host: '8.8.4.4' }, interfaces), /private IPv4/);
  assert.throws(() => selectedLanInterface({ enabled: true, host: '127.0.0.1' }, interfaces), /private IPv4/);
  assert.throws(() => selectedLanInterface({ enabled: true, host: '192.168.40.99' }, interfaces), /private IPv4/);
});

test('LAN blocks clients outside the selected interface subnet', () => {
  const selected = selectedLanInterface({ enabled: true, host: '192.168.40.21' }, interfaces);
  assert.equal(isLanPeerAllowed('127.0.0.1', selected), true);
  assert.equal(isLanPeerAllowed('::ffff:127.0.0.1', selected), true);
  assert.equal(isLanPeerAllowed('192.168.40.88', selected), true);
  assert.equal(isLanPeerAllowed('::ffff:192.168.40.88', selected), true);
  assert.equal(isLanPeerAllowed('192.168.41.88', selected), false);
  assert.equal(isLanPeerAllowed('10.7.4.8', selected), false);
  assert.equal(isLanPeerAllowed('8.8.8.8', selected), false);
  assert.equal(isLanPeerAllowed('::1', selected), true);
  assert.equal(isLanPeerAllowed('192.168.40.21', null), false);
});

test('standalone rejects LAN exposure without a sufficiently strong token and valid adapter', () => {
  const data = {
    sources: [{
      id: 'docs', type: 'filesystem', rootPath: process.cwd()
    }],
    mcp: { port: 3001, accessMode: 'read', lan: { enabled: true, host: '8.8.8.8' } },
    ngrok: { enabled: false }
  };
  assert.throws(() => validateStandaloneSettings(data), /Bearer Token/);
  assert.throws(() => validateStandaloneSettings({
    ...data, mcp: { ...data.mcp, bearerToken: 'short' }
  }), /Bearer Token/);
  assert.throws(() => validateStandaloneSettings({
    ...data, mcp: { ...data.mcp, bearerToken: 'sufficiently-long-bearer-token-for-local-network' }
  }), /private IPv4/);
  const disabled = validateStandaloneSettings({
    ...data, mcp: { ...data.mcp, lan: { enabled: false, host: '' } }
  });
  assert.deepEqual(disabled.mcp.lan, { enabled: false, host: '' });
  assert.equal(disabled.mcp.accessMode, 'read');
});

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

test('real LAN listener works with bearer and strict Host/Origin, while local endpoint remains available', async t => {
  const nic = availableLanInterfaces()[0];
  if (!nic) {
    t.skip('No eligible private IPv4 network interface is present on the CI runner.');
    return;
  }
  const port = await freePort();
  const token = 'temporary-lan-integration-token-with-more-than-24-chars';
  const controller = await startMultiBridge({
    sources: [{ id: 'files', name: 'Authorized files', type: 'filesystem', rootPath: process.cwd() }],
    mcp: { port, bearerToken: token, accessMode: 'read',
      lan: { enabled: true, host: nic.address }, jsonResponses: true },
    ngrok: { enabled: false }
  });
  t.after(() => controller.stop());
  assert.equal(controller.status().lanEnabled, true);
  assert.equal(controller.status().lanUrl, 'http://' + nic.address + ':' + port + '/mcp');
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'lan-test', version: '1.0.0' }
    }
  });
  const options = (tokenValue, headers = {}) => ({
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + tokenValue,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers
    },
    body: payload
  });
  const lanUrl = controller.status().lanUrl;
  const denied = await fetch(lanUrl, options('incorrect'));
  assert.equal(denied.status, 401);
  const ok = await fetch(lanUrl, options(token));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.serverInfo.name, 'database-mcp-bridge');
  const maliciousOrigin = await fetch(lanUrl, options(token, { Origin: 'http://evil.example' }));
  assert.equal(maliciousOrigin.status, 403);
  const remoteHealth = await fetch('http://' + nic.address + ':' + port + '/health');
  assert.equal(remoteHealth.status, 404, 'Only loopback clients should see source health details.');
  const localUrl = controller.status().mcpUrl;
  const local = await fetch(localUrl, options(token));
  assert.equal(local.status, 200);
  const localHealth = await fetch('http://127.0.0.1:' + port + '/health');
  assert.equal(localHealth.status, 200);
});
