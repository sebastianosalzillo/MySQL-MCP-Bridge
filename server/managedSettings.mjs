import { validateStandaloneSettings } from './standaloneConfig.mjs';

/**
 * Build the runtime configuration for an Electron-managed read-only server.
 * Passwords and tokens are supplied in memory, never written to standalone.json.
 */
export function managedStandaloneSettings(exported, stored, adminToken, stateDir) {
  if (!stored?.mcp?.bearerToken) throw new Error('Set a fixed MCP Bearer Token first.');
  if (!adminToken || adminToken.length < 24) throw new Error('Missing protected AI admin token.');
  const byId = new Map((stored.sources || []).map(source => [source.id, source]));
  const sources = exported.sources.map(source => {
    if (source.type !== 'mysql') return source;
    const pass = byId.get(source.id)?.password;
    if (!pass) throw new Error('Save the MySQL password for source ' + source.id + '.');
    return { ...source, mysql: { ...source.mysql, password: pass } };
  });
  return validateStandaloneSettings({
    ...exported,
    sources,
    mcp: { ...exported.mcp, bearerToken: stored.mcp.bearerToken,
      lan: { enabled: stored.mcp?.lan?.enabled === true, host: stored.mcp?.lan?.host || '' } },
    automation: { ...exported.automation, adminToken, stateDir },
    ngrok: { enabled: false }
  });
}
