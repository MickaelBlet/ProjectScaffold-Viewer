import {
  formatFromPath,
  fromFile,
  LoadError,
  loadText,
  parseText,
  reloadText,
  sameContent,
  saveText,
  type Format
} from '@/model/serialize'
import { hasErrors, validate } from '@/model/validate'
import { arrange, arrangeOptions } from '@/model/autoLayout'
import type { Project } from '@/model/types'
import {
  activeDoc,
  addDoc,
  createDoc,
  findDoc,
  isDocDirty,
  isPristine,
  patchDoc,
  projectListeners,
  removeDoc,
  replaceDoc,
  useDocs,
  activateDoc,
  type DocState
} from '@/store/documents'
import { useSettings } from '@/store/settings'
import { setStatus, showDialog, useUiStore } from '@/store/ui'
import type { DiagramAction } from '../../../vscode/src/protocol'
import type { OpenResult, Session } from './api'

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function docTitle(d: DocState): string {
  return d.filePath ? fileName(d.filePath) : 'Untitled'
}

export function isDirty(): boolean {
  return isDocDirty(activeDoc())
}

export function anyDirty(): boolean {
  return useDocs.getState().docs.some(isDocDirty)
}

/** Show a loaded project: in place of a pristine Untitled tab, else in a new tab. */
function showLoaded(project: Project, filePath: string | null): DocState {
  const doc = createDoc(project, filePath)
  const current = activeDoc()
  if (isPristine(current)) replaceDoc(current.id, doc)
  else addDoc(doc)
  return doc
}

export function newProject(): void {
  addDoc(createDoc())
}

/** Opens the given file, or the files picked in an open dialog. */
export async function openProject(file?: OpenResult | null): Promise<void> {
  if (file === undefined) {
    for (const f of await window.api.openFiles()) await openProject(f)
    return
  }
  if (!file) return
  const already = useDocs.getState().docs.find((d) => d.filePath === file.path)
  if (already && isDocDirty(already)) {
    activateDoc(already.id)
    setStatus('info', `${file.path} is already open with unsaved changes`)
    return
  }
  try {
    const data = parseText(file.content, formatFromPath(file.path))
    const project = fromFile(data)
    let doc: DocState
    if (already) {
      doc = { ...createDoc(project, file.path), layout: already.layout }
      replaceDoc(already.id, doc)
    } else doc = showLoaded(project, file.path)
    setStatus('info', `Opened ${file.path}`)
    const hasLayout = !!(data as { editor?: unknown }).editor
    if (!hasLayout && project.modules.length && useSettings.getState().autoLayoutOnOpen)
      void arrangeLoaded(doc.id)
  } catch (e) {
    showDialog(`Cannot open ${file.path}`, e instanceof LoadError ? e.problems : [String(e)])
  }
}

/** Arrange a freshly loaded document without layout; the result counts as its saved state. */
async function arrangeLoaded(docId: string): Promise<void> {
  const doc = findDoc(docId)
  if (!doc) return
  const before = doc.store.getState().project
  const project = await arrange(before, null, arrangeOptions(before.orientation))
  const now = findDoc(docId)
  if (!now || now.store.getState().project !== before) return
  now.store.setState({ project })
  now.store.temporal.getState().clear()
  patchDoc((d) => ({ savedProject: project, viewEpoch: d.viewEpoch + 1 }), docId)
}

export async function openRecentProject(path: string): Promise<void> {
  const open = useDocs.getState().docs.find((d) => d.filePath === path)
  if (open) return activateDoc(open.id)
  const file = await window.api.openRecent(path)
  if (file) await openProject(file)
  else
    showDialog(`Cannot open ${path}`, [
      'The file cannot be read anymore. It was removed from recent documents.'
    ])
}

export function closeDocument(id: string = useDocs.getState().activeId): void {
  const doc = findDoc(id)
  if (!doc) return
  if (isDocDirty(doc) && !window.confirm(`Discard unsaved changes to ${docTitle(doc)}?`)) return
  removeDoc(id)
}

export function closeOtherDocuments(id: string): void {
  for (const d of useDocs.getState().docs) if (d.id !== id) closeDocument(d.id)
}

/** Open documents to keep across page reloads. */
export function currentSession(): Session {
  const { docs, activeId } = useDocs.getState()
  return {
    docs: docs.map((d) => ({
      path: d.filePath,
      content: isDocDirty(d) ? saveText(d.store.getState().project, 'json', { editor: true }) : null,
      ui: d.layout ?? undefined
    })),
    active: Math.max(
      0,
      docs.findIndex((d) => d.id === activeId)
    )
  }
}

/** Reopen the documents of the previous page load; unsaved edits stay unsaved. */
export async function restoreSession(session: Session): Promise<boolean> {
  const docs: DocState[] = []
  let active: DocState | undefined
  for (const [i, sd] of session.docs.entries()) {
    try {
      let doc: DocState
      if (sd.content !== null) {
        doc = { ...createDoc(loadText(sd.content, 'json'), sd.path), savedProject: null }
      } else if (sd.path) {
        const file = await window.api.reopen(sd.path)
        if (!file) continue
        doc = createDoc(loadText(file.content, formatFromPath(file.path)), file.path)
      } else continue
      doc.layout = sd.ui ?? null
      docs.push(doc)
      if (i === session.active) active = doc
    } catch {
      // Unreadable document: dropped.
    }
  }
  if (!docs.length) return false
  useDocs.setState({ docs, activeId: (active ?? docs[0]!).id })
  if (docs.some((d) => !d.savedProject)) setStatus('info', 'Restored unsaved changes')
  return true
}

let checking = false

/** Reload the documents whose file was changed by another program. */
export async function checkDiskChanges(): Promise<void> {
  if (checking) return
  checking = true
  try {
    for (const { id, filePath } of useDocs.getState().docs) {
      if (!filePath) continue
      const content = await window.api.changedOnDisk(filePath)
      const doc = findDoc(id)
      if (content !== null && doc?.filePath === filePath) reloadFromDisk(doc, content)
    }
  } finally {
    checking = false
  }
}

/** The project of a document's new file content, or null when it cannot be read (status shown). */
function reloaded(doc: DocState, content: string, what: string): Project | null {
  try {
    const project = reloadText(content, formatFromPath(doc.filePath!), doc.store.getState().project)
    clearReadError()
    return project
  } catch (e) {
    showReadError(`${docTitle(doc)} ${what}`, e)
    return null
  }
}

/** Status telling that a file text cannot be read: cleared once it can (fixed in another editor). */
let readError: unknown = null

function showReadError(what: string, e: unknown): void {
  const problems = e instanceof LoadError ? e.problems : [String(e)]
  setStatus('error', `${what}: ${problems[0] ?? ''}`)
  readError = useUiStore.getState().status
}

/** Clears the read error unless another status replaced it. */
function clearReadError(): void {
  if (readError && useUiStore.getState().status === readError) useUiStore.setState({ status: null })
  readError = null
}

/** Replace a document's project with its file's new content, in one undo step. */
function reloadFromDisk(doc: DocState, content: string): void {
  const name = docTitle(doc)
  const current = doc.store.getState().project
  const project = reloaded(doc, content, 'changed on disk but cannot be read')
  if (!project) return
  if (sameContent(project, current)) {
    patchDoc({ savedProject: current }, doc.id)
    return
  }
  if (isDocDirty(doc) && !window.confirm(`${name} changed on disk. Reload it and lose your unsaved changes?`))
    return
  doc.store.setState({ project })
  patchDoc({ savedProject: project }, doc.id)
  setStatus('info', `Reloaded ${name}: changed on disk`)
}

/** Delay before a project change is written to the VS Code document: a drag is one undo step. */
const HOST_SYNC_MS = 150
let hostSync: ReturnType<typeof setTimeout> | undefined

/** VS Code: writes the project to the document text unless it is the text's project already. */
function pushToHost(): void {
  hostSync = undefined
  const doc = activeDoc()
  const project = doc.store.getState().project
  if (!doc.filePath || project === doc.savedProject) return
  window.api.updateText?.(saveText(project, formatFromPath(doc.filePath), { editor: true }))
  // Unsaved edits are the document's: VS Code shows them.
  patchDoc({ savedProject: project }, doc.id)
}

/** VS Code: project changes are written to the document text, which VS Code undoes and saves. */
export function installHostSync(): () => void {
  const schedule = (): void => {
    clearTimeout(hostSync)
    hostSync = setTimeout(pushToHost, HOST_SYNC_MS)
  }
  projectListeners.add(schedule)
  window.addEventListener('blur', flush)
  return () => {
    projectListeners.delete(schedule)
    window.removeEventListener('blur', flush)
    clearTimeout(hostSync)
  }
}

/** VS Code: writes a project change not written yet. */
function flush(): void {
  if (hostSync === undefined) return
  clearTimeout(hostSync)
  pushToHost()
}

/** VS Code side panel: asks the diagram for an action, once it has the changes made here. */
export function sendToDiagram(action: DiagramAction): void {
  flush()
  window.api.inDiagram?.(action)
}

/** VS Code side panel: shows another project document (none when its path is empty). */
export function showHostDocument(file: OpenResult): void {
  // Pending changes go to the previous document (the edit names it).
  flush()
  let doc = createDoc()
  if (file.path) {
    try {
      doc = createDoc(loadText(file.content, formatFromPath(file.path)), file.path)
      clearReadError()
    } catch (e) {
      doc = createDoc(undefined, file.path)
      showReadError(`${fileName(file.path)} cannot be read`, e)
    }
  }
  useDocs.setState({ docs: [doc], activeId: doc.id })
}

/** VS Code: the document text changed outside the page (undo, text editor, file on disk). */
export function applyHostText(content: string): void {
  // The text wins over a change not written yet.
  clearTimeout(hostSync)
  hostSync = undefined
  const doc = activeDoc()
  if (!doc.filePath) return
  const current = doc.store.getState().project
  const project = reloaded(doc, content, 'cannot be read')
  if (!project) return
  if (!sameContent(project, current)) doc.store.setState({ project })
  // The page's project now matches the text: not written back.
  patchDoc({ savedProject: doc.store.getState().project }, doc.id)
}

/** Save the active project file (export format + editor layout). */
export async function saveProject(saveAs = false): Promise<void> {
  const doc = activeDoc()
  const { filePath } = doc
  const project = doc.store.getState().project
  const format: Format = filePath ? formatFromPath(filePath) : 'yaml'
  const path = await window.api.saveFile({
    path: saveAs ? null : filePath,
    content: saveText(project, format, { editor: true }),
    defaultName: `${project.name || 'project'}.scaffold.yaml`,
    format,
    title: 'Save project'
  })
  if (!path) return
  // Saving as .json from the dialog: rewrite in the matching format.
  if (formatFromPath(path) !== format) {
    await window.api.saveFile({
      path,
      content: saveText(project, formatFromPath(path), { editor: true }),
      defaultName: path,
      format: formatFromPath(path)
    })
  }
  patchDoc({ filePath: path, savedProject: project }, doc.id)
  if (window.api.writesFiles) setStatus('info', `Saved ${path}`)
  else
    setStatus(
      'info',
      `Downloaded ${path}: this browser cannot write files, use Chrome or Edge to save in place`
    )
}

export async function saveAll(): Promise<void> {
  const { activeId } = useDocs.getState()
  for (const d of useDocs.getState().docs) {
    if (!isDocDirty(d)) continue
    activateDoc(d.id)
    await saveProject()
  }
  activateDoc(activeId)
}

/** Export for generators: no editor data, blocked on validation errors. */
export async function exportProject(format: Format): Promise<void> {
  const project = activeDoc().store.getState().project
  const problems = validate(project)
  if (hasErrors(problems)) {
    showDialog(
      'Export blocked: fix these errors first',
      problems.filter((p) => p.severity === 'error').map((p) => p.message)
    )
    return
  }
  const path = await window.api.saveFile({
    path: null,
    content: saveText(project, format, { editor: false }),
    defaultName: `${project.name || 'project'}.${format}`,
    format,
    title: `Export ${format.toUpperCase()}`,
    export: true
  })
  if (path) setStatus('info', `Exported ${path}`)
}
