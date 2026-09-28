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
    ssl: false,
    connectTimeoutMs: 10000
  },
  mcp: {
    port: 3001,
    accessMode: 'read',
    allowedTables: [],
    selectLimit: 1000,
    queryTimeoutMs: 30000,
    blockMultipleStatements: true,
    requireWhereForUpdateDelete: true,
    confirmUpdate: true,
    confirmDelete: true,
    confirmDdl: true,
    enableExecuteSql: false,
    bearerToken: ''
  },
  ngrok: {
    enabled: true,
    authtoken: '',
    domain: ''
  }
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

function mergeSettings(base, incoming) {
  return {
    mysql: { ...base.mysql, ...(incoming.mysql || {}) },
    mcp: { ...base.mcp, ...(incoming.mcp || {}) },
    ngrok: { ...base.ngrok, ...(incoming.ngrok || {}) }
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
    try { await bridgeController.stop(); } catch {}
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
  bridgeController = await mod.startBridge(settings, {
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
