import { useEffect, useState, type ReactNode } from 'react'
import { DockShell } from './shell/DockShell'
import { MenuBar } from './shell/MenuBar'
import { StatusBar } from './shell/StatusBar'
import { ContextMenu } from './components/ContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { RecentMenu } from './components/RecentMenu'
import { anyDirty, currentSession, docTitle, openProject, restoreSession } from './fileOps'
import { installClipboard, installKeyboard, runCommand } from './commands'
import { activeDoc, isDocDirty, useDocs } from './store/documents'
import { applyTheme, useSettings } from './store/settings'
import { useProjectStore } from './store/project'
import { useUiStore } from './store/ui'

function Dialog(): ReactNode {
  const dialog = useUiStore((s) => s.dialog)
  if (!dialog) return null
  const close = (): void => useUiStore.setState({ dialog: null })
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h3>{dialog.title}</h3>
        <ul>
          {dialog.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <button type="button" autoFocus onClick={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
          Close
        </button>
      </div>
    </div>
  )
}

function ToolbarButton({
  command,
  children,
  title,
  className
}: {
  command: string
  children: ReactNode
  title: string
  className?: string
}): ReactNode {
  return (
    <button type="button" className={className} title={title} onClick={() => runCommand(command)}>
      {children}
    </button>
  )
}

export function App(): ReactNode {
  const docs = useDocs((s) => s.docs)
  const project = useProjectStore((s) => s.project)
  const theme = useSettings((s) => s.theme)
  // The session is only written once the startup documents are loaded, not to overwrite them.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    void (async () => {
      const session = await window.api.loadSession()
      if (!session || !(await restoreSession(session))) {
        const file = await window.api.initialFile()
        if (file) await openProject(file)
      }
      setLoaded(true)
    })()
    void window.api.recentFiles().then((recent) => useUiStore.setState({ recent }))
    const off = [
      window.api.onRecentChange((recent) => useUiStore.setState({ recent })),
      installKeyboard(),
      installClipboard()
    ]
    return () => off.forEach((f) => f())
  }, [])

  // Title and unload warning follow the documents.
  useEffect(() => {
    const doc = activeDoc()
    window.api.setDirty(anyDirty())
    document.title = `${isDocDirty(doc) ? '• ' : ''}${docTitle(doc)} — ProjectScaffold`
  }, [docs, project])

  useEffect(() => {
    if (!loaded) return
    const flush = (): void => window.api.saveSession(currentSession())
    const timer = setTimeout(flush, 300)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', flush)
    }
  }, [loaded, docs, project])

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">ProjectScaffold</strong>
        <MenuBar />
        <span className="sep" />
        <ToolbarButton command="file.open" title="Open (Ctrl+O)">
          Open…
        </ToolbarButton>
        <RecentMenu />
        <ToolbarButton command="file.save" title="Save (Ctrl+S)">
          Save
        </ToolbarButton>
        <span className="sep" />
        <ToolbarButton command="insert.module" title="Add module (Ctrl+M)">
          + Module
        </ToolbarButton>
        <ToolbarButton command="arrange.auto" title="Auto-arrange (Ctrl+Alt+L)">
          ⊞ Arrange
        </ToolbarButton>
        <span className="sep" />
        <ToolbarButton command="edit.undo" title="Undo (Ctrl+Z)">
          ↶
        </ToolbarButton>
        <ToolbarButton command="edit.redo" title="Redo (Ctrl+Y)">
          ↷
        </ToolbarButton>
        <span className="spacer" />
        <button
          type="button"
          className="palette-button"
          title="Command palette (Ctrl+Shift+P)"
          onClick={() => runCommand('view.goto')}
        >
          Go to… <kbd>Ctrl+P</kbd>
        </button>
        <span className="spacer" />
        <ToolbarButton command="file.exportYaml" title="Export YAML (Ctrl+E)" className="primary">
          Export YAML
        </ToolbarButton>
        <ToolbarButton command="file.exportJson" title="Export JSON (Ctrl+Shift+E)" className="primary">
          Export JSON
        </ToolbarButton>
      </header>
      <DockShell />
      <StatusBar />
      <ContextMenu />
      <CommandPalette />
      <ShortcutsDialog />
      <Dialog />
    </div>
  )
}
