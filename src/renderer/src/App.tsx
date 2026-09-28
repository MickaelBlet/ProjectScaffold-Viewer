import { useEffect, useState, type ReactNode } from 'react'
import { DockShell } from './shell/DockShell'
import { MenuBar } from './shell/MenuBar'
import { ResizeEdges, WindowControls } from './shell/WindowFrame'
import { StatusBar } from './shell/StatusBar'
import { ContextMenu } from './components/ContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { anyDirty, currentSession, docTitle, openProject, restoreSession } from './fileOps'
import { installClipboard, installKeyboard, runCommand } from './commands'
import { activeDoc, isDocDirty, useDocs } from './store/documents'
import { applyForceAnimations, applyPortStyle, applyTheme, useSettings } from './store/settings'
import { useProjectStore } from './store/project'
import { useUiStore } from './store/ui'
import { Icon } from '@/components/Icon'

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
  const forceAnimations = useSettings((s) => s.forceAnimations)
  const portStyle = useSettings((s) => s.portStyle)
  // The session is only written once the startup documents are loaded, not to overwrite them.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => applyForceAnimations(forceAnimations), [forceAnimations])
  useEffect(() => applyPortStyle(portStyle), [portStyle])

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
        <svg className="brand" viewBox="0 0 32 32" role="img" aria-label="ProjectScaffold">
          <title>ProjectScaffold</title>
          <rect width="32" height="32" rx="7" fill="#3b6fe0" />
          <path
            d="M15 10h7v8"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="5" y="5" width="10" height="10" rx="2" fill="#fff" />
          <rect x="17" y="17" width="10" height="10" rx="2" fill="#fff" />
          <circle cx="15" cy="10" r="2" fill="#3b6fe0" stroke="#fff" strokeWidth="1.5" />
          <circle cx="22" cy="17" r="2" fill="#3b6fe0" stroke="#fff" strokeWidth="1.5" />
        </svg>
        <MenuBar />
        <span className="sep" />
        <ToolbarButton command="insert.module" title="Add module (Ctrl+M)">
          <Icon name="plus" /> Module
        </ToolbarButton>
        <ToolbarButton command="arrange.auto" title="Auto-arrange (Ctrl+Alt+L)">
          <Icon name="arrange" /> Arrange
        </ToolbarButton>
        <span className="sep" />
        <ToolbarButton command="edit.undo" title="Undo (Ctrl+Z)">
          <Icon name="undo" />
        </ToolbarButton>
        <ToolbarButton command="edit.redo" title="Redo (Ctrl+Y)">
          <Icon name="redo" />
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
        <WindowControls />
      </header>
      <DockShell />
      <StatusBar />
      <ContextMenu />
      <CommandPalette />
      <ShortcutsDialog />
      <Dialog />
      <ResizeEdges />
    </div>
  )
}
