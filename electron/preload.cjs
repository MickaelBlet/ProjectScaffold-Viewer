// Window controls for the frameless window (window.desktop in the page).
// CommonJS: sandboxed preload scripts cannot be ES modules.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizedChange: (cb) => {
    const listener = (_e, maximized) => cb(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  resizeStart: () => ipcRenderer.send('window:resizeStart'),
  resize: (edge, dx, dy) => ipcRenderer.send('window:resize', edge, dx, dy)
})
