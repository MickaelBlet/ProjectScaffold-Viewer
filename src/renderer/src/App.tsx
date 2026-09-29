import { useEffect, useId, useState, type ReactNode } from 'react'
import { DockShell } from './shell/DockShell'
import { MenuBar } from './shell/MenuBar'
import { ResizeEdges, WindowControls } from './shell/WindowFrame'
import { StatusBar } from './shell/StatusBar'
import { ContextMenu } from './components/ContextMenu'
import { CommandPalette } from './components/CommandPalette'
import { AboutDialog } from './components/AboutDialog'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import {
  anyDirty,
  applyHostText,
  checkDiskChanges,
  currentSession,
  docTitle,
  installHostSync,
  openProject,
  restoreSession,
  showHostDocument
} from './fileOps'
import { installClipboard, installKeyboard, runCommand } from './commands'
import { activeDoc, isDocDirty, useDoc, useDocs } from './store/documents'
import { applyForceAnimations, applyPortStyle, applyTheme, useSettings } from './store/settings'
import { useProjectStore } from './store/project'
import { useUiStore } from './store/ui'
import { Icon } from '@/components/Icon'
import { IN_PANEL, IN_PREVIEW, IN_VSCODE, SIDE_PANEL } from './host'
import {
  installSelectionSync,
  installViewSync,
  navigateToPath,
  runDiagramAction,
  showDiagramView
} from './actions'
import { toggleTool } from './shell/controllers'
import { ExplorerPanel } from './panels/ExplorerPanel'
import { ModulesPanel } from './panels/ModulesPanel'
import { LinksPanel } from './panels/LinksPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import type { SidePanel } from '../../../vscode/src/protocol'

/** How often open files are checked for changes made by other programs. */
const DISK_CHECK_MS = 2000

function Dialog(): ReactNode {
  const dialog = useUiStore((s) => s.dialog)
  const titleId = useId()
  if (!dialog) return null
  const close = (): void => useUiStore.setState({ dialog: null })
  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <h3 id={titleId}>{dialog.title}</h3>
        <ul>
          {dialog.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <button type="button" autoFocus onClick={close}>
          Close
        </button>
      </div>
    </div>
  )
}

const SIDE_PANELS: Record<SidePanel, () => ReactNode> = {
  explorer: ExplorerPanel,
  modules: ModulesPanel,
  links: LinksPanel,
  settings: SettingsPanel
}

/** A tool panel alone, in the VS Code side bar: it shows the active project document. */
function SidePanelView({ panel }: { panel: SidePanel }): ReactNode {
  const Content = SIDE_PANELS[panel]
  const filePath = useDoc((d) => d.filePath)
  return (
    <div className="app side-panel">
      {filePath || panel === 'settings' ? (
        <div className="tool-panel" data-panel={panel}>
          <Content />
        </div>
      ) : (
        <p className="side-panel-empty">Open a project file (*.scaffold.yaml) to see its content here.</p>
      )}
      <ContextMenu />
      <CommandPalette />
      <Dialog />
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

  useEffect(() => {
    applyTheme(theme)
    if (!IN_VSCODE) return
    // The VS Code color theme is the class of the body.
    const observer = new MutationObserver(() => applyTheme(theme))
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [theme])
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

  // VS Code: the document text follows the project, and the project the text.
  useEffect(() => {
    if (!loaded || !IN_VSCODE) return
    const off = [
      installHostSync(),
      window.api.onExternalChange!(applyHostText),
      window.api.onCommand!(runCommand),
      window.api.onReveal!(navigateToPath),
      installSelectionSync(),
      // A side panel follows the active document and the view of its diagram, which acts for it.
      ...(IN_PANEL
        ? [window.api.onDocument!(showHostDocument), window.api.onView!(showDiagramView)]
        : [
            window.api.onAction!((a) => (a.kind === 'command' ? runCommand(a.id) : runDiagramAction(a))),
            installViewSync()
          ])
    ]
    return () => off.forEach((f) => f())
  }, [loaded])

  // Files edited in another program are reloaded (VS Code sends the changes itself).
  useEffect(() => {
    if (IN_VSCODE) return
    const check = (): void => {
      if (document.visibilityState === 'visible') void checkDiskChanges()
    }
    const timer = setInterval(check, DISK_CHECK_MS)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
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

  if (SIDE_PANEL) return <SidePanelView panel={SIDE_PANEL} />
  return (
    <div className="app">
      {/* Moves the Tauri window; its buttons and menus stay clickable. */}
      <header className="toolbar" data-tauri-drag-region="deep">
        {/* The preview is compact: VS Code has the file commands, its palette the others. */}
        {!IN_PREVIEW && (
          <>
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
          </>
        )}
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
        {IN_PREVIEW && (
          <button type="button" title="Show or hide the Inspector" onClick={() => toggleTool('inspector')}>
            Inspector
          </button>
        )}
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
        {!IN_PREVIEW && (
          <>
            <ToolbarButton command="file.exportYaml" title="Export YAML (Ctrl+E)" className="primary">
              Export YAML
            </ToolbarButton>
            <ToolbarButton command="file.exportJson" title="Export JSON (Ctrl+Shift+E)" className="primary">
              Export JSON
            </ToolbarButton>
          </>
        )}
        <WindowControls />
      </header>
      <DockShell />
      <StatusBar />
      <ContextMenu />
      <CommandPalette />
      <ShortcutsDialog />
      <AboutDialog />
      <Dialog />
      <ResizeEdges />
    </div>
  )
}
