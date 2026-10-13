import fs from 'node:fs';
import path from 'node:path';

const ENV_REFERENCE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** Resolve environment references at runtime. Never commit credentials. */
export function resolveEnvValues(value, env = process.env) {
  if (Array.isArray(value)) return value.map(item => resolveEnvValues(item, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvValues(item, env)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(ENV_REFERENCE, (_match, name) => {
    if (!Object.hasOwn(env, name) || env[name] === '') {
      throw new Error(`Required environment variable ${name} is missing or empty.`);
    }
    return env[name];
  });
}

export function validateStandaloneSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Standalone configuration must be a JSON object.');
  }
  const sources = settings.sources;
  const multi = Array.isArray(sources) && sources.length > 0;
  if (multi) {
    const ids = new Set();
    for (const source of sources) {
      if (!source || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(source.id || '')) {
        throw new Error('Each source needs an id of 1-64 letters, digits, hyphens or underscores.');
      }
      if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
      ids.add(source.id);
      if (!['mysql', 'access'].includes(source.type)) {
        throw new Error(`Unsupported database type for ${source.id}`);
      }
      if (source.type === 'mysql' && (!source.mysql?.user || !source.mysql?.database)) {
        throw new Error(`MySQL source ${source.id} requires mysql.user and mysql.database.`);
      }
      if (source.type === 'access' && !/\.((mdb)|(accdb))$/i.test(source.file || '')) {
        throw new Error(`Access source ${source.id} needs a .mdb or .accdb file.`);
      }
      if (source.allowedTables && (!Array.isArray(source.allowedTables) ||
           !source.allowedTables.every(t => typeof t === 'string' && t.length > 0))) {
        throw new Error(`Invalid table whitelist for ${source.id}`);
      }
    }
  } else if (!settings.mysql || typeof settings.mysql !== 'object' || !settings.mysql.user) {
    throw new Error('A MySQL connection with a dedicated read-only user is required.');
  }
  if (settings.mcp?.accessMode !== 'read') {
    throw new Error('Standalone mode currently requires mcp.accessMode = "read".');
  }
  if (settings.mcp.blockMultipleStatements === false || settings.mcp.blockFileAccess === false || settings.mcp.allowSlowFunctions === true) {
    throw new Error('Unsafe SQL guardrail settings are not permitted in standalone mode.');
  }
  if (settings.ngrok?.enabled && !settings.mcp.bearerToken) {
    throw new Error('A non-empty mcp.bearerToken is required when ngrok is enabled.');
  }
  if (settings.automation?.enabled) {
    const ai = settings.automation;
    if (!ai.stateDir || typeof ai.stateDir !== 'string') {
      throw new Error('automation.stateDir must be a writable directory.');
    }
    if (!ai.adminToken || String(ai.adminToken).length < 24) {
      throw new Error('automation.adminToken must contain at least 24 characters.');
    }
    const adminPort = Number(ai.adminPort || 3002);
    if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535 ||
        adminPort === Number(settings.mcp.port || 3001)) {
      throw new Error('automation.adminPort must be valid and different from the MCP port.');
    }
  }
  const port = Number(settings.mcp.port || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('mcp.port must be an integer from 1 to 65535.');
  }
  return {
    ...settings,
    ...(multi
      ? { sources: sources.map(source => source.type === 'mysql'
          ? { ...source, mysql: { ...source.mysql, allowTlsFallback: source.mysql.allowTlsFallback === true } }
          : { ...source }) }
      : { mysql: { ...settings.mysql, allowTlsFallback: settings.mysql.allowTlsFallback === true } }),
    mcp: {
      ...settings.mcp,
      accessMode: 'read',
      blockMultipleStatements: true,
      blockFileAccess: true,
      allowSlowFunctions: false,
      enableExecuteSql: false
    },
    ngrok: { enabled: false, ...settings.ngrok }
  };
}

export function loadStandaloneSettings(filename, env = process.env) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Specify a configuration file using --config or MCP_BRIDGE_CONFIG.');
  }
  const absolutePath = path.resolve(filename);
  let source;
  try {
    source = fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`Cannot read standalone configuration at ${absolutePath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in standalone configuration: ${error.message}`);
  }
  return validateStandaloneSettings(resolveEnvValues(parsed, env));
}

export function configurationPath(args = process.argv.slice(2), env = process.env) {
  let specified;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--config requires a file path.');
      }
      specified = args[++i];
    } else if (arg.startsWith('--config=')) {
      specified = arg.slice('--config='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return specified || env.MCP_BRIDGE_CONFIG || '';
}
