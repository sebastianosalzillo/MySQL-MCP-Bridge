import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { configurationPath, loadStandaloneSettings, resolveEnvValues, validateStandaloneSettings } from '../server/standaloneConfig.mjs';
import { runStandalone } from '../server/standalone.mjs';

const sample = () => ({
  mysql: { user: 'mcp_ro', password: '${MCP_MYSQL_PASSWORD}', allowTlsFallback: false },
  mcp: { accessMode: 'read', port: 3001, bearerToken: '${MCP_BEARER_TOKEN}' },
  ngrok: { enabled: false }
});
const vars = { MCP_MYSQL_PASSWORD: 'test-secret', MCP_BEARER_TOKEN: 'test-bearer' };

function withConfig(config, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-standalone-'));
  const file = path.join(directory, 'standalone.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return Promise.resolve().then(() => fn(file)).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('standalone configuration resolves external environment references without logging secrets', async () => {
  await withConfig(sample(), file => {
    const s = loadStandaloneSettings(file, vars);
    assert.equal(s.mysql.password, 'test-secret');
    assert.equal(s.mcp.bearerToken, 'test-bearer');
    assert.equal(s.mcp.accessMode, 'read');
    assert.equal(s.mcp.blockFileAccess, true);
    assert.equal(s.mcp.blockMultipleStatements, true);
    assert.equal(s.mcp.allowSlowFunctions, false);
    assert.equal(s.mcp.enableExecuteSql, false);
  });
});

test('unresolved environment variables fail closed', () => {
  assert.throws(() => resolveEnvValues(sample(), {}), /MCP_MYSQL_PASSWORD/);
});

test('refuses write mode, disabled guards and anonymous remote tunnels', () => {
  assert.throws(() => validateStandaloneSettings({ ...sample(), mcp: { accessMode: 'write' } }), /requires.*read/);
  assert.throws(() => validateStandaloneSettings({ ...sample(), mcp: { accessMode: 'read', blockFileAccess: false } }), /Unsafe SQL/);
  assert.throws(() => validateStandaloneSettings({ ...sample(), mcp: { accessMode: 'read', blockMultipleStatements: false } }), /Unsafe SQL/);
  assert.throws(() => validateStandaloneSettings({ ...sample(), mcp: { accessMode: 'read', allowSlowFunctions: true } }), /Unsafe SQL/);
  assert.throws(() => validateStandaloneSettings({ ...sample(), mcp: { accessMode: 'read' }, ngrok: { enabled: true } }), /bearerToken/);
});

test('explicit CLI config has precedence over environment path', () => {
  assert.equal(configurationPath(['--config', './here.json'], { MCP_BRIDGE_CONFIG: 'env.json' }), './here.json');
  assert.equal(configurationPath([], { MCP_BRIDGE_CONFIG: 'env.json' }), 'env.json');
  assert.throws(() => configurationPath(['--config'], {}), /requires/);
  assert.throws(() => configurationPath(['--random'], {}), /Unknown/);
});

test('runStandalone starts existing engine and terminates it on SIGTERM', async () => {
  await withConfig(sample(), async file => {
    const fakeProcess = new EventEmitter();
    const logs = [];
    const stops = [];
    let receivedSettings;
    const service = await runStandalone({
      args: ['--config', file], env: vars, processRef: fakeProcess,
      log: line => logs.push(line),
      start: async (settings, hooks) => {
        receivedSettings = settings;
        hooks.onLog({ type: 'status', data: { message: 'Started' } });
        return { stop: async () => { stops.push('stop'); } };
      }
    });
    assert.equal(receivedSettings.mcp.accessMode, 'read');
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 1);
    await service.shutdown('SIGTERM');
    assert.deepEqual(stops, ['stop']);
    assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
    assert.doesNotMatch(logs.join(' '), /test-secret|test-bearer/);
  });
});
