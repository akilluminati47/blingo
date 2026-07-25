// preload.cjs — bridges renderer to main process for tab icon cycling
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  setIcon: (dataUrl) => ipcRenderer.send('set-icon', dataUrl),
});
