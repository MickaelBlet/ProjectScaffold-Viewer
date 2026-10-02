// Center of the window: the document tabs, then the active document's views and editor tabs.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
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
import { findView, viewExists } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Project } from '@/model/types'
import { formatFromPath } from '@/model/serialize'
import { findDoc, patchDoc, useDoc, useDocs } from '@/store/documents'
import { deleteView, renameView, useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { keepView, newView } from '@/actions'
import { TypeInspector } from '@/panels/TypeInspector'
import { InterfaceInspector } from '@/panels/InterfaceInspector'
import { ModuleInspector } from '@/panels/ModuleInspector'
import { LinkInspector } from '@/panels/LinkInspector'
import { SourcePanel } from '@/panels/SourcePanel'
import { FilePanel } from '@/panels/FilePanel'
import { languageOf, type LanguageId } from '@/components/codeLanguages'
import { dropTextFile, isFileDirty, textFileKey, useTextFiles, type TextFileRef } from '@/store/textFiles'
import { confirmCloseTextFile } from '@/textFileOps'
import { DocTabs } from './DocTabs'
import { IN_VSCODE } from '@/host'
import { closeView, editorApi, openView, setEditorApi, type EditorKind } from './controllers'
import { dockTheme } from './theme'

function CanvasPanel(props: IDockviewPanelProps<{ viewId: Id }>): ReactNode {
  const { viewId } = props.params
  const exists = useProjectStore((s) => viewExists(s.project, viewId))
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

function SourceEditor({ api }: IDockviewPanelProps): ReactNode {
  const format = useDoc((d) => (d.filePath ? formatFromPath(d.filePath) : 'yaml'))
  useEffect(() => api.setTitle(format.toUpperCase()), [format, api])
  return <SourcePanel format={format} />
}

const KIND_ICON: Record<EditorKind | 'source', string> = {
  type: 'T',
  interface: 'I',
  module: 'M',
  link: 'L',
  source: '{}'
}

function ViewTab(props: IDockviewPanelHeaderProps<{ viewId: Id }>): ReactNode {
  const { viewId } = props.params
  const drill = useProjectStore((s) => !!findView(s.project, viewId).rootModuleId)
  const temporary = useProjectStore((s) => !!findView(s.project, viewId).temporary)
  const stored = viewId !== GLOBAL_VIEW && !temporary
  const rename = (): void => {
    if (!stored) return
    const name = window.prompt('View name', props.api.title ?? '')
    if (name?.trim()) renameView(viewId, name.trim())
  }
  return (
    <DockviewDefaultTab
      {...props}
      // DockviewDefaultTab sets its own className: styles.css goes by these attributes.
      data-tab={drill ? 'drill' : 'view'}
      data-temporary={temporary || undefined}
      // A temporary view is kept by a double click, as VS Code's preview tabs.
      onDoubleClick={temporary ? () => keepView(viewId) : rename}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [
          { label: 'Open to the side', run: () => (closeView(viewId), openView(viewId, { split: true })) },
          { label: 'Keep view', disabled: !temporary, run: () => keepView(viewId) },
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

function EntityTab(props: IDockviewPanelHeaderProps<{ kind: EditorKind | 'source' }>): ReactNode {
  return (
    <DockviewDefaultTab
      {...props}
      data-tab="entity"
      // Inherited by the title's ::before, which attr() cannot reach.
      style={{ '--tab-kind': `'${KIND_ICON[props.params.kind]} '` } as CSSProperties}
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

const FILE_ICON: Record<LanguageId, string> = {
  yaml: '{}',
  json: '{}',
  cpp: 'C',
  python: 'Py',
  cmake: 'Mk',
  idl: 'I',
  liquid: '{%',
  text: '¶'
}

const fileRefOf = (params: unknown): TextFileRef | null => {
  const p = params as Partial<TextFileRef> | undefined
  return p?.source && p.path ? { source: p.source, path: p.path } : null
}

/** Closes a tab, asking first when it holds a text file with unsaved edits. */
function closePanel(id: string): void {
  const panel = editorApi()?.getPanel(id)
  if (!panel) return
  const ref = id.startsWith('file:') ? fileRefOf(panel.params) : null
  if (!ref || confirmCloseTextFile(ref)) panel.api.close()
}

function FileTab(props: IDockviewPanelHeaderProps<TextFileRef>): ReactNode {
  const { id } = props.api
  return (
    <DockviewDefaultTab
      {...props}
      data-tab="entity"
      style={{ '--tab-kind': `'${FILE_ICON[languageOf(props.params.path).id]} '` } as CSSProperties}
      closeActionOverride={() => closePanel(id)}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [
          { label: 'Close', run: () => closePanel(id) },
          { label: 'Close others', run: () => closeOthers(id) }
        ])
      }}
    />
  )
}

function closeOthers(keep: string): void {
  const api = editorApi()
  for (const p of api?.panels ?? []) if (p.id !== keep) closePanel(p.id)
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

const components = {
  canvas: CanvasPanel,
  entity: EntityPanel,
  source: SourceEditor,
  file: FilePanel
}
const tabComponents = { view: ViewTab, entity: EntityTab, file: FileTab }

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
      // A text file tab closed otherwise than by its close button: its edits, if any, are kept for
      // when it opens again.
      e.api.onDidRemovePanel((p) => {
        const ref = alive.current && p.id.startsWith('file:') ? fileRefOf(p.params) : null
        if (ref && !isFileDirty(useTextFiles.getState().files[textFileKey(docId, ref)]))
          dropTextFile(docId, ref)
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
      {/* VS Code shows each document in its own editor tab. */}
      {!IN_VSCODE && <DocTabs />}
      <DocEditor key={docId} docId={docId} />
    </div>
  )
}
