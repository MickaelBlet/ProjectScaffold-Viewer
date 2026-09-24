import { emptyProject } from '@/model/project'
import { formatFromPath, LoadError, loadText, saveText, type Format } from '@/model/serialize'
import { hasErrors, validate } from '@/model/validate'
import { getProject, replaceProject } from '@/store/project'
import { setStatus, showDialog, useUiStore } from '@/store/ui'
import type { Draft, OpenResult } from '../../preload/api'

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function isDirty(): boolean {
  return useUiStore.getState().savedProject !== getProject()
}

function confirmDiscard(): boolean {
  return !isDirty() || window.confirm('Discard unsaved changes?')
}

function markSaved(filePath: string | null): void {
  useUiStore.setState((s) => ({
    filePath,
    savedProject: getProject(),
    selection: null,
    viewEpoch: s.viewEpoch + 1
  }))
}

export function newProject(): void {
  if (!confirmDiscard()) return
  replaceProject(emptyProject())
  markSaved(null)
}

export async function openProject(file?: OpenResult | null): Promise<void> {
  if (file === undefined) {
    if (!confirmDiscard()) return
    file = await window.api.openFile()
  }
  if (!file) return
  try {
    replaceProject(loadText(file.content, formatFromPath(file.path)))
    markSaved(file.path)
    setStatus('info', `Opened ${file.path}`)
  } catch (e) {
    showDialog(`Cannot open ${file.path}`, e instanceof LoadError ? e.problems : [String(e)])
  }
}

/** Unsaved edits to keep across page reloads, or null when there are none. */
export function currentDraft(): Draft | null {
  if (!isDirty()) return null
  return { path: useUiStore.getState().filePath, content: saveText(getProject(), 'json', { editor: true }) }
}

/** Restore the unsaved edits of the previous page load; they stay unsaved. */
export function restoreDraft(draft: Draft): boolean {
  try {
    replaceProject(loadText(draft.content, 'json'))
  } catch {
    return false
  }
  useUiStore.setState((s) => ({ filePath: draft.path, savedProject: null, viewEpoch: s.viewEpoch + 1 }))
  setStatus('info', 'Restored unsaved changes')
  return true
}

export async function openRecentProject(path: string): Promise<void> {
  if (!confirmDiscard()) return
  const file = await window.api.openRecent(path)
  if (file) await openProject(file)
  else showDialog(`Cannot open ${path}`, ['The file cannot be read anymore. It was removed from recent documents.'])
}

/** Save the project file (export format + editor layout). */
export async function saveProject(saveAs = false): Promise<void> {
  const { filePath } = useUiStore.getState()
  const project = getProject()
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
  useUiStore.setState({ filePath: path, savedProject: project })
  setStatus('info', `Saved ${path}`)
}

/** Export for generators: no editor data, blocked on validation errors. */
export async function exportProject(format: Format): Promise<void> {
  const project = getProject()
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
