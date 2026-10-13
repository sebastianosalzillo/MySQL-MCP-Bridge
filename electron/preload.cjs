const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testMySql: (settings) => ipcRenderer.invoke('mysql:test', settings),
  startBridge: () => ipcRenderer.invoke('bridge:start'),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  getStatus: () => ipcRenderer.invoke('bridge:status'),
  runSql: (sql) => ipcRenderer.invoke('sql:run', sql),
  checkStandalone: (port) => ipcRenderer.invoke('standalone:status', port),
  exportStandalone: (settings) => ipcRenderer.invoke('standalone:export', settings),
  listApprovals: () => ipcRenderer.invoke('approvals:list'),
  decideApproval: (id, approved) => ipcRenderer.invoke('approvals:decide', { id, approved }),
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('bridge:log', handler);
    return () => ipcRenderer.removeListener('bridge:log', handler);
  },
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('bridge:status', handler);
    return () => ipcRenderer.removeListener('bridge:status', handler);
  },
  onApproval: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('bridge:approval', handler);
    return () => ipcRenderer.removeListener('bridge:approval', handler);
  }
});
