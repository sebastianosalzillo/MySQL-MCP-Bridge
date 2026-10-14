import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutomationManager, validateJob, dueKey, localSchedule } from '../server/automation/manager.mjs';
import { buildAiCommand, configureWorkspaces, workspaceFiles } from '../server/automation/providers.mjs';
import { validateStandaloneSettings } from '../server/standaloneConfig.mjs';

function temp(action) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-ai-'));
  return Promise.resolve().then(() => action(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const sample = stateDir => ({ stateDir, mcpPort: 3001, timeZone: 'Europe/Rome' });

test('each job chooses AI provider and independently enables or disables instructions', () => {
  for (const provider of ['opencode', 'claude', 'codex']) {
    const job = validateJob({
      name: 'Stock summary', prompt: 'Analyze low stock', provider,
      includeInstructions: false, enabled: true, at: '08:00', frequency: 'daily'
    });
    assert.equal(job.provider, provider);
    assert.equal(job.includeInstructions, false);
    assert.equal(validateJob({ ...job, includeInstructions: true }, job).includeInstructions, true);
  }
  assert.equal(validateJob({ name: 'Default', prompt: 'Analyze' }).includeInstructions, true);
  assert.throws(() => validateJob({ name: 'Unknown', prompt: 'Analyze', provider: 'shell' }), /Provider/);
});

test('workspaces with and without managed project instructions are isolated', async () => {
  await temp(async dir => {
    const options = sample(dir);
    const workspaces = configureWorkspaces(options, 'Regole condivise in italiano.');
    assert.equal(workspaces.length, 2);
    const enabled = workspaceFiles(options, true);
    const disabled = workspaceFiles(options, false);
    assert.notEqual(enabled.workspace, disabled.workspace);
    assert.match(fs.readFileSync(enabled.agents, 'utf8'), /Regole condivise/);
    assert.match(fs.readFileSync(enabled.claude, 'utf8'), /Regole condivise/);
    assert.equal(fs.existsSync(disabled.agents), false);
    assert.equal(fs.existsSync(disabled.claude), false);
    assert.equal(JSON.parse(fs.readFileSync(disabled.claudeMcp, 'utf8')).mcpServers.database_bridge.type, 'http');
    const codexConfig = fs.readFileSync(disabled.codex, 'utf8');
    assert.match(codexConfig, /bearer_token_env_var/);
    const config = JSON.parse(fs.readFileSync(enabled.opencode, 'utf8'));
    assert.equal(config.mcp.database_bridge.type, 'remote');
    assert.ok(!JSON.stringify(config).includes('plain-secret'));
    configureWorkspaces(options, 'Nuove regole.');
    assert.match(fs.readFileSync(enabled.agents, 'utf8'), /Nuove regole/);
    assert.equal(fs.existsSync(disabled.agents), false);
  });
});

test('providers use distinct workspaces and safe non-interactive CLI commands', async () => {
  await temp(async dir => {
    const options = sample(dir);
    for (const provider of ['opencode', 'claude', 'codex']) {
      for (const includeInstructions of [true, false]) {
        const cmd = buildAiCommand({ prompt: 'Analizza dati', provider, includeInstructions }, options);
        assert.equal(cmd.provider, provider);
        assert.equal(cmd.cwd, workspaceFiles(options, includeInstructions).workspace);
        assert.equal(cmd.includeInstructions, includeInstructions);
        assert.equal(cmd.args.at(-1), 'Analizza dati');
        if (provider === 'codex') assert.ok(cmd.args.includes('read-only'));
        if (provider === 'claude') assert.ok(cmd.args.includes('dontAsk'));
      }
    }
    assert.throws(() => buildAiCommand({ prompt: 'bad', provider: 'bash' }, options), /Unsupported/);
  });
});

test('schedule respects the Europe/Rome wall clock and a selected weekday', () => {
  const zone = 'Europe/Rome';
  const time = localSchedule(new Date('2026-10-14T06:00:00Z'), zone);
  assert.equal(time.time, '08:00');
  const daily = validateJob({ name: 'Report', prompt: 'Summarize', frequency: 'daily', at: '08:00' });
  assert.equal(dueKey(daily, time), '2026-10-14');
  assert.equal(dueKey({ ...daily, frequency: 'weekly', weekday: time.weekday }, time), '2026-10-14');
  assert.equal(dueKey({ ...daily, frequency: 'weekly', weekday: (time.weekday + 1) % 7 }, time), null);
});

test('scheduler persists prompts and runs selected provider without requiring the shared instructions', async () => {
  await temp(async dir => {
    const executed = [];
    const moment = () => new Date('2026-10-14T06:00:00Z');
    const options = sample(dir);
    const manager = createAutomationManager(options, {
      now: moment,
      run: async job => {
        executed.push({ provider: job.provider, includeInstructions: job.includeInstructions });
        return { output: 'Analisi completata' };
      }
    });
    manager.setInstructions('Le istruzioni aziendali condivise.');
    const job = manager.upsertJob({
      name: 'Report', prompt: 'Confronta vendite', provider: 'codex',
      includeInstructions: false, enabled: true, at: '08:00', frequency: 'daily'
    });
    const result = await manager.runNow(job.id);
    assert.equal(result.status, 'success');
    assert.deepEqual(executed, [{ provider: 'codex', includeInstructions: false }]);
    assert.equal(fs.readFileSync(result.report, 'utf8'), 'Analisi completata');
    assert.equal(manager.listHistory().length, 1);
    await manager.stop();

    const again = createAutomationManager(options, { now: moment, run: async () => ({ output: 'ok' }) });
    assert.equal(again.listJobs()[0].includeInstructions, false);
    assert.equal(again.listJobs()[0].provider, 'codex');
    assert.match(again.getInstructions().instructions, /condivise/);
    await again.stop();
  });
});

test('optional automation refuses short tokens and port conflicts', () => {
  const cfg = {
    mysql: { user: 'ro' }, mcp: { port: 3001, accessMode: 'read' },
    ngrok: { enabled: false },
    automation: { enabled: true, stateDir: 'C:\\Bridge\\automation',
      adminToken: 'short', adminPort: 3002 }
  };
  assert.throws(() => validateStandaloneSettings(cfg), /adminToken/);
  cfg.automation.adminToken = 'x'.repeat(32);
  cfg.automation.adminPort = 3001;
  assert.throws(() => validateStandaloneSettings(cfg), /different/);
  cfg.automation.adminPort = 3002;
  assert.equal(validateStandaloneSettings(cfg).automation.enabled, true);
});
