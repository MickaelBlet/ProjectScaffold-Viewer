// Browser implementation of the file API.
// Files go through the File System Access API when available (Chrome, Edge), otherwise
// through a file input and a download. Paths are file names: browsers never expose real paths.
// Recent documents live in IndexedDB: their last known content, and their file handle when
// available so that reopening reads the file again and Save rewrites it.
import type {
  Api,
  FileFilter,
  OpenResult,
  OutputDirRequest,
  SaveRequest,
  Session,
  TemplateDirRequest
} from './api'
import type { OutputDir } from './codegen/run'
import { isInsidePath } from './codegen/templateSet'

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
  /** Names from this folder down to the entry; null when it is not inside. */
  resolve?(entry: FileHandle | DirHandle): Promise<string[] | null>
  isSameEntry?(other: DirHandle): Promise<boolean>
  keys?(): AsyncIterator<string>
}

interface FsAccessWindow {
  showOpenFilePicker?(opts: {
    id?: string
    types: PickerType[]
    multiple?: boolean
    startIn?: DirHandle | FileHandle
  }): Promise<FileHandle[]>
  showSaveFilePicker?(opts: {
    id?: string
    suggestedName: string
    types: PickerType[]
    startIn?: DirHandle | FileHandle
  }): Promise<FileHandle>
  showDirectoryPicker?(opts: {
    id?: string
    mode: 'readwrite'
    startIn?: DirHandle | FileHandle
  }): Promise<DirHandle>
}

const TYPES: Record<SaveRequest['format'], PickerType> = {
  yaml: { description: 'YAML', accept: { 'application/yaml': ['.yaml', '.yml'] } },
  json: { description: 'JSON', accept: { 'application/json': ['.json'] } },
  text: { description: 'Text', accept: { 'text/plain': ['.idl', '.txt'] } }
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

const PROJECT_FILES: FileFilter = { description: 'Architecture', extensions: ['yaml', 'yml', 'json'] }

function pickWithInput(multiple: boolean, filter: FileFilter): Promise<File[]> {
  return new Promise((done) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = filter.extensions.map((e) => `.${e}`).join(',')
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
  const type = format === 'json' ? 'application/json' : format === 'text' ? 'text/plain' : 'application/yaml'
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

async function readPicked(path: string): Promise<string | null> {
  const handle = handles.get(path) ?? handles.get(path.split(/[\\/]/).pop() ?? path)
  if (!handle) return null
  try {
    return await read(handle, path)
  } catch {
    return null
  }
}

/** Picks files; project files (no `filter`) go to the recent files. */
async function pickFiles(multiple: boolean, filter?: FileFilter): Promise<OpenResult[]> {
  const accept = filter ?? PROJECT_FILES
  if (fs.showOpenFilePicker) {
    try {
      const picked = await fs.showOpenFilePicker({
        id: 'project',
        startIn: await lastFile(),
        types: [
          {
            description: accept.description,
            accept: { [filter ? 'text/plain' : 'application/yaml']: accept.extensions.map((e) => `.${e}`) }
          }
        ],
        multiple
      })
      const files: OpenResult[] = []
      for (const handle of picked) {
        // Other files (IDL) can be saved again, but are no recent documents.
        handles.set(handle.name, handle)
        if (filter) {
          files.push({ path: handle.name, content: await read(handle) })
          continue
        }
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
  for (const file of await pickWithInput(multiple, accept)) {
    const content = await file.text()
    if (!filter) await remember({ name: file.name, content })
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
  if (path && req.format !== 'text') {
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
        id: 'project',
        startIn: await lastFile(),
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

/** Handle of the most recent project file: pickers start in its folder. */
async function lastFile(): Promise<FileHandle | undefined> {
  return (await loadRecent()).find((e) => e.handle)?.handle
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

/** Set once the stored data is cleared: the page reloads without writing its session back. */
let cleared = false

function saveSession(session: Session): void {
  if (cleared) return
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
  if (!isInsidePath(path)) return null
  const parts = path.split('/')
  const name = parts.pop()!
  try {
    for (const p of parts) if (p && p !== '.') dir = await dir.getDirectoryHandle(p)
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

// Folders of the workspaces read, most recent first: a workspace file inside one of them is read
// again without picking its folder.
const WORKSPACE_DIRS_KEY = 'workspaceDirs'
const MAX_WORKSPACE_DIRS = 20

async function loadWorkspaceDirs(): Promise<DirHandle[]> {
  try {
    return (
      (await withStore<DirHandle[] | undefined>(
        'readonly',
        (s) => s.get(WORKSPACE_DIRS_KEY) as IDBRequest<DirHandle[] | undefined>
      )) ?? []
    )
  } catch {
    return []
  }
}

async function rememberWorkspaceDir(dir: DirHandle): Promise<void> {
  const known = await loadWorkspaceDirs()
  const others: DirHandle[] = []
  for (const d of known) if (!(await d.isSameEntry?.(dir).catch(() => false))) others.push(d)
  try {
    const dirs = [dir, ...others].slice(0, MAX_WORKSPACE_DIRS)
    await withStore('readwrite', (s) => s.put(dirs, WORKSPACE_DIRS_KEY))
  } catch {
    // Handles cannot be stored (file:// origin, private browsing): the folder is picked next time.
  }
}

/** The folder holding a file, from a folder it is somewhere inside; null when it is not. */
async function folderOf(root: DirHandle, file: FileHandle): Promise<DirHandle | null> {
  try {
    const parts = await root.resolve?.(file)
    if (!parts?.length) return null
    let dir = root
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p)
    return dir
  } catch {
    return null
  }
}

/**
 * Folder of a workspace file from the folders granted before: those still granted first, else the
 * first one holding it, whose permission is asked again.
 */
async function knownWorkspaceFolder(file: FileHandle): Promise<DirHandle | undefined> {
  const dirs = await loadWorkspaceDirs()
  for (const ask of [false, true])
    for (const root of dirs) {
      if (!(await granted(root, false))) {
        // Permission is asked for one folder only, and only once a folder holds the file.
        if (!ask || !(await root.resolve?.(file).catch(() => null))) continue
        if (!(await granted(root, true))) return undefined
      }
      const dir = await folderOf(root, file)
      if (dir) return dir
    }
  return undefined
}

async function readWorkspace(path: string, files: string[]): Promise<(OpenResult | null)[] | null> {
  const record = await loadWorkspace()
  const entries: RecentEntry[] = []
  const results: (OpenResult | null)[] = []
  const file = handles.get(path)
  let dir = file ? await knownWorkspaceFolder(file) : undefined
  if (!dir && record?.name === path && record.dir && (await granted(record.dir, true))) dir = record.dir
  if (!dir && fs.showDirectoryPicker) {
    let picked: DirHandle
    try {
      picked = await fs.showDirectoryPicker({ id: 'workspace', mode: 'readwrite', startIn: file })
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
    // The folder holding the workspace file, or any folder above it.
    dir = (file && (await folderOf(picked, file))) ?? picked
    if (!(await fileAt(dir, path.split(/[\\/]/).pop()!)))
      throw new Error(`${path} is not in the folder ${picked.name}: pick the folder holding it`)
    await rememberWorkspaceDir(picked)
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

// Output directories of generated code and template folders, by document; kept in IndexedDB when
// handles can be stored.
const dirHandles = new Map<string, DirHandle>()
const outputKey = (doc: string | null): string => `outputDir:${doc ?? ''}`
const templateKey = (doc: string | null): string => `templateDir:${doc ?? ''}`

async function rememberedDir(key: string): Promise<DirHandle | undefined> {
  const known = dirHandles.get(key)
  if (known) return known
  try {
    return await withStore<DirHandle | undefined>(
      'readonly',
      (s) => s.get(key) as IDBRequest<DirHandle | undefined>
    )
  } catch {
    return undefined
  }
}

async function rememberDir(key: string, handle: DirHandle | null): Promise<void> {
  if (handle) dirHandles.set(key, handle)
  else dirHandles.delete(key)
  try {
    if (handle) await withStore('readwrite', (s) => s.put(handle, key))
    else await withStore('readwrite', (s) => s.delete(key))
  } catch {
    // Handles cannot be stored (file:// origin, private browsing): remembered for the session.
  }
}

/** Folder picked by the user; null when cancelled. */
async function pickDir(id: string, startIn?: DirHandle): Promise<DirHandle | null> {
  try {
    return await fs.showDirectoryPicker!({ id, mode: 'readwrite', startIn })
  } catch (e) {
    if (isAbort(e)) return null
    throw e
  }
}

const notFound = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')

/** Whether a remembered folder still exists: deleted or recreated since, its handle finds nothing. */
async function exists(dir: DirHandle): Promise<boolean> {
  try {
    await dir.keys?.().next()
    return true
  } catch (e) {
    if (notFound(e)) return false
    throw e
  }
}

/** A directory handle as an output directory: paths are `/`-separated, relative to it. */
function handleDir(root: DirHandle): OutputDir {
  const locate = async (path: string, create: boolean): Promise<[DirHandle, string]> => {
    if (!isInsidePath(path)) throw new Error(`invalid path '${path}': not inside ${root.name}`)
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) if (p && p !== '.') dir = await dir.getDirectoryHandle(p, { create })
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
  const key = outputKey(req.document)
  const previous = await rememberedDir(key)
  // Asked for without a user gesture (listing its files): access is asked for on first use.
  if (req.known) return previous && !req.pick ? askingDir(previous) : null
  let handle = req.pick ? undefined : previous
  if (handle && !(await granted(handle, true))) handle = undefined
  const gone = !!handle && !(await exists(handle))
  if (gone) handle = undefined
  if (!handle) {
    const picked = await pickDir('generate', gone ? undefined : previous)
    if (!picked) return null
    await rememberDir(key, picked)
    handle = picked
  }
  return handleDir(handle)
}

/** A remembered folder as a directory, asking for access to it on first use (after a user gesture). */
function askingDir(handle: DirHandle): OutputDir {
  const dir = handleDir(handle)
  let access: Promise<boolean> | undefined
  const ensure = async (): Promise<void> => {
    if (await (access ??= granted(handle, true))) return
    access = undefined
    throw new Error(`access to the folder ${handle.name} is not granted`)
  }
  return {
    label: dir.label,
    read: async (path) => {
      await ensure()
      return dir.read(path)
    },
    write: async (path, text) => {
      await ensure()
      await dir.write(path, text)
    },
    remove: async (path) => {
      await ensure()
      await dir.remove(path)
    }
  }
}

async function templateDir(req: TemplateDirRequest): Promise<OutputDir | null> {
  const key = templateKey(req.document)
  if (req.op === 'forget') {
    await rememberDir(key, null)
    return null
  }
  const previous = await rememberedDir(key)
  if (req.op === 'current') return previous ? askingDir(previous) : null
  const picked = await pickDir('templates', previous)
  if (!picked) return null
  await rememberDir(key, picked)
  return handleDir(picked)
}

let dirty = false

function deleteDatabase(name: string): Promise<void> {
  return new Promise((done) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => done()
  })
}

async function clearStorage(): Promise<void> {
  cleared = true
  dirty = false
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Blocked storage: nothing stored.
  }
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: DB_NAME }]
    await Promise.all(dbs.flatMap((db) => (db.name ? [deleteDatabase(db.name)] : [])))
  } catch {
    // IndexedDB unavailable.
  }
  try {
    if ('caches' in window) await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
    const workers = (await navigator.serviceWorker?.getRegistrations()) ?? []
    await Promise.all(workers.map((w) => w.unregister()))
  } catch {
    // Opaque origin (file://): no caches.
  }
}

const webApi: Api = {
  openFile,
  openFiles: (filter) => pickFiles(true, filter),
  initialFile: async () => {
    const [last] = await loadRecent()
    return last ? readRecent(last, false) : null
  },
  saveFile,
  changedOnDisk,
  readPicked,
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
  clearStorage,
  readWorkspace,
  saveExport: (name, dataUrl) => {
    downloadUrl(name, dataUrl)
    return Promise.resolve(name)
  },
  outputDir: fs.showDirectoryPicker ? outputDir : undefined,
  templateDir: fs.showDirectoryPicker ? templateDir : undefined
}

export function installWebApi(): void {
  window.api = webApi
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault()
  })
}
