import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { addModuleAtViewCenter, Canvas } from './canvas/Canvas'
import { Sidebar } from './panels/Sidebar'
import { Inspector } from './panels/Inspector'
import { ProblemsPanel } from './panels/ProblemsPanel'
import { RecentMenu } from './components/RecentMenu'
import {
  currentDraft,
  exportProject,
  fileName,
  newProject,
  openProject,
  openRecentProject,
  restoreDraft,
  saveProject
} from './fileOps'
import { deleteLink, deleteModule, redo, undo, useProjectStore } from './store/project'
import { select, useUiStore } from './store/ui'
import { validate } from './model/validate'
import type { MenuAction } from '../../preload/api'

function isEditable(el: Element | null): boolean {
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      (el as HTMLElement).isContentEditable)
  )
}

function run(action: MenuAction): void {
  switch (action) {
    case 'new':
      return newProject()
    case 'open':
      return void openProject()
    case 'save':
      return void saveProject()
    case 'save-as':
      return void saveProject(true)
    case 'export-yaml':
      return void exportProject('yaml')
    case 'export-json':
      return void exportProject('json')
    case 'undo':
      // Inside a text field, undo the typing instead of the model.
      if (isEditable(document.activeElement)) document.execCommand('undo')
      else undo()
      return
    case 'redo':
      if (isEditable(document.activeElement)) document.execCommand('redo')
      else redo()
      return
    case 'add-module':
      return select({ kind: 'module', id: addModuleAtViewCenter() })
  }
}

export function App(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const { filePath, savedProject, status, dialog } = useUiStore()
  const problems = useMemo(() => validate(project), [project])
  const dirty = savedProject !== project
  // The draft is only written once the startup document is loaded, not to overwrite it.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    useUiStore.setState({ savedProject: useProjectStore.getState().project })
    void (async () => {
      const draft = await window.api.loadDraft?.()
      if (!draft || !restoreDraft(draft)) {
        const file = await window.api.initialFile()
        if (file) await openProject(file)
      }
      setLoaded(true)
    })()
    void window.api.recentFiles().then((recent) => useUiStore.setState({ recent }))
    const off = [
      window.api.onMenu(run),
      window.api.onOpenRecent((path) => void openRecentProject(path)),
      window.api.onRecentChange((recent) => useUiStore.setState({ recent }))
    ]
    return () => off.forEach((f) => f())
  }, [])

  useEffect(() => {
    window.api.setDirty(dirty)
    const file = filePath ? fileName(filePath) : 'Untitled'
    document.title = `${dirty ? '• ' : ''}${file} — ProjectScaffold`
  }, [dirty, filePath])

  useEffect(() => {
    const { saveDraft } = window.api
    if (!loaded || !saveDraft) return
    const flush = (): void => saveDraft(currentDraft())
    const timer = setTimeout(flush, 300)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', flush)
    }
  }, [loaded, project, savedProject, filePath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditable(document.activeElement)) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const sel = useUiStore.getState().selection
      if (sel?.kind === 'module') deleteModule(sel.id)
      else if (sel?.kind === 'link') deleteLink(sel.id)
      else return
      select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">ProjectScaffold</strong>
        <button type="button" onClick={() => run('new')}>
          New
        </button>
        <button type="button" onClick={() => run('open')}>
          Open…
        </button>
        <RecentMenu />
        <button type="button" onClick={() => run('save')}>
          Save
        </button>
        <span className="sep" />
        <button type="button" onClick={() => run('add-module')}>
          + Module
        </button>
        <span className="sep" />
        <button type="button" onClick={() => run('undo')} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button type="button" onClick={() => run('redo')} title="Redo (Ctrl+Y)">
          ↷
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => select({ kind: 'project' })} className="link-button">
          {project.name || 'Untitled'}
        </button>
        <span className="sep" />
        <button type="button" className="primary" onClick={() => run('export-yaml')}>
          Export YAML
        </button>
        <button type="button" className="primary" onClick={() => run('export-json')}>
          Export JSON
        </button>
      </header>
      <Sidebar />
      <main className="center">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
        <ProblemsPanel problems={problems} />
      </main>
      <Inspector />
      <footer className={`statusbar ${status?.kind ?? ''}`}>
        <span>{status?.text ?? 'Ready'}</span>
        <span>
          {filePath ?? 'Unsaved project'}
          {dirty ? ' (modified)' : ''}
        </span>
      </footer>
      {dialog && (
        <div className="modal-backdrop" onClick={() => useUiStore.setState({ dialog: null })}>
          <div className="modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <h3>{dialog.title}</h3>
            <ul>
              {dialog.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <button type="button" autoFocus onClick={() => useUiStore.setState({ dialog: null })}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
