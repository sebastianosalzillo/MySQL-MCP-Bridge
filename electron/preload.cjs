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
  aiRequest: (request) => ipcRenderer.invoke('ai:request', request),
  exportStandalone: (settings) => ipcRenderer.invoke('standalone:export', settings),
  importProjectSources: () => ipcRenderer.invoke('standalone:import-project'),
  chooseFolder: () => ipcRenderer.invoke('standalone:choose-folder'),
  testFolder: path => ipcRenderer.invoke('standalone:test-folder', path),
  testSource: profile => ipcRenderer.invoke('standalone:test-source', profile),
  startManagedStandalone: settings => ipcRenderer.invoke('standalone:managed-start', settings),
  stopManagedStandalone: () => ipcRenderer.invoke('standalone:managed-stop'),
  managedStandaloneStatus: () => ipcRenderer.invoke('standalone:managed-status'),
  managedAdminAccess: () => ipcRenderer.invoke('standalone:admin-access'),
  onManagedStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('standalone:managed-status', handler);
    return () => ipcRenderer.removeListener('standalone:managed-status', handler);
  },
  onManagedLog: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('standalone:log', handler);
    return () => ipcRenderer.removeListener('standalone:log', handler);
  },
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
