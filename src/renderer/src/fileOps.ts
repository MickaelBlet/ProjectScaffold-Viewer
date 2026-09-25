import {
  formatFromPath,
  fromFile,
  LoadError,
  loadText,
  parseText,
  saveText,
  type Format
} from '@/model/serialize'
import { hasErrors, validate } from '@/model/validate'
import { arrange } from '@/model/autoLayout'
import type { Project } from '@/model/types'
import {
  activeDoc,
  addDoc,
  createDoc,
  findDoc,
  isDocDirty,
  isPristine,
  patchDoc,
  removeDoc,
  replaceDoc,
  useDocs,
  activateDoc,
  type DocState
} from '@/store/documents'
import { useSettings } from '@/store/settings'
import { setStatus, showDialog } from '@/store/ui'
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

export async function openProject(file?: OpenResult | null): Promise<void> {
  if (file === undefined) file = await window.api.openFile()
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
  const project = await arrange(before, null)
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
  setStatus('info', `Saved ${path}`)
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
