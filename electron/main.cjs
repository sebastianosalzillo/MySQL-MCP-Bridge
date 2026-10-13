const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let bridgeModule;
let bridgeController;

const defaultSettings = {
  mysql: {
    host: '127.0.0.1',
    port: 3306,
    database: '',
    user: '',
    password: '',
    // Local Windows services often listen on a named pipe instead of TCP.
    socketPath: '',
    // utf8mb4 (utf8mb4_general_ci) is the widest collation that exists on every
    // supported server. utf8mb4_0900_ai_ci is rejected by MySQL before 8.0.
    collation: 'utf8mb4',
    // off | required | verify-ca | verify-full
    tlsMode: 'off',
    caFile: '',
    certFile: '',
    keyFile: '',
    minTlsVersion: '',
    ciphers: '',
    serverPublicKey: '',
    authPlugin: 'auto',
    allowTlsFallback: true,
    sessionTimeZone: '+00:00',
    sqlMode: '',
    groupConcatMaxLen: 0,
    connectTimeoutMs: 10000
  },
  mcp: {
    port: 3001,
    accessMode: 'read',
    allowedTables: [],
    selectLimit: 1000,
    queryTimeoutMs: 30000,
    blockMultipleStatements: true,
    blockFileAccess: true,
    allowSlowFunctions: false,
    requireWhereForUpdateDelete: true,
    confirmUpdate: true,
    confirmDelete: true,
    confirmDdl: true,
    enableExecuteSql: false,
    jsonResponses: true,
    allowedHosts: [],
    allowedOrigins: [],
    bearerToken: ''
  },
  ngrok: {
    enabled: true,
    authtoken: '',
    domain: ''
  },
  sources: []
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function encrypt(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Crittografia sicura non disponibile su questo sistema.');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}


function sanitizeProfile(source) {
  const p = source || {};
  // Only public metadata and names go into the Electron profile store.
  return {
    id: String(p.id || '').trim(),
    name: String(p.name || '').trim(),
    type: p.type === 'access' ? 'access' : 'mysql',
    host: String(p.host || '127.0.0.1').trim(),
    port: Number(p.port || 3306),
    database: String(p.database || '').trim(),
    user: String(p.user || '').trim(),
    file: String(p.file || '').trim(),
    allowedTables: Array.isArray(p.allowedTables) ? p.allowedTables.map(String) : []
  };
}

function exportSourceSettings(settings) {
  const profiles = (settings.sources || []).map(sanitizeProfile);
  if (!profiles.length) throw new Error('Add one or more sources first.');
  const ids = new Set();
  const secretNames = new Set();
  const sources = profiles.map(profile => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(profile.id) || ids.has(profile.id)) {
      throw new Error('Each source must have a unique valid ID.');
    }
    ids.add(profile.id);
    if (profile.type === 'access') {
      if (!/\.(mdb|accdb)$/i.test(profile.file)) throw new Error('Access requires a .mdb or .accdb file.');
      return { id: profile.id, name: profile.name || profile.id,
        type: 'access', file: profile.file, allowedTables: profile.allowedTables };
    }
    if (!profile.host || !profile.user || !profile.database ||
        !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
      throw new Error('MySQL needs host, port, database and a SELECT-only user.');
    }
    const name = 'MCP_' + profile.id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PASSWORD';
    if (secretNames.has(name)) throw new Error('Conflicting password environment variable names.');
    secretNames.add(name);
    return {
      id: profile.id, name: profile.name || profile.id, type: 'mysql',
      mysql: {
        host: profile.host, port: profile.port, database: profile.database, user: profile.user,
        password: String.fromCharCode(36) + '{' + name + '}',
        collation: 'utf8mb4', tlsMode: 'off', allowTlsFallback: false
      },
      allowedTables: profile.allowedTables
    };
  });
  return {
    sources,
    mcp: {
      port: Number(settings.mcp?.port || 3001), accessMode: 'read',
      bearerToken: String.fromCharCode(36) + '{MCP_BEARER_TOKEN}',
      selectLimit: Math.min(5000, Math.max(1, Number(settings.mcp?.selectLimit || 200))),
      queryTimeoutMs: Number(settings.mcp?.queryTimeoutMs || 30000),
      blockMultipleStatements: true, blockFileAccess: true,
      allowSlowFunctions: false, enableExecuteSql: false, jsonResponses: true
    },
    ngrok: { enabled: false }
  };
}

function mergeSettings(base, incoming) {
  return {
    mysql: { ...base.mysql, ...(incoming.mysql || {}) },
    mcp: { ...base.mcp, ...(incoming.mcp || {}) },
    ngrok: { ...base.ngrok, ...(incoming.ngrok || {}) },
    sources: Array.isArray(incoming.sources) ? incoming.sources.map(sanitizeProfile) : []
  };
}

function loadStoredSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return structuredClone(defaultSettings);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = mergeSettings(defaultSettings, raw);
    merged.mysql.password = decrypt(raw.mysql?.passwordEncrypted || '');
    merged.ngrok.authtoken = decrypt(raw.ngrok?.authtokenEncrypted || '');
    merged.mcp.bearerToken = decrypt(raw.mcp?.bearerTokenEncrypted || '');
    return merged;
  } catch {
    return structuredClone(defaultSettings);
  }
}

function saveStoredSettings(settings) {
  const merged = mergeSettings(defaultSettings, settings);
  const serializable = structuredClone(merged);
  serializable.mysql.passwordEncrypted = encrypt(merged.mysql.password || '');
  serializable.ngrok.authtokenEncrypted = encrypt(merged.ngrok.authtoken || '');
  serializable.mcp.bearerTokenEncrypted = encrypt(merged.mcp.bearerToken || '');
  delete serializable.mysql.password;
  delete serializable.ngrok.authtoken;
  delete serializable.mcp.bearerToken;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(serializable, null, 2), 'utf8');
  return merged;
}

async function getBridgeModule() {
  if (bridgeModule) return bridgeModule;
  const modPath = path.join(__dirname, '..', 'server', 'mcpBridge.mjs');
  bridgeModule = await import(pathToFileURL(modPath).href);
  return bridgeModule;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#101216',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (bridgeController) {
    event.preventDefault();
    try { await bridgeController.stop(); } catch { /* stopping on the way out anyway */ }
    bridgeController = null;
    app.exit(0);
  }
});

ipcMain.handle('settings:get', () => loadStoredSettings());
ipcMain.handle('settings:save', (_event, settings) => saveStoredSettings(settings));

ipcMain.handle('mysql:test', async (_event, settings) => {
  const mod = await getBridgeModule();
  return mod.testMySql(settings.mysql || settings);
});

ipcMain.handle('bridge:start', async () => {
  if (bridgeController) return bridgeController.status();
  const mod = await getBridgeModule();
  const settings = loadStoredSettings();
  // Existing Electron Start MCP remains the legacy single-source server.
  bridgeController = await mod.startBridge({ ...settings, sources: undefined }, {
    onLog: (entry) => send('bridge:log', entry),
    onStatus: (status) => send('bridge:status', status),
    onApproval: (approval) => send('bridge:approval', approval)
  });
  return bridgeController.status();
});

ipcMain.handle('bridge:stop', async () => {
  if (!bridgeController) return { running: false };
  await bridgeController.stop();
  bridgeController = null;
  const status = { running: false, mcpUrl: '', publicUrl: '' };
  send('bridge:status', status);
  return status;
});

ipcMain.handle('bridge:status', () => bridgeController ? bridgeController.status() : ({ running: false, mcpUrl: '', publicUrl: '' }));
ipcMain.handle('approvals:list', () => bridgeController ? bridgeController.listApprovals() : []);
ipcMain.handle('approvals:decide', (_event, { id, approved }) => bridgeController ? bridgeController.decideApproval(id, approved) : false);

ipcMain.handle('sql:run', async (_event, sql) => {
  const mod = await getBridgeModule();
  const settings = loadStoredSettings();
  return mod.runLocalSql(settings, sql);
});

ipcMain.handle('standalone:export', (_event, settings) => {
  const content = exportSourceSettings(settings);
  const destination = path.join(app.getPath('userData'), 'standalone');
  fs.mkdirSync(destination, { recursive: true });
  const output = path.join(destination, 'standalone.json');
  fs.writeFileSync(output, JSON.stringify(content, null, 2) + '\n', { mode: 0o600 });
  return { path: output, count: content.sources.length };
});

ipcMain.handle('standalone:status', async (_event, port) => {
  const p = Number(port || 3001);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { online: false, error: 'Invalid port.' };
  try {
    const response = await fetch('http://127.0.0.1:' + p + '/health', { signal: AbortSignal.timeout(2200) });
    if (!response.ok) return { online: false, error: 'HTTP ' + response.status };
    const data = await response.json();
    return { online: data.ok === true && data.service === 'database-mcp-bridge',
      sources: data.sources || [], service: data.service };
  } catch (e) {
    return { online: false, error: e.message };
  }
});
