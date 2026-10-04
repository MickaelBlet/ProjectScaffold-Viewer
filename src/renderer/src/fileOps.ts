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
import { arrange, arrangeOptions } from '@/model/autoLayout'
import { baseName } from '@/model/sync'
import type { Project } from '@/model/types'
import {
  isWorkspaceData,
  WORKSPACE_SUFFIX,
  workspaceFromFile,
  workspaceText,
  type Workspace
} from '@/model/workspace'
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
import { parseSettings, settingsText, useSettings } from '@/store/settings'
import { dirtyFiles, dropDocTextFiles } from '@/store/textFiles'
import { log } from '@/store/output'
import { FULL_LAYOUT } from '@/host'
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

/** Some document or text file (template, generated file...) holds unsaved changes. */
export function anyDirty(): boolean {
  return useDocs.getState().docs.some(isDocDirty) || dirtyFiles().length > 0
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

const problemsOf = (e: unknown): string[] => (e instanceof LoadError ? e.problems : [String(e)])

const openDoc = (path: string): DocState | undefined =>
  useDocs.getState().docs.find((d) => d.filePath === path)

/** Opens the given file, or the files picked in an open dialog; a workspace file opens its projects. */
export async function openProject(file?: OpenResult | null): Promise<void> {
  if (file === undefined) {
    for (const f of await window.api.openFiles()) await openProject(f)
    return
  }
  if (!file) return
  try {
    const data = parseText(file.content, formatFromPath(file.path))
    if (isWorkspaceData(data)) return await openWorkspace(file.path, workspaceFromFile(data))
    const already = openDoc(file.path)
    if (already && isDocDirty(already)) {
      activateDoc(already.id)
      setStatus('info', `${file.path} is already open with unsaved changes`)
      return
    }
    showProject(file.path, data)
    setStatus('info', `Opened ${file.path}`)
  } catch (e) {
    showDialog(`Cannot open ${file.path}`, problemsOf(e))
  }
}

/** Shows a project file's data: in its tab when open, else as a loaded project. */
function showProject(path: string, data: unknown): DocState {
  const project = fromFile(data)
  const already = openDoc(path)
  let doc: DocState
  if (already) {
    doc = { ...createDoc(project, path), layout: already.layout }
    replaceDoc(already.id, doc)
  } else doc = showLoaded(project, path)
  const hasLayout = !!(data as { editor?: unknown }).editor
  if (!hasLayout && project.modules.length && useSettings.getState().autoLayoutOnOpen)
    void arrangeLoaded(doc.id)
  return doc
}

/** Workspace last opened or saved: Save workspace rewrites it. */
let workspace: { path: string; ws: Workspace } | null = null

/** Opens the projects of a workspace file, each in its tab; the first one is shown. */
async function openWorkspace(path: string, ws: Workspace): Promise<void> {
  if (!window.api.readWorkspace)
    throw new Error('Workspaces cannot be opened here: open its projects one by one')
  const files = await window.api.readWorkspace(path, ws.projects)
  if (!files) return
  const problems: string[] = []
  let first: DocState | undefined
  for (const [i, file] of files.entries()) {
    const name = ws.projects[i]!
    if (!file) {
      problems.push(`${name}: cannot be read`)
      continue
    }
    const already = openDoc(file.path)
    if (already && isDocDirty(already)) {
      problems.push(`${name}: already open with unsaved changes, kept`)
      first ??= already
      continue
    }
    try {
      const doc = showProject(file.path, parseText(file.content, formatFromPath(file.path)))
      first ??= doc
    } catch (e) {
      problems.push(...problemsOf(e).map((p) => `${name}: ${p}`))
    }
  }
  workspace = { path, ws }
  if (first) activateDoc(first.id)
  const opened = `Opened workspace ${ws.name}: ${files.filter(Boolean).length} of ${ws.projects.length} projects`
  if (problems.length) showDialog(opened, problems)
  else setStatus('info', opened)
}

/**
 * Saves the open project files as a workspace: into the workspace last opened or saved, or (`saveAs`,
 * or none yet) into a file picked in a save dialog. Unsaved projects are left out.
 */
export async function saveWorkspace(saveAs = false): Promise<void> {
  const { docs } = useDocs.getState()
  const saved = docs.flatMap((d) => (d.filePath ? [d.filePath] : []))
  if (!saved.length)
    return showDialog('No project file to list in a workspace', [
      'A workspace lists project files: save the open projects first.'
    ])
  const known = new Set(workspace?.ws.projects)
  // Paths are file names, or paths in the workspace folder for projects read from it.
  const projects = saved.map((path) => (known.has(path) ? path : baseName(path)))
  const ws: Workspace = {
    ...(workspace?.ws ?? { name: docs[0]!.store.getState().project.name || 'Workspace' }),
    projects
  }
  const path = await window.api.saveFile({
    path: saveAs ? null : (workspace?.path ?? null),
    content: workspaceText(ws),
    defaultName: `${ws.name.replace(/[^\w.-]+/g, '_') || 'workspace'}${WORKSPACE_SUFFIX}`,
    format: 'yaml',
    title: 'Save workspace'
  })
  if (!path) return
  workspace = { path, ws }
  const skipped = docs.length - saved.length
  setStatus(
    'info',
    `Saved workspace ${path}: ${projects.length} projects${skipped ? `, ${skipped} unsaved left out` : ''}`
  )
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
  const files = dirtyFiles(id).map((f) => fileName(f.path))
  const unsaved = [...(isDocDirty(doc) ? [docTitle(doc)] : []), ...files]
  if (unsaved.length && !window.confirm(`Discard unsaved changes to ${unsaved.join(', ')}?`)) return
  removeDoc(id)
  dropDocTextFiles(id)
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
    clearReadError(docTitle(doc))
    return project
  } catch (e) {
    showReadError(docTitle(doc), what, e)
    return null
  }
}

/** Status telling that a file text cannot be read: replaced once it can (fixed in another editor). */
let readError: { name: string; status: unknown } | null = null

function showReadError(name: string, what: string, e: unknown): void {
  const problems = e instanceof LoadError ? e.problems : [String(e)]
  setStatus('error', `${name} ${what}: ${problems[0] ?? ''}`)
  readError = { name, status: useUiStore.getState().status }
}

/** Tells that the file `name` can be read again, in the status bar unless another status replaced it. */
function clearReadError(name: string): void {
  if (readError?.name !== name) return
  const text = `${name} can be read again`
  if (useUiStore.getState().status === readError.status) setStatus('info', text)
  else log('info', 'app', text)
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

/** VS Code full diagram editor: switches the editors to the other layout; they load again, showing
 *  what this one shows (its session) with the changes made here. */
export function switchEditorLayout(): void {
  flush()
  window.api.saveSession(currentSession())
  window.api.setLayout?.(FULL_LAYOUT ? 'integrated' : 'full')
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
      clearReadError(fileName(file.path))
    } catch (e) {
      doc = createDoc(undefined, file.path)
      showReadError(fileName(file.path), 'cannot be read', e)
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

const SETTINGS_FILES = { description: 'Settings', extensions: ['json'] }

export async function exportSettings(): Promise<void> {
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(settingsText())}`
  const saved = await window.api.saveExport('project-scaffold.settings.json', url)
  if (saved) setStatus('info', `Exported settings to ${saved}`)
}

/** Takes the valid settings of a settings file; the others keep their value. */
export async function importSettings(): Promise<void> {
  let path = ''
  try {
    const [file] = await window.api.openFiles(SETTINGS_FILES)
    if (!file) return
    path = file.path
    const settings = parseSettings(file.content)
    const count = Object.keys(settings).length
    if (!count)
      return showDialog(`No setting in ${fileName(path)}`, ['Export settings to get a settings file.'])
    useSettings.setState(settings)
    setStatus('info', `Imported ${count} settings from ${fileName(path)}`)
  } catch (e) {
    showDialog(`Cannot import settings${path ? ` from ${fileName(path)}` : ''}`, [
      e instanceof Error ? e.message : String(e)
    ])
  }
}
