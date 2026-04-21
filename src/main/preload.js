// Preload: exposes a narrow, safe API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botc', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  startServer: (opts) => ipcRenderer.invoke('server:start', opts),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  showError: (msg) => ipcRenderer.invoke('dialog:error', msg),
  micStatus: () => ipcRenderer.invoke('mic:status'),
  askMic: () => ipcRenderer.invoke('mic:ask'),
  openMicSettings: () => ipcRenderer.invoke('mic:open-settings'),
});
