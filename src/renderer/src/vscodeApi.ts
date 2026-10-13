// VS Code webview implementation of the file API (extension: ProjectScaffold-VsCode, src/session.ts).
// The page edits a single document: VS Code owns its text, dirty state and file. A side panel
// (IN_PANEL) changes document with the active project document.
// Project changes are written to the text (see installHostSync in fileOps.ts); text changes made
// elsewhere come back through onExternalChange.
import type { DiagramAction, SidePanel, ToHost, ToPage, ViewRef } from '@/vscodeProtocol'
import type { Api, OpenResult, Session } from './api'
import { IN_PANEL, IN_PREVIEW, vscode } from './host'
import { storageChanged } from './storage'

const post = (msg: ToHost): void => vscode!.postMessage(msg)

let nextId = 1
const pending = new Map<number, (result: unknown) => void>()

/** Posts a message expecting a reply. */
function request<T>(make: (id: number) => ToHost): Promise<T> {
  const id = nextId++
  return new Promise((done) => {
    pending.set(id, (result) => done(result as T))
    post(make(id))
  })
}

const externalListeners = new Set<(text: string) => void>()
const commandListeners = new Set<(id: string) => void>()
const revealListeners = new Set<
  (path: (string | number)[], names: (string | undefined)[], cursor: boolean) => void
>()
const documentListeners = new Set<(file: OpenResult) => void>()
const viewListeners = new Set<(view: ViewRef) => void>()
const actionListeners = new Set<(action: DiagramAction) => void>()
const showPanelListeners = new Set<(panel: SidePanel) => void>()
/** Latest text received while the document was still loading. */
let unheard: string | null = null

function listen<T>(set: Set<T>, cb: T): () => void {
  set.add(cb)
  return () => set.delete(cb)
}

function onMessage(e: MessageEvent<ToPage | null>): void {
  // VS Code's frame around the page relays the extension's messages, from the page's origin: no other
  // window is heard. Not by `window.parent`: VS Code sets it to the page's own window.
  if (e.origin !== window.location.origin || e.source === window) return
  const msg = e.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'update':
      if (externalListeners.size) externalListeners.forEach((cb) => cb(msg.text))
      else unheard = msg.text
      break
    case 'run':
      commandListeners.forEach((cb) => cb(msg.command))
      break
    case 'storage':
      storageChanged(msg.key, msg.value)
      break
    case 'reveal':
      revealListeners.forEach((cb) => cb(msg.path, msg.names, msg.cursor))
      break
    case 'document': {
      // The listeners write pending changes to the previous document first (see showHostDocument).
      const file = { path: msg.path, content: msg.text }
      unheard = null
      documentListeners.forEach((cb) => cb(file))
      current = { path: msg.path, uri: msg.uri, content: msg.text }
      break
    }
    case 'view':
      viewListeners.forEach((cb) => cb(msg.view))
      break
    case 'action':
      actionListeners.forEach((cb) => cb(msg.action))
      break
    case 'showPanel':
      showPanelListeners.forEach((cb) => cb(msg.panel))
      break
    case 'reply':
      pending.get(msg.id)?.(msg.result)
      pending.delete(msg.id)
      break
  }
}

/** Splits a data: URL into its payload and encoding. */
function dataUrlPayload(url: string): { data: string; encoding: 'utf8' | 'base64' } {
  const comma = url.indexOf(',')
  const meta = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  return meta.endsWith(';base64')
    ? { data: payload, encoding: 'base64' }
    : { data: decodeURIComponent(payload), encoding: 'utf8' }
}

/** Document shown: the initial one, or the one a side panel was given since. Set by installVscodeApi:
 *  scaffoldInit only exists in VS Code, and this module is loaded everywhere. */
let current = { path: '', uri: '', content: '' }

function currentDoc(): OpenResult {
  return { path: current.path, content: current.content }
}

const vscodeApi: Api = {
  openFile: () => request((id) => ({ type: 'openFile', id })),
  // The page has a single document: one project file at a time.
  openFiles: async (filter) => {
    if (filter) return request<OpenResult[]>((id) => ({ type: 'openFiles', id, filter }))
    const file = await request<OpenResult | null>((id) => ({ type: 'openFile', id }))
    return file ? [file] : []
  },
  initialFile: () => Promise.resolve(current.path ? currentDoc() : null),
  // VS Code keeps the recent files: the page has a single document.
  recentFiles: () => Promise.resolve([]),
  openRecent: () => Promise.resolve(null),
  // Session restore after the webview reloads: the document's editor layout.
  reopen: (path) => Promise.resolve(path === currentDoc().path ? currentDoc() : null),
  clearRecent: () => Promise.resolve(),
  onRecentChange: () => () => {},
  // Only the document: VS Code opens the other files in editors of their own.
  saveFile: (req) => {
    if (req.path !== current.path)
      return Promise.reject(new Error(`Cannot save ${req.path ?? 'a new file'} here`))
    post({ type: 'edit', text: req.content, uri: current.uri })
    post({ type: 'save' })
    return Promise.resolve(currentDoc().path)
  },
  // The extension sends text changes as they happen.
  changedOnDisk: () => Promise.resolve(null),
  writesFiles: true,
  // VS Code shows the dirty state and asks before closing.
  setDirty: () => {},
  // The text is VS Code's: only the editor layout is kept, and the document of a preview to restore.
  // A side panel starts afresh with the active document.
  saveSession: (session) => {
    if (IN_PANEL) return
    vscode!.setState({
      ...session,
      docs: session.docs.map((d) => ({ ...d, content: null })),
      uri: current.uri
    })
  },
  loadSession: () => Promise.resolve(IN_PANEL ? null : ((vscode!.getState() as Session | undefined) ?? null)),
  saveExport: (name, dataUrl) => request((id) => ({ type: 'export', id, name, ...dataUrlPayload(dataUrl) })),
  updateText: (text) => post({ type: 'edit', text, uri: current.uri }),
  selected: (path) => post({ type: 'selected', path }),
  readSibling: (file) => request((id) => ({ type: 'readSibling', id, file })),
  readFile: (path) => request((id) => ({ type: 'readFile', id, path })),
  openSibling: (file) => post({ type: 'openSibling', file }),
  onExternalChange: (cb) => {
    const off = listen(externalListeners, cb)
    if (unheard !== null) cb(unheard)
    unheard = null
    return off
  },
  onCommand: (cb) => {
    const off = listen(commandListeners, cb)
    // A diagram runs the commands asked for before it was loaded (Add Module from the text...).
    if (!IN_PANEL) post({ type: 'ready' })
    return off
  },
  onReveal: (cb) => listen(revealListeners, cb),
  inDiagram: (action) => post({ type: 'inDiagram', action }),
  onDocument: (cb) => {
    const off = listen(documentListeners, cb)
    // Documents sent before are lost: the extension sends the current one again.
    post({ type: 'ready' })
    return off
  },
  onView: (cb) => listen(viewListeners, cb),
  viewChanged: (view) => post({ type: 'view', view }),
  onAction: (cb) => listen(actionListeners, cb),
  showPanel: (panel) => post({ type: 'showPanel', panel }),
  onShowPanel: (cb) => listen(showPanelListeners, cb),
  setLayout: IN_PREVIEW ? (layout) => post({ type: 'setLayout', layout }) : undefined,
  log: (level, text) => post({ type: 'log', level, text })
}

export function installVscodeApi(): void {
  const init = window.scaffoldInit!
  current = { path: init.path, uri: init.uri, content: init.text }
  window.api = vscodeApi
  window.addEventListener('message', onMessage)
  // VS Code gives the app shortcuts to the page only while it has the focus (see package.json).
  window.addEventListener('focus', () => post({ type: 'focus', focused: true }))
  window.addEventListener('blur', () => post({ type: 'focus', focused: false }))
  if (document.hasFocus()) post({ type: 'focus', focused: true })
}
