const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAI', {
  state: () => ipcRenderer.invoke('local-ai', 'state'),
  check: () => ipcRenderer.invoke('local-ai', 'check'),
  folder: () => ipcRenderer.invoke('local-ai', 'folder'),
  setup: (mode, importOnly) => ipcRenderer.invoke('local-ai', 'setup', { mode, importOnly }),
  cancel: () => ipcRenderer.invoke('local-ai', 'cancel'),
  stop: () => ipcRenderer.invoke('local-ai', 'stop'),
  continue: () => ipcRenderer.invoke('local-ai', 'continue'),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('local-ai-state', listener);
    return () => ipcRenderer.removeListener('local-ai-state', listener);
  },
});
