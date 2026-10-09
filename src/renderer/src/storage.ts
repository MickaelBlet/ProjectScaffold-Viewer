// Preferences storage (settings, panel layout, recent commands). localStorage in a browser; in
// VS Code the extension's global state, shared by all its editors (each webview has its own
// localStorage, lost when the webview closes).
import { IN_VSCODE, vscode } from './host'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const local: KeyValueStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Blocked storage or quota exceeded: kept for the session only.
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Blocked storage.
    }
  }
}

const values = new Map<string, string>(IN_VSCODE ? Object.entries(window.scaffoldInit?.storage ?? {}) : [])
const listeners = new Set<(key: string) => void>()

function put(key: string, value: string | null): void {
  if (value === null) values.delete(key)
  else values.set(key, value)
  vscode?.postMessage({ type: 'storage', key, value })
}

const host: KeyValueStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => put(key, value),
  removeItem: (key) => put(key, null)
}

export const storage: KeyValueStorage = IN_VSCODE ? host : local

/** VS Code: a value was changed by another editor. */
export function storageChanged(key: string, value: string | null): void {
  if (value === null) values.delete(key)
  else values.set(key, value)
  listeners.forEach((cb) => cb(key))
}

/** Calls `cb` when another editor changes a value (VS Code only). */
export function onStorageChange(cb: (key: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
