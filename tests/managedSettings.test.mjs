import test from 'node:test';
import assert from 'node:assert/strict';
import { managedStandaloneSettings } from '../server/managedSettings.mjs';
import { runStandalone } from '../server/standalone.mjs';

const exported = {
  sources: [
    { id: 'shop', type: 'mysql', mysql: { host: '127.0.0.1', database: 'test', user: 'readonly', password: '${MCP_SHOP_PASSWORD}' } },
    { id: 'legacy', type: 'access', file: 'C:\\temp\\legacy.mdb' }
  ],
  mcp: { port: 3001, accessMode: 'read', bearerToken: '${MCP_BEARER_TOKEN}' },
  automation: { enabled: false, adminToken: '${MCP_AI_ADMIN_TOKEN}' },
  ngrok: { enabled: false }
};
const stored = {
  sources: [{ id: 'shop', password: 'persistent-mysql-secret' }],
  mcp: { bearerToken: 'persistent-fixed-bearer' }
};
test('Electron-managed settings substitute secrets in memory, preserving read-only protection', () => {
  const s = managedStandaloneSettings(exported, stored, 'persistent-admin-token-with-32-characters', './ai');
  assert.equal(s.sources[0].mysql.password, 'persistent-mysql-secret');
  assert.equal(s.mcp.bearerToken, 'persistent-fixed-bearer');
  assert.equal(s.sources[1].type, 'access');
  assert.equal(s.ngrok.enabled, false);
  assert.equal(s.mcp.accessMode, 'read');
  assert.equal(s.mcp.enableExecuteSql, false);
  assert.equal(exported.sources[0].mysql.password, '${MCP_SHOP_PASSWORD}');
});
test('managed mode rejects missing MySQL password or bearer', () => {
  assert.throws(() => managedStandaloneSettings(exported, { ...stored, sources: [] },
    'persistent-admin-token-with-32-characters', './ai'), /password for source/);
  assert.throws(() => managedStandaloneSettings(exported, { ...stored, mcp: { bearerToken: '' } },
    'persistent-admin-token-with-32-characters', './ai'), /Bearer Token/);
});
test('embedded standalone runner uses runtime settings rather than CLI or environment', async () => {
  const runtime = managedStandaloneSettings(exported, stored, 'persistent-admin-token-with-32-characters', './ai');
  const events = new Map();
  let stopped = false;
  const processRef = {
    on: (event, listener) => events.set(event, listener),
    off: event => events.delete(event),
    exitCode: 0
  };
  const instance = await runStandalone({
    loadedSettings: runtime, args: ['--definitely-invalid'], env: {},
    processRef, log: () => {},
    start: async config => {
      assert.equal(config.sources[0].mysql.password, 'persistent-mysql-secret');
      return { stop: async () => { stopped = true; } };
    }
  });
  assert.ok(events.has('SIGINT'));
  await instance.shutdown('GUI stop');
  assert.equal(stopped, true);
  assert.equal(events.size, 0);
});
