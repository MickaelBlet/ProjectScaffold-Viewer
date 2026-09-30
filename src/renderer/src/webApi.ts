// Browser implementation of the file API.
// Files go through the File System Access API when available (Chrome, Edge), otherwise
// through a file input and a download. Paths are file names: browsers never expose real paths.
// Recent documents live in IndexedDB: their last known content, and their file handle when
// available so that reopening reads the file again and Save rewrites it.
import type { Api, OpenResult, OutputDirRequest, SaveRequest, Session } from './api'
import type { OutputDir } from './codegen/run'

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

interface DirHandle {
  name: string
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>
  removeEntry(name: string): Promise<void>
  queryPermission?(opts: { mode: 'readwrite' }): Promise<Permission>
  requestPermission?(opts: { mode: 'readwrite' }): Promise<Permission>
}

interface FsAccessWindow {
  showOpenFilePicker?(opts: { types: PickerType[]; multiple?: boolean }): Promise<FileHandle[]>
  showSaveFilePicker?(opts: { suggestedName: string; types: PickerType[] }): Promise<FileHandle>
  showDirectoryPicker?(opts: {
    id?: string
    mode: 'readwrite'
    startIn?: DirHandle | FileHandle
  }): Promise<DirHandle>
}

const TYPES: Record<SaveRequest['format'], PickerType> = {
  yaml: { description: 'YAML', accept: { 'application/yaml': ['.yaml', '.yml'] } },
  json: { description: 'JSON', accept: { 'application/json': ['.json'] } }
}

const fs = window as unknown as FsAccessWindow
/**
 * Handles of files opened or saved in this session, by path (name, or path in a workspace folder),
 * so Save can rewrite them.
 */
const handles = new Map<string, FileHandle>()
/** Modification time of each file as last read or written here, by path. */
const stamps = new Map<string, number>()

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function pickWithInput(multiple: boolean): Promise<File[]> {
  return new Promise((done) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yaml,.yml,.json'
    input.multiple = multiple
    input.onchange = () => done([...(input.files ?? [])])
    input.oncancel = () => done([])
    input.click()
  })
}

function downloadUrl(name: string, url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

function download(name: string, content: string, format: SaveRequest['format']): void {
  const type = format === 'json' ? 'application/json' : 'application/yaml'
  const url = URL.createObjectURL(new Blob([content], { type }))
  downloadUrl(name, url)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function write(handle: FileHandle, content: string, path = handle.name): Promise<void> {
  const w = await handle.createWritable()
  await w.write(content)
  await w.close()
  stamps.set(path, (await handle.getFile()).lastModified)
}

/** Reads a file through its handle, noting when it was last modified. */
async function read(handle: FileHandle, path = handle.name): Promise<string> {
  const file = await handle.getFile()
  stamps.set(path, file.lastModified)
  return file.text()
}

async function changedOnDisk(path: string): Promise<string | null> {
  const handle = handles.get(path)
  const known = stamps.get(path)
  // Only files read here with access granted: never ask for permission while polling.
  if (!handle || known === undefined) return null
  try {
    const file = await handle.getFile()
    if (file.lastModified === known) return null
    stamps.set(path, file.lastModified)
    return await file.text()
  } catch {
    // Moved, deleted or access revoked.
    return null
  }
}

async function pickFiles(multiple: boolean): Promise<OpenResult[]> {
  if (fs.showOpenFilePicker) {
    try {
      const picked = await fs.showOpenFilePicker({
        types: [{ description: 'Architecture', accept: { 'application/yaml': ['.yaml', '.yml', '.json'] } }],
        multiple
      })
      const files: OpenResult[] = []
      for (const handle of picked) {
        handles.set(handle.name, handle)
        const content = await read(handle)
        await remember({ name: handle.name, content, handle })
        files.push({ path: handle.name, content })
      }
      return files
    } catch (e) {
      if (isAbort(e)) return []
      throw e
    }
  }
  const files: OpenResult[] = []
  for (const file of await pickWithInput(multiple)) {
    const content = await file.text()
    await remember({ name: file.name, content })
    files.push({ path: file.name, content })
  }
  return files
}

async function openFile(): Promise<OpenResult | null> {
  const [file] = await pickFiles(false)
  return file ?? null
}

async function saveFile(req: SaveRequest): Promise<string | null> {
  const path = await writeFile(req)
  if (path && !req.export) {
    await remember({ name: path, content: req.content, handle: handles.get(path) })
    await updateWorkspaceFile(path, req.content)
  }
  return path
}

async function writeFile(req: SaveRequest): Promise<string | null> {
  const known = req.path ? handles.get(req.path) : undefined
  if (req.path && known) {
    await write(known, req.content, req.path)
    return req.path
  }
  if (fs.showSaveFilePicker) {
    try {
      const handle = await fs.showSaveFilePicker({
        suggestedName: req.defaultName,
        types: [TYPES[req.format]]
      })
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
    open.onerror = () => fail(open.error ?? new Error('Cannot open IndexedDB'))
    open.onsuccess = () => {
      const db = open.result
      let req: IDBRequest<T>
      try {
        // Throws synchronously on values that cannot be cloned (DataCloneError).
        req = run(db.transaction(STORE, mode).objectStore(STORE))
      } catch (e) {
        db.close()
        return fail(e instanceof Error ? e : new Error(String(e)))
      }
      req.onsuccess = () => done(req.result)
      req.onerror = () => fail(req.error ?? new Error('IndexedDB request failed'))
      req.transaction?.addEventListener('complete', () => db.close())
    }
  })
}

async function loadRecent(): Promise<RecentEntry[]> {
  try {
    const list = await withStore<RecentEntry[] | undefined>(
      'readonly',
      (s) => s.get('list') as IDBRequest<RecentEntry[] | undefined>
    )
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
      await withStore('readwrite', (s) =>
        s.put(
          list.map(({ name, content }) => ({ name, content })),
          'list'
        )
      )
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
async function readRecent(entry: RecentEntry, ask: boolean, touch = true): Promise<OpenResult> {
  const { handle } = entry
  let content = entry.content
  if (handle) {
    // Save goes through the handle, even when its permission must be granted again later.
    handles.set(entry.name, handle)
    try {
      const opts = { mode: 'readwrite' } as const
      const perm = ask ? await handle.requestPermission?.(opts) : await handle.queryPermission?.(opts)
      if (perm === 'granted') content = await read(handle, entry.name)
    } catch {
      // File moved or deleted: keep the stored content.
    }
  }
  if (touch) await remember({ ...entry, content })
  return { path: entry.name, content }
}

// localStorage rather than IndexedDB: synchronous, so the last edits are written while
// the page unloads.
const SESSION_KEY = 'project-scaffold:session'
/** Single unsaved document of earlier versions. */
const LEGACY_DRAFT_KEY = 'project-scaffold:draft'

function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    localStorage.removeItem(LEGACY_DRAFT_KEY)
  } catch {
    // Blocked storage or quota exceeded: edits are lost on reload.
  }
}

function readSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null
    if (session && Array.isArray(session.docs)) return session
    const draft = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY) ?? 'null') as {
      path: string | null
      content: string
    } | null
    if (draft && typeof draft.content === 'string')
      return { docs: [{ path: draft.path, content: draft.content }], active: 0 }
  } catch {
    // Unreadable: start afresh.
  }
  return null
}

async function loadSession(): Promise<Session | null> {
  const session = readSession()
  if (!session) return null
  // Save rewrites the documents' files when they are recent ones with a handle.
  const known = [...(await loadRecent()), ...((await loadWorkspace())?.files ?? [])]
  for (const doc of session.docs) {
    const handle = known.find((e) => e.name === doc.path)?.handle
    if (handle && doc.path) handles.set(doc.path, handle)
  }
  return session
}

// Last workspace read: its folder, and its files as last read or saved, so that its documents are
// read again after a page reload (not all of them are recent documents).
const WORKSPACE_KEY = 'workspace'

interface WorkspaceRecord {
  /** Path of the workspace file. */
  name: string
  dir?: DirHandle
  files: RecentEntry[]
}

async function loadWorkspace(): Promise<WorkspaceRecord | undefined> {
  try {
    return await withStore<WorkspaceRecord | undefined>(
      'readonly',
      (s) => s.get(WORKSPACE_KEY) as IDBRequest<WorkspaceRecord | undefined>
    )
  } catch {
    return undefined
  }
}

async function storeWorkspace(record: WorkspaceRecord): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(record, WORKSPACE_KEY))
  } catch {
    try {
      // Handles cannot be stored (file:// origin): keep the contents.
      const files = record.files.map(({ name, content }) => ({ name, content }))
      await withStore('readwrite', (s) => s.put({ name: record.name, files }, WORKSPACE_KEY))
    } catch {
      // Blocked storage: the workspace documents are not restored after a reload.
    }
  }
}

/** Keeps the stored content of a saved workspace file up to date. */
async function updateWorkspaceFile(name: string, content: string): Promise<void> {
  const record = await loadWorkspace()
  const file = record?.files.find((f) => f.name === name)
  if (!record || !file) return
  file.content = content
  await storeWorkspace(record)
}

/** Whether read-write access to a folder is granted; asks for it with `ask` (needs a user gesture). */
async function granted(dir: DirHandle, ask: boolean): Promise<boolean> {
  try {
    const opts = { mode: 'readwrite' } as const
    if ((await dir.queryPermission?.(opts)) === 'granted') return true
    return ask && (await dir.requestPermission?.(opts)) === 'granted'
  } catch {
    return false
  }
}

/** Handle of the file at a `/`-separated path in a folder; null when absent or out of it. */
async function fileAt(dir: DirHandle, path: string): Promise<FileHandle | null> {
  const parts = path.split('/')
  const name = parts.pop()!
  if (parts.some((p) => p === '..' || p === '') || /^[A-Za-z]:/.test(path)) return null
  try {
    for (const p of parts) if (p !== '.') dir = await dir.getDirectoryHandle(p)
    return await dir.getFileHandle(name)
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/** Folder picked with a file input (no File System Access API): its files by path inside it. */
function pickFolderWithInput(): Promise<Map<string, File> | null> {
  return new Promise((done) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.onchange = () =>
      done(
        new Map([...(input.files ?? [])].map((f) => [f.webkitRelativePath.split('/').slice(1).join('/'), f]))
      )
    input.oncancel = () => done(null)
    input.click()
  })
}

async function readWorkspace(path: string, files: string[]): Promise<(OpenResult | null)[] | null> {
  const record = await loadWorkspace()
  const entries: RecentEntry[] = []
  const results: (OpenResult | null)[] = []
  let dir = record?.name === path && record.dir && (await granted(record.dir, true)) ? record.dir : undefined
  if (!dir && fs.showDirectoryPicker) {
    try {
      dir = await fs.showDirectoryPicker({ id: 'workspace', mode: 'readwrite', startIn: handles.get(path) })
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
    if (!(await fileAt(dir, path.split(/[\\/]/).pop()!)))
      throw new Error(`${path} is not in the folder ${dir.name}: pick the folder holding it`)
  }
  if (dir) {
    for (const file of files) {
      const handle = await fileAt(dir, file)
      if (!handle) {
        results.push(null)
        continue
      }
      const content = await read(handle, file)
      handles.set(file, handle)
      entries.push({ name: file, content, handle })
      results.push({ path: file, content })
    }
  } else {
    const picked = await pickFolderWithInput()
    if (!picked) return null
    for (const file of files) {
      const found = picked.get(file.replace(/^(\.\/)+/, ''))
      const content = found ? await found.text() : null
      if (content !== null) entries.push({ name: file, content })
      results.push(content === null ? null : { path: file, content })
    }
  }
  await storeWorkspace({ name: path, dir, files: entries })
  return results
}

// Output directories of generated code, by document; kept in IndexedDB when handles can be stored.
const outputDirs = new Map<string, DirHandle>()
const outputKey = (doc: string | null): string => `outputDir:${doc ?? ''}`

async function rememberedOutput(doc: string | null): Promise<DirHandle | undefined> {
  const known = outputDirs.get(outputKey(doc))
  if (known) return known
  try {
    return await withStore<DirHandle | undefined>(
      'readonly',
      (s) => s.get(outputKey(doc)) as IDBRequest<DirHandle | undefined>
    )
  } catch {
    return undefined
  }
}

const notFound = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')

/** A directory handle as an output directory: paths are `/`-separated, relative to it. */
function handleDir(root: DirHandle): OutputDir {
  const locate = async (path: string, create: boolean): Promise<[DirHandle, string]> => {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create })
    return [dir, name]
  }
  return {
    label: root.name,
    read: async (path) => {
      try {
        const [dir, name] = await locate(path, false)
        return await (await (await dir.getFileHandle(name)).getFile()).text()
      } catch (e) {
        if (notFound(e)) return null
        throw e
      }
    },
    write: async (path, text) => {
      const [dir, name] = await locate(path, true)
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable()
      await w.write(text)
      await w.close()
    },
    remove: async (path) => {
      try {
        const [dir, name] = await locate(path, false)
        await dir.removeEntry(name)
      } catch (e) {
        if (!notFound(e)) throw e
      }
    }
  }
}

async function outputDir(req: OutputDirRequest): Promise<OutputDir | null> {
  const previous = await rememberedOutput(req.document)
  let handle = req.pick ? undefined : previous
  if (handle && (await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
    if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') handle = undefined
  }
  if (!handle) {
    try {
      handle = await fs.showDirectoryPicker!({ id: 'generate', mode: 'readwrite', startIn: previous })
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
    outputDirs.set(outputKey(req.document), handle)
    try {
      await withStore('readwrite', (s) => s.put(handle, outputKey(req.document)))
    } catch {
      // Handles cannot be stored (file:// origin, private browsing): remembered for the session.
    }
  }
  return handleDir(handle)
}

let dirty = false

const webApi: Api = {
  openFile,
  openFiles: () => pickFiles(true),
  initialFile: async () => {
    const [last] = await loadRecent()
    return last ? readRecent(last, false) : null
  },
  saveFile,
  changedOnDisk,
  writesFiles: !!fs.showSaveFilePicker,
  recentFiles: async () => (await loadRecent()).map((e) => e.name),
  openRecent: async (path) => {
    const entry = (await loadRecent()).find((e) => e.name === path)
    return entry ? readRecent(entry, true) : null
  },
  reopen: async (path) => {
    const entry =
      (await loadRecent()).find((e) => e.name === path) ??
      (await loadWorkspace())?.files.find((e) => e.name === path)
    return entry ? readRecent(entry, false, false) : null
  },
  clearRecent: () => storeRecent([]),
  onRecentChange: (cb) => {
    recentListeners.add(cb)
    return () => recentListeners.delete(cb)
  },
  setDirty: (value) => {
    dirty = value
  },
  saveSession,
  loadSession,
  readWorkspace,
  saveImage: (name, dataUrl) => {
    downloadUrl(name, dataUrl)
    return Promise.resolve(name)
  },
  outputDir: fs.showDirectoryPicker ? outputDir : undefined
}

export function installWebApi(): void {
  window.api = webApi
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault()
  })
}
