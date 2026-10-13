import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationPath, loadStandaloneSettings } from './standaloneConfig.mjs';

/** Run the current MCP engine in Node.js, without Electron. */
export async function runStandalone({ args = process.argv.slice(2), env = process.env, log = console.log, error = console.error, processRef = process, start = null } = {}) {
  const filename = configurationPath(args, env);
  const settings = loadStandaloneSettings(filename, env);
  const startEngine = start || (await import('./mcpBridge.mjs')).startBridge;
  const controller = await startEngine(settings, {
    onLog: entry => log(JSON.stringify(entry)),
    onStatus: status => log(JSON.stringify({ type: 'bridge:status', status })),
    onApproval: item => log(JSON.stringify({ type: 'bridge:approval', id: item.id, status: item.status }))
  });
  let automation = null;
  let adminApi = null;
  try {
    if (settings.automation?.enabled) {
      const [{ createAutomationManager }, { startAutomationApi }] = await Promise.all([
        import('./automation/manager.mjs'), import('./automation/api.mjs')
      ]);
      const options = { ...settings.automation, mcpPort: settings.mcp.port || 3001 };
      automation = createAutomationManager(options);
      adminApi = await startAutomationApi(automation, options);
      automation.start();
      log(JSON.stringify({ type: 'ai:scheduler', enabled: true, adminPort: adminApi.port }));
    }
  } catch (error) {
    if (adminApi) await adminApi.stop().catch(() => {});
    if (automation) await automation.stop().catch(() => {});
    await controller.stop().catch(() => {});
    throw error;
  }
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    try {
      if (automation) await automation.stop();
      if (adminApi) await adminApi.stop();
      await controller.stop();
      log(JSON.stringify({ type: 'bridge:shutdown', signal }));
    } catch (err) {
      error(`MCP shutdown failed: ${err.message}`);
      processRef.exitCode = 1;
    } finally {
      processRef.off('SIGINT', onSigint);
      processRef.off('SIGTERM', onSigterm);
    }
  };
  const onSigint = () => { void shutdown('SIGINT'); };
  const onSigterm = () => { void shutdown('SIGTERM'); };
  processRef.on('SIGINT', onSigint);
  processRef.on('SIGTERM', onSigterm);
  return { controller, shutdown };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runStandalone().catch(err => {
    // Never print settings, passwords or bearer tokens.
    console.error(`MCP bridge did not start: ${err.message}`);
    process.exitCode = 1;
  });
}
