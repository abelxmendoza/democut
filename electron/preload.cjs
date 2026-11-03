const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('democutDesktop', {
  isDesktop: true,
  listSources: () => ipcRenderer.invoke('democut:list-sources'),
  saveTake: (name, bytes) => ipcRenderer.invoke('democut:save-take', { name, bytes }),
  onToggleRecord: (cb) => ipcRenderer.on('democut:toggle-record', cb),
  onTogglePause: (cb) => ipcRenderer.on('democut:toggle-pause', cb),
})
