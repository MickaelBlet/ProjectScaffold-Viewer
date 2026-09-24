import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from './api'

function on<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  openFile: () => ipcRenderer.invoke('file:open'),
  initialFile: () => ipcRenderer.invoke('file:initial'),
  saveFile: (req) => ipcRenderer.invoke('file:save', req),
  recentFiles: () => ipcRenderer.invoke('recent:list'),
  openRecent: (path) => ipcRenderer.invoke('recent:open', path),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  onRecentChange: (cb) => on('recent', cb),
  onOpenRecent: (cb) => on('menu:open-recent', cb),
  setDirty: (dirty) => ipcRenderer.send('app:dirty', dirty),
  onMenu: (cb) => on('menu', cb)
}

contextBridge.exposeInMainWorld('api', api)
