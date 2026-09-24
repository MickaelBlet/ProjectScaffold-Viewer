// Browser implementation of the preload API, used when the renderer runs outside Electron.
// Files go through the File System Access API when available (Chrome, Edge), otherwise
// through a file input and a download. Paths are file names: browsers never expose real paths.
// Recent documents live in IndexedDB: their last known content, and their file handle when
// available so that reopening reads the file again and Save rewrites it.
import type { Api, Draft, MenuAction, OpenResult, SaveRequest } from '../../preload/api'

type Permission = 'granted' | 'denied' | 'prompt'

interface FileHandle {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
  queryPermission?(opts: { mode: 'readwrite' }): Promise<Permission>
  requestPermission?(opts: { mode: 'readwrite' }): Promise<Permission>
}

interface PickerType {
  description: string
  accept: Record<string, string[]>
}

interface FsAccessWindow {
  showOpenFilePicker?(opts: { types: PickerType[] }): Promise<FileHandle[]>
  showSaveFilePicker?(opts: { suggestedName: string; types: PickerType[] }): Promise<FileHandle>
}

const TYPES: Record<SaveRequest['format'], PickerType> = {
  yaml: { description: 'YAML', accept: { 'application/yaml': ['.yaml', '.yml'] } },
  json: { description: 'JSON', accept: { 'application/json': ['.json'] } }
}

const fs = window as unknown as FsAccessWindow
/** Handles of files opened or saved in this session, by name, so Save can rewrite them. */
const handles = new Map<string, FileHandle>()

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function pickWithInput(): Promise<File | null> {
  return new Promise((done) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yaml,.yml,.json'
    input.onchange = () => done(input.files?.[0] ?? null)
    input.oncancel = () => done(null)
    input.click()
  })
}

function download(name: string, content: string, format: SaveRequest['format']): void {
  const type = format === 'json' ? 'application/json' : 'application/yaml'
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function write(handle: FileHandle, content: string): Promise<void> {
  const w = await handle.createWritable()
  await w.write(content)
  await w.close()
}

async function openFile(): Promise<OpenResult | null> {
  if (fs.showOpenFilePicker) {
    try {
      const [handle] = await fs.showOpenFilePicker({
        types: [{ description: 'Architecture', accept: { 'application/yaml': ['.yaml', '.yml', '.json'] } }]
      })
      if (!handle) return null
      handles.set(handle.name, handle)
      const content = await (await handle.getFile()).text()
      await remember({ name: handle.name, content, handle })
      return { path: handle.name, content }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const file = await pickWithInput()
  if (!file) return null
  const content = await file.text()
  await remember({ name: file.name, content })
  return { path: file.name, content }
}

async function saveFile(req: SaveRequest): Promise<string | null> {
  const path = await writeFile(req)
  if (path && !req.export) await remember({ name: path, content: req.content, handle: handles.get(path) })
  return path
}

async function writeFile(req: SaveRequest): Promise<string | null> {
  const known = req.path ? handles.get(req.path) : undefined
  if (known) {
    await write(known, req.content)
    return known.name
  }
  if (fs.showSaveFilePicker) {
    try {
      const handle = await fs.showSaveFilePicker({ suggestedName: req.defaultName, types: [TYPES[req.format]] })
      await write(handle, req.content)
      handles.set(handle.name, handle)
      return handle.name
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const name = req.path ?? req.defaultName
  download(name, req.content, req.format)
  return name
}

interface RecentEntry {
  name: string
  /** Content as last opened or saved: the fallback when the file cannot be read again. */
  content: string
  handle?: FileHandle
}

const MAX_RECENT = 10
const DB_NAME = 'project-scaffold'
const STORE = 'recent'
const recentListeners = new Set<(files: string[]) => void>()

/** Runs one request on the single-record store; rejects when IndexedDB is unavailable. */
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((done, fail) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => fail(open.error)
    open.onsuccess = () => {
      const db = open.result
      let req: IDBRequest<T>
      try {
        // Throws synchronously on values that cannot be cloned (DataCloneError).
        req = run(db.transaction(STORE, mode).objectStore(STORE))
      } catch (e) {
        db.close()
        return fail(e)
      }
      req.onsuccess = () => done(req.result)
      req.onerror = () => fail(req.error)
      req.transaction?.addEventListener('complete', () => db.close())
    }
  })
}

async function loadRecent(): Promise<RecentEntry[]> {
  try {
    const list = await withStore<RecentEntry[] | undefined>('readonly', (s) => s.get('list'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function storeRecent(list: RecentEntry[]): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(list, 'list'))
  } catch {
    try {
      // From file:// the origin is opaque and file handles cannot be stored: keep the contents.
      await withStore('readwrite', (s) => s.put(list.map(({ name, content }) => ({ name, content })), 'list'))
    } catch (e) {
      // Private browsing or blocked storage: recent documents only last for the session.
      console.warn('Recent documents not stored:', e)
    }
  }
  const names = list.map((e) => e.name)
  recentListeners.forEach((cb) => cb(names))
}

async function remember(entry: RecentEntry): Promise<void> {
  const list = await loadRecent()
  const previous = list.find((e) => e.name === entry.name)
  const handle = entry.handle ?? previous?.handle
  await storeRecent([{ ...entry, handle }, ...list.filter((e) => e !== previous)].slice(0, MAX_RECENT))
}

/** Reads the entry's file again when permitted, else falls back to the stored content. */
async function readRecent(entry: RecentEntry, ask: boolean): Promise<OpenResult> {
  const { handle } = entry
  let content = entry.content
  if (handle) {
    // Save goes through the handle, even when its permission must be granted again later.
    handles.set(entry.name, handle)
    try {
      const opts = { mode: 'readwrite' } as const
      const perm = ask
        ? await handle.requestPermission?.(opts)
        : await handle.queryPermission?.(opts)
      if (perm === 'granted') content = await (await handle.getFile()).text()
    } catch {
      // File moved or deleted: keep the stored content.
    }
  }
  await remember({ ...entry, content })
  return { path: entry.name, content }
}

// localStorage rather than IndexedDB: synchronous, so the last edits are written while
// the page unloads.
const DRAFT_KEY = 'project-scaffold:draft'

function saveDraft(draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Blocked storage or quota exceeded: edits are lost on reload.
  }
}

async function loadDraft(): Promise<Draft | null> {
  let draft: Draft | null
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null
  } catch {
    return null
  }
  if (!draft || typeof draft.content !== 'string') return null
  // Save rewrites the draft's file when it is a recent one with a handle.
  const handle = (await loadRecent()).find((e) => e.name === draft.path)?.handle
  if (handle) handles.set(handle.name, handle)
  return draft
}

let dirty = false
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault()
})

/** Keyboard shortcuts of the Electron menu. Browser-reserved ones (Ctrl+N) are unavailable. */
function shortcut(e: KeyboardEvent): MenuAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (key === 'o' && !e.shiftKey) return 'open'
  if (key === 's') return e.shiftKey ? 'save-as' : 'save'
  if (key === 'e') return e.shiftKey ? 'export-json' : 'export-yaml'
  if (key === 'm' && !e.shiftKey) return 'add-module'
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !e.shiftKey) return 'redo'
  return null
}

const webApi: Api = {
  openFile,
  initialFile: async () => {
    const [last] = await loadRecent()
    return last ? readRecent(last, false) : null
  },
  saveFile,
  recentFiles: async () => (await loadRecent()).map((e) => e.name),
  openRecent: async (path) => {
    const entry = (await loadRecent()).find((e) => e.name === path)
    return entry ? readRecent(entry, true) : null
  },
  clearRecent: () => storeRecent([]),
  onRecentChange: (cb) => {
    recentListeners.add(cb)
    return () => recentListeners.delete(cb)
  },
  onOpenRecent: () => () => undefined,
  setDirty: (value) => {
    dirty = value
  },
  saveDraft,
  loadDraft,
  onMenu: (cb) => {
    const listener = (e: KeyboardEvent): void => {
      const action = shortcut(e)
      if (!action) return
      e.preventDefault()
      cb(action)
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }
}

export function installWebApi(): void {
  // Declared non-optional for Electron; absent in a plain browser.
  if (!(window as Partial<Window>).api) window.api = webApi
}
