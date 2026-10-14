const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');

let mainWindow;
let bridgeModule;
let bridgeController;
let managedStandalone = null;

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
    bearerToken: '',
    lan: { enabled: false, host: '' }
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
    type: ['mysql', 'access', 'filesystem'].includes(p.type) ? p.type : 'mysql',
    host: String(p.host || '127.0.0.1').trim(),
    port: Number(p.port || 3306),
    database: String(p.database || '').trim(),
    user: String(p.user || '').trim(),
    file: String(p.file || '').trim(),
    rootPath: String(p.rootPath || '').trim(),
    enabled: p.enabled !== false,
    allowedTables: Array.isArray(p.allowedTables) ? p.allowedTables.map(String) : [],
    password: String(p.password || ''),
    passwordSaved: Boolean(p.passwordSaved)
  };
}

function exportSourceSettings(settings) {
  const profiles = (settings.sources || []).map(sanitizeProfile).filter(p => p.enabled);
  if (!profiles.length) throw new Error('Add one or more sources first.');
  const ids = new Set();
  const secretNames = new Set();
  const sources = profiles.map(profile => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(profile.id) || ids.has(profile.id)) {
      throw new Error('Each source must have a unique valid ID.');
    }
    ids.add(profile.id);
    if (profile.type === 'filesystem') {
      if (!profile.rootPath || !(path.isAbsolute(profile.rootPath) || path.win32.isAbsolute(profile.rootPath))) {
        throw new Error('Folder source ' + profile.id + ' needs an absolute Windows path or UNC share.');
      }
      return {
        id: profile.id, name: profile.name || profile.id,
        type: 'filesystem', rootPath: profile.rootPath
      };
    }
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
    automation: {
      enabled: true,
      stateDir: path.join(process.env.ProgramData || app.getPath('userData'), 'DatabaseMCPBridge', 'ai'),
      adminPort: 3002,
      adminToken: String.fromCharCode(36) + '{MCP_AI_ADMIN_TOKEN}',
      timeZone: 'Europe/Rome',
      runTimeoutMs: 300000
    },
    mcp: {
      port: Number(settings.mcp?.port || 3001), accessMode: 'read',
      bearerToken: String.fromCharCode(36) + '{MCP_BEARER_TOKEN}',
      lan: {
        enabled: settings.mcp?.lan?.enabled === true,
        host: settings.mcp?.lan?.enabled === true ? String(settings.mcp.lan.host || '') : ''
      },
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

function existingSettingsFile() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}

function loadStoredSettings(publicView = false) {
  const raw = existingSettingsFile();
  const merged = mergeSettings(defaultSettings, raw);
  merged.mysql.password = decrypt(raw.mysql?.passwordEncrypted || '');
  merged.ngrok.authtoken = decrypt(raw.ngrok?.authtokenEncrypted || '');
  merged.mcp.bearerToken = decrypt(raw.mcp?.bearerTokenEncrypted || '');
  merged.sources = merged.sources.map(profile => {
    const saved = (raw.sources || []).find(item => item.id === profile.id);
    const password = decrypt(saved?.passwordEncrypted || '');
    return {
      ...profile,
      password: publicView ? '' : password,
      passwordSaved: Boolean(password)
    };
  });
  return merged;
}

function saveStoredSettings(settings) {
  const previous = existingSettingsFile();
  const merged = mergeSettings(defaultSettings, settings);
  // Keep the original Bearer identity unless the user explicitly replaces it.
  // On first save, reuse the existing Windows token so OpenCode stays compatible.
  merged.mcp.bearerToken = merged.mcp.bearerToken ||
    decrypt(previous.mcp?.bearerTokenEncrypted || '') ||
    process.env.MCP_BEARER_TOKEN || randomBytes(32).toString('hex');
  const serializable = structuredClone(merged);
  serializable.mysql.passwordEncrypted = encrypt(merged.mysql.password || '');
  serializable.ngrok.authtokenEncrypted = encrypt(merged.ngrok.authtoken || '');
  serializable.mcp.bearerTokenEncrypted = encrypt(merged.mcp.bearerToken);
  serializable.aiAdminTokenEncrypted = previous.aiAdminTokenEncrypted ||
    encrypt(randomBytes(32).toString('hex'));
  delete serializable.mysql.password;
  delete serializable.ngrok.authtoken;
  delete serializable.mcp.bearerToken;
  serializable.sources = merged.sources.map(profile => {
    const prior = (previous.sources || []).find(item => item.id === profile.id);
    const encrypted = profile.password
      ? encrypt(profile.password)
      : (prior?.passwordEncrypted || '');
    const publicProfile = sanitizeProfile(profile);
    delete publicProfile.password;
    delete publicProfile.passwordSaved;
    return { ...publicProfile, passwordEncrypted: encrypted };
  });
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  // Write a complete temporary file first, preventing a truncated settings.json.
  const temp = settingsPath() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(serializable, null, 2), { mode: 0o600 });
    fs.renameSync(temp, settingsPath());
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return loadStoredSettings(true);
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
  if (bridgeController || managedStandalone) {
    event.preventDefault();
    try {
      if (managedStandalone) await managedStandalone.shutdown('Electron closing');
      if (bridgeController) await bridgeController.stop();
    } catch { /* shutdown on exit is best effort */ }
    managedStandalone = null;
    bridgeController = null;
    app.exit(0);
  }
});

ipcMain.handle('settings:get', () => loadStoredSettings(true));
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


function managedStatus() {
  return managedStandalone?.controller?.status() || { running: false };
}

ipcMain.handle('standalone:managed-status', () => managedStatus());

ipcMain.handle('standalone:lan-interfaces', async () => {
  const { availableLanInterfaces } = await import(
    pathToFileURL(path.join(__dirname, '..', 'server', 'lanNetwork.mjs')).href
  );
  return availableLanInterfaces();
});

ipcMain.handle('standalone:managed-start', async (_event, settings) => {
  if (managedStandalone) return managedStatus();
  if (bridgeController) throw new Error('Stop the legacy MCP server before starting multi-source MCP.');
  // Ensure a consistent encrypted source-password and Bearer-token snapshot.
  saveStoredSettings(settings);
  const stored = loadStoredSettings();
  const exportConfig = exportSourceSettings(stored);
  const adminToken = decrypt(existingSettingsFile().aiAdminTokenEncrypted);
  const { managedStandaloneSettings } = await import(
    pathToFileURL(path.join(__dirname, '..', 'server', 'managedSettings.mjs')).href
  );
  const runtimeConfig = managedStandaloneSettings(
    exportConfig, stored, adminToken, path.join(app.getPath('userData'), 'ai')
  );
  const { runStandalone } = await import(
    pathToFileURL(path.join(__dirname, '..', 'server', 'standalone.mjs')).href
  );
  managedStandalone = await runStandalone({
    loadedSettings: runtimeConfig,
    log: item => {
      try { send('standalone:log', JSON.parse(item)); }
      catch { send('standalone:log', { type: 'status', message: String(item) }); }
    },
    error: error => send('standalone:log', { type: 'error', message: String(error) })
  });
  const status = managedStatus();
  send('standalone:managed-status', status);
  return status;
});

ipcMain.handle('standalone:managed-stop', async () => {
  if (managedStandalone) {
    const running = managedStandalone;
    managedStandalone = null;
    await running.shutdown('Electron stop');
  }
  const status = managedStatus();
  send('standalone:managed-status', status);
  return status;
});

ipcMain.handle('standalone:admin-access', () => ({
  port: 3002,
  token: decrypt(existingSettingsFile().aiAdminTokenEncrypted || '')
}));

ipcMain.handle('standalone:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a read-only MCP folder',
    properties: ['openDirectory']
  });
  return result.canceled ? '' : result.filePaths[0] || '';
});

ipcMain.handle('standalone:test-folder', async (_event, folder) => {
  const root = String(folder || '');
  if (!(path.isAbsolute(root) || path.win32.isAbsolute(root))) {
    throw new Error('Enter an absolute folder path, such as S:\\ or \\\\SERVER\\Share.');
  }
  const real = await fs.promises.realpath(root);
  const info = await fs.promises.stat(real);
  if (!info.isDirectory()) throw new Error('The path is not a directory.');
  await fs.promises.readdir(real);
  return { ok: true, path: root };
});

ipcMain.handle('standalone:test-source', async (_event, profile) => {
  const selected = sanitizeProfile(profile);
  if (selected.type !== 'mysql') throw new Error('Only MySQL sources need a connection test.');
  if (!selected.host || !selected.database || !selected.user) {
    throw new Error('Enter host, database, user and password before testing.');
  }
  const prior = loadStoredSettings();
  const saved = prior.sources.find(p => p.id === selected.id);
  const password = selected.password || saved?.password;
  if (!password) throw new Error('Enter a MySQL password first.');
  const mod = await getBridgeModule();
  const result = await mod.testMySql({
    host: selected.host, port: selected.port, database: selected.database,
    user: selected.user, password,
    collation: 'utf8mb4', tlsMode: 'off', allowTlsFallback: false
  });
  return { ok: result.ok, versionLabel: result.versionLabel, tableCount: result.tableCount };
});

ipcMain.handle('standalone:import-project', () => {
  const filename = path.join(__dirname, '..', 'config', 'standalone.json');
  if (!fs.existsSync(filename)) throw new Error('No config/standalone.json in this project. You can fill in the sources manually.');
  const content = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(content.sources)) throw new Error('The configuration contains no multi-source profiles.');
  const sources = content.sources.map(s => sanitizeProfile({
    id: s.id, name: s.name, type: s.type,
    ...(s.type === 'access'
      ? { file: s.file }
      : s.type === 'filesystem'
        ? { rootPath: s.rootPath }
        : { host: s.mysql?.host, port: s.mysql?.port, database: s.mysql?.database, user: s.mysql?.user }),
    allowedTables: s.allowedTables
  }));
  return { sources, count: sources.length };
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

const aiRoutes = new Set(['/status', '/instructions', '/jobs', '/history']);
ipcMain.handle('ai:request', async (_event, request) => {
  const { method, route, payload, token, port } = request || {};
  const p = Number(port || 3002);
  if (!Number.isInteger(p) || p < 1 || p > 65535 || !String(token || '').trim()) {
    throw new Error('Valid admin port and token required.');
  }
  const validBase = aiRoutes.has(route);
  const jobRun = /^\/jobs\/[a-f0-9-]{36}\/run$/.test(route || '');
  const jobDelete = /^\/jobs\/[a-f0-9-]{36}$/.test(route || '');
  const valid = (method === 'GET' && validBase) ||
    (method === 'PUT' && route === '/instructions') ||
    (method === 'POST' && (route === '/jobs' || jobRun)) ||
    (method === 'DELETE' && jobDelete);
  if (!valid) throw new Error('Unsupported AI dashboard operation.');
  let res;
  try {
    res = await fetch('http://127.0.0.1:' + p + '/api' + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(method === 'POST' && jobRun ? 600000 : 8000)
    });
  } catch (error) {
    throw new Error('Cannot reach standalone AI service: ' + error.message);
  }
  const output = await res.json();
  if (!res.ok) throw new Error(output.error || 'AI service responded with ' + res.status);
  return output;
});
