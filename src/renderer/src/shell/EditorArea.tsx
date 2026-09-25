// Center of the window: the document tabs, then the active document's views and editor tabs.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type SerializedDockview
} from 'dockview-react'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from '@/canvas/Canvas'
import { findView } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Project } from '@/model/types'
import { findDoc, patchDoc, useDocs } from '@/store/documents'
import { deleteView, renameView, useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { newView } from '@/actions'
import { TypeInspector } from '@/panels/TypeInspector'
import { InterfaceInspector } from '@/panels/InterfaceInspector'
import { ModuleInspector } from '@/panels/ModuleInspector'
import { LinkInspector } from '@/panels/LinkInspector'
import { DocTabs } from './DocTabs'
import { closeView, editorApi, openView, setEditorApi, type EditorKind } from './controllers'
import { dockTheme } from './theme'

function CanvasPanel(props: IDockviewPanelProps<{ viewId: Id }>): ReactNode {
  const { viewId } = props.params
  const exists = useProjectStore(
    (s) => viewId === GLOBAL_VIEW || s.project.views.some((v) => v.id === viewId)
  )
  const name = useProjectStore((s) => findView(s.project, viewId).name)
  const { api } = props
  // Hidden tabs keep no canvas: nothing to measure or keep in sync off screen.
  const [visible, setVisible] = useState(api.isVisible)
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible))
    return () => d.dispose()
  }, [api])
  useEffect(() => {
    if (!exists) api.close()
  }, [exists, api])
  useEffect(() => api.setTitle(name), [name, api])
  if (!exists || !visible) return null
  return (
    <ReactFlowProvider>
      <Canvas viewId={viewId} />
    </ReactFlowProvider>
  )
}

function entityName(p: Project, kind: EditorKind, id: Id): string | null {
  const list =
    kind === 'type' ? p.types : kind === 'interface' ? p.interfaces : kind === 'module' ? p.modules : p.links
  return list.find((e) => e.id === id)?.name ?? null
}

function EntityPanel(props: IDockviewPanelProps<{ kind: EditorKind; id: Id }>): ReactNode {
  const { kind, id } = props.params
  const name = useProjectStore((s) => entityName(s.project, kind, id))
  const { api } = props
  useEffect(() => {
    if (name === null) api.close()
    else api.setTitle(name)
  }, [name, api])
  return (
    <div className="inspector entity-editor">
      {kind === 'type' ? (
        <TypeInspector id={id} />
      ) : kind === 'interface' ? (
        <InterfaceInspector id={id} />
      ) : kind === 'module' ? (
        <ModuleInspector id={id} />
      ) : (
        <LinkInspector id={id} />
      )}
    </div>
  )
}

const KIND_ICON: Record<string, string> = { type: 'T', interface: 'I', module: 'M', link: 'L' }

function ViewTab(props: IDockviewPanelHeaderProps<{ viewId: Id }>): ReactNode {
  const { viewId } = props.params
  const drill = useProjectStore((s) => !!findView(s.project, viewId).rootModuleId)
  const stored = viewId !== GLOBAL_VIEW
  const rename = (): void => {
    if (!stored) return
    const name = window.prompt('View name', props.api.title ?? '')
    if (name?.trim()) renameView(viewId, name.trim())
  }
  return (
    <DockviewDefaultTab
      {...props}
      className={`view-tab ${drill ? 'drill' : ''}`}
      onDoubleClick={rename}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [
          { label: 'Open to the side', run: () => (closeView(viewId), openView(viewId, { split: true })) },
          { label: 'Rename…', disabled: !stored, run: rename },
          { label: 'Close', run: () => props.api.close() },
          'separator',
          { label: 'New view', run: newView },
          { label: 'Delete view', danger: true, disabled: !stored, run: () => deleteView(viewId) }
        ])
      }}
    />
  )
}

function EntityTab(props: IDockviewPanelHeaderProps<{ kind: EditorKind; id: Id }>): ReactNode {
  return (
    <DockviewDefaultTab
      {...props}
      className="entity-tab"
      data-kind={KIND_ICON[props.params.kind]}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [
          { label: 'Close', run: () => props.api.close() },
          { label: 'Close others', run: () => closeOthers(props.api.id) }
        ])
      }}
    />
  )
}

function closeOthers(keep: string): void {
  const api = editorApi()
  for (const p of api?.panels ?? []) if (p.id !== keep) p.api.close()
}

function Watermark(): ReactNode {
  return (
    <div className="watermark">
      <p>No open view.</p>
      <button type="button" onClick={() => openView(GLOBAL_VIEW)}>
        Open global view
      </button>
    </div>
  )
}

const components = { canvas: CanvasPanel, entity: EntityPanel }
const tabComponents = { view: ViewTab, entity: EntityTab }

/** Editor tabs of one document, restored from and saved to its state. */
function DocEditor({ docId }: { docId: Id }): ReactNode {
  const api = useRef<DockviewApi | null>(null)
  // Unmounting clears the dock: that must not be saved as the document's layout.
  const alive = useRef(true)
  useLayoutEffect(
    () => () => {
      alive.current = false
    },
    []
  )
  const onReady = useCallback(
    (e: DockviewReadyEvent): void => {
      api.current = e.api
      setEditorApi(e.api)
      const layout = findDoc(docId)?.layout
      try {
        if (layout) e.api.fromJSON(layout as SerializedDockview)
      } catch {
        e.api.clear()
      }
      if (!e.api.totalPanels) openView(GLOBAL_VIEW)
      e.api.onDidLayoutChange(() => {
        if (alive.current) patchDoc({ layout: e.api.toJSON() }, docId)
      })
      e.api.onDidActivePanelChange((ev) => {
        const viewId = (ev.panel?.params as { viewId?: Id } | undefined)?.viewId
        if (viewId) patchDoc({ activeViewId: viewId }, docId)
      })
    },
    [docId]
  )
  useEffect(
    () => () => {
      if (editorApi() === api.current) setEditorApi(null)
    },
    []
  )
  return (
    <DockviewReact
      className="editor-dock"
      components={components}
      tabComponents={tabComponents}
      watermarkComponent={Watermark}
      onReady={onReady}
      theme={dockTheme}
    />
  )
}

export function EditorArea(): ReactNode {
  const docId = useDocs((s) => s.activeId)
  return (
    <div className="editor-area">
      <DocTabs />
      <DocEditor key={docId} docId={docId} />
    </div>
  )
}
