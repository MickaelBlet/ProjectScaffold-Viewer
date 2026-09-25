import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  getNodesBounds,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type Viewport
} from '@xyflow/react'
import { toPng, toSvg } from 'html-to-image'
import { findPort, findView, modulePath, subtreeIds, visibleModuleIds } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Project, type View } from '@/model/types'
import {
  addLink,
  deleteLink,
  getProject,
  reparentModule,
  reverseLink,
  setLayouts,
  update,
  updateNote,
  useProjectStore
} from '@/store/project'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import { useSettings } from '@/store/settings'
import { openContextMenu, select, setStatus, useUiStore } from '@/store/ui'
import {
  addModuleAt,
  addNoteAt,
  navigate,
  openModuleView,
  paste,
  selectionOf,
  showAllInView
} from '@/actions'
import { commandItem as item, keyLabel } from '@/commands'
import { fileName } from '@/fileOps'
import { openView, registerCanvas } from '@/shell/controllers'
import { ModuleNode } from './ModuleNode'
import { NoteNode } from './NoteNode'
import { ExternalNode, type ExternalNodeData, type ExternalPort } from './ExternalNode'
import { LinkEdge, PERF_COLORS } from './LinkEdge'

const nodeTypes = { module: ModuleNode, note: NoteNode, external: ExternalNode }
const edgeTypes = { link: LinkEdge }

const EXTERNAL = 'external:'
const GUIDE_PX = 6

interface Guide {
  /** Vertical line at x, or horizontal line at y (absolute flow coordinates). */
  x?: number
  y?: number
}

/** React Flow nodes of a view: its modules (parents first), notes and outside stand-ins. */
function toNodes(p: Project, view: View, selected: Set<Id>): Node[] {
  const visible = visibleModuleIds(p, view)
  const nodes: Node[] = []
  if (!view.rootModuleId)
    for (const n of p.notes)
      nodes.push({
        id: n.id,
        type: 'note',
        position: { x: n.layout.x, y: n.layout.y },
        width: n.layout.width,
        height: n.layout.height,
        selected: selected.has(n.id),
        // Frames stay behind modules.
        zIndex: n.kind === 'frame' ? -1 : 500,
        data: {}
      })
  for (const m of p.modules) {
    if (!visible.has(m.id)) continue
    const isRoot = m.id === view.rootModuleId
    nodes.push({
      id: m.id,
      type: 'module',
      position: { x: m.layout.x, y: m.layout.y },
      width: m.layout.width,
      height: m.layout.height,
      parentId: isRoot ? undefined : (m.parentId ?? undefined),
      // The root of a drill-down view is the frame of the view.
      draggable: !isRoot,
      selected: selected.has(m.id),
      data: {}
    })
  }
  if (view.rootModuleId) nodes.push(...externalNodes(p, view, visible))
  return nodes
}

/** Stand-ins for the modules outside a drill-down view linked to its content. */
function externalNodes(p: Project, view: View, visible: Set<Id>): Node<ExternalNodeData>[] {
  const root = p.modules.find((m) => m.id === view.rootModuleId)
  if (!root) return []
  const outside = new Map<Id, ExternalPort[]>()
  const add = (moduleId: Id, portId: Id, type: 'source' | 'target'): void => {
    const port = findPort(p, moduleId, portId)
    if (!port) return
    const list = outside.get(moduleId) ?? []
    if (!list.some((x) => x.id === portId)) list.push({ id: portId, name: port.name, type })
    outside.set(moduleId, list)
  }
  for (const l of p.links) {
    const fromIn = visible.has(l.from.moduleId)
    const toIn = visible.has(l.to.moduleId)
    if (fromIn && !toIn) add(l.to.moduleId, l.to.portId, 'target')
    if (!fromIn && toIn) add(l.from.moduleId, l.from.portId, 'source')
  }
  const r = root.layout
  let left = r.y
  let right = r.y
  return [...outside].map(([moduleId, ports]) => {
    // Senders on the left of the view, receivers on the right.
    const sender = ports.every((pt) => pt.type === 'source')
    const height = 34 + ports.length * 24
    const y = sender ? left : right
    if (sender) left += height + 20
    else right += height + 20
    return {
      id: EXTERNAL + moduleId,
      type: 'external',
      position: { x: sender ? r.x - 260 : r.x + r.width + 80, y },
      width: 180,
      height,
      draggable: false,
      selectable: false,
      data: { label: modulePath(p, moduleId), ports }
    }
  })
}

function toEdges(p: Project, visible: Set<Id>, drill: boolean, selectedLink: Id | null): Edge[] {
  const end = (moduleId: Id): string | null =>
    visible.has(moduleId) ? moduleId : drill ? EXTERNAL + moduleId : null
  return p.links.flatMap((l) => {
    const source = end(l.from.moduleId)
    const target = end(l.to.moduleId)
    if (!source || !target || (source.startsWith(EXTERNAL) && target.startsWith(EXTERNAL))) return []
    const color = PERF_COLORS[l.constraints.performance.class]
    const marker = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }
    return [
      {
        id: l.id,
        type: 'link',
        source,
        sourceHandle: l.from.portId,
        target,
        targetHandle: l.to.portId,
        selected: l.id === selectedLink,
        markerEnd: marker,
        markerStart: l.constraints.direction === 'bidirectional' ? marker : undefined,
        zIndex: 1000
      }
    ]
  })
}

const sameIds = (a: Id[], b: Id[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

function Breadcrumbs({ view }: { view: View }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const chain: { id: Id; name: string }[] = []
  let cur = project.modules.find((m) => m.id === view.rootModuleId)
  while (cur) {
    chain.unshift({ id: cur.id, name: cur.name })
    const parentId = cur.parentId
    cur = parentId ? project.modules.find((m) => m.id === parentId) : undefined
  }
  if (!chain.length && !view.hidden.length) return null
  return (
    <nav className="breadcrumbs">
      {chain.length > 0 && (
        <>
          <button type="button" className="link-button" onClick={() => openView(GLOBAL_VIEW)}>
            Global
          </button>
          {chain.map((c, i) => (
            <span key={c.id}>
              <span className="crumb-sep">›</span>
              {i === chain.length - 1 ? (
                <strong>{c.name}</strong>
              ) : (
                <button type="button" className="link-button" onClick={() => openModuleView(c.id)}>
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </>
      )}
      {view.hidden.length > 0 && (
        <span className="hidden-chip">
          {view.hidden.length} hidden ·{' '}
          <button type="button" className="link-button" onClick={showAllInView}>
            show all
          </button>
        </span>
      )}
    </nav>
  )
}

export function Canvas({ viewId }: { viewId: Id }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const selection = useDoc((d) => d.selection)
  const selectedIds = useDoc((d) => d.selectedIds)
  const viewEpoch = useDoc((d) => d.viewEpoch)
  const savedViewport = useRef(activeDoc().viewports[viewId])
  const settings = useSettings()
  const flow = useReactFlow()
  const { screenToFlowPosition, getInternalNode, fitView } = flow
  const container = useRef<HTMLDivElement>(null)
  const [guides, setGuides] = useState<Guide[]>([])

  const view = useMemo(() => findView(project, viewId), [project, viewId])
  const visible = useMemo(() => visibleModuleIds(project, view), [project, view])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedLink = selection?.kind === 'link' ? selection.id : null

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([])
  useEffect(() => setNodes(toNodes(project, view, selectedSet)), [project, view, selectedSet, setNodes])
  const edges = useMemo(
    () => toEdges(project, visible, !!view.rootModuleId, selectedLink),
    [project, visible, view.rootModuleId, selectedLink]
  )

  const absolute = useCallback(
    (id: string) => getInternalNode(id)?.internals.positionAbsolute ?? { x: 0, y: 0 },
    [getInternalNode]
  )

  // Canvas controller for commands.
  useEffect(
    () =>
      registerCanvas({
        viewId,
        fit: (ids) =>
          void fitView({
            nodes: ids?.length ? ids.map((id) => ({ id })) : undefined,
            padding: 0.15,
            duration: 200,
            maxZoom: 1.5
          }),
        center: () => {
          const r = container.current?.getBoundingClientRect()
          return r ? screenToFlowPosition({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) : { x: 80, y: 80 }
        },
        reveal: (id) => {
          const n = getInternalNode(id)
          if (!n) return
          const { x, y } = n.internals.positionAbsolute
          void flow.setCenter(x + (n.measured.width ?? 0) / 2, y + (n.measured.height ?? 0) / 2, {
            zoom: Math.max(flow.getZoom(), 0.8),
            duration: 250
          })
        },
        zoomBy: (f) => void flow.zoomTo(flow.getZoom() * f, { duration: 150 }),
        zoomTo: (z) => void flow.zoomTo(z, { duration: 150 }),
        nodeRect: (id) => {
          const n = getInternalNode(id)
          return n
            ? {
                ...n.internals.positionAbsolute,
                width: n.measured.width ?? 0,
                height: n.measured.height ?? 0
              }
            : null
        },
        exportImage: async (format) => {
          const el = container.current?.querySelector<HTMLElement>('.react-flow__viewport')
          if (!el) return
          const bounds = getNodesBounds(flow.getNodes())
          const width = Math.min(8000, Math.max(200, bounds.width + 80))
          const height = Math.min(8000, Math.max(200, bounds.height + 80))
          const vp = getViewportForBounds(bounds, width, height, 0.1, 2, 0.05)
          const options = {
            backgroundColor: getComputedStyle(document.body).backgroundColor,
            width,
            height,
            style: {
              width: `${width}px`,
              height: `${height}px`,
              transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`
            }
          }
          const url = format === 'png' ? await toPng(el, options) : await toSvg(el, options)
          const doc = activeDoc()
          const base = doc.filePath
            ? fileName(doc.filePath).replace(/\.[^.]+$/, '')
            : getProject().name || 'diagram'
          const a = document.createElement('a')
          a.href = url
          a.download = `${base}-${view.name}.${format}`
          a.click()
          setStatus('info', `Exported ${a.download}`)
        }
      }),
    [viewId, view.name, flow, fitView, screenToFlowPosition, getInternalNode]
  )

  useEffect(() => {
    if (viewEpoch <= 1 && savedViewport.current) return
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 50)
    return () => clearTimeout(t)
  }, [viewEpoch, fitView])

  const focusView = (): void => {
    if (activeDoc().activeViewId !== viewId) patchDoc({ activeViewId: viewId })
  }

  /** User selection on the canvas (click, Ctrl+click, box): React Flow reports it as `select` changes. */
  const applySelect = useCallback((changes: NodeChange<Node>[]): void => {
    const selects = changes.filter(
      (c): c is Extract<NodeChange<Node>, { type: 'select' }> =>
        c.type === 'select' && !c.id.startsWith(EXTERNAL)
    )
    if (!selects.length) return
    const doc = activeDoc()
    const p = getProject()
    const onCanvas = (id: Id): boolean =>
      p.modules.some((m) => m.id === id) || p.notes.some((n) => n.id === id)
    // Explorer items leave the selection when the canvas one changes.
    const ids = new Set(doc.selectedIds.filter(onCanvas))
    let added: Id | null = null
    for (const c of selects) {
      if (c.selected) {
        ids.add(c.id)
        added = c.id
      } else ids.delete(c.id)
    }
    const list = [...ids]
    if (sameIds(list, doc.selectedIds)) return
    const current = doc.selection && 'id' in doc.selection ? doc.selection.id : null
    const shown = added ?? (current && ids.has(current) ? current : list[0])
    patchDoc({
      selectedIds: list,
      selection: shown ? selectionOf(p, shown) : doc.selection?.kind === 'link' ? doc.selection : null
    })
  }, [])

  // Alignment guides: snap a dragged node to its siblings' edges and centers.
  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]): void => {
      applySelect(changes)
      const moving = changes.filter((c) => c.type === 'position' && c.dragging && c.position)
      if (moving.length !== 1 || !useSettings.getState().guides) {
        if (guides.length) setGuides([])
        return onNodesChangeBase(changes)
      }
      const change = moving[0] as Extract<NodeChange<Node>, { type: 'position' }>
      const node = flow.getNode(change.id)
      const pos = change.position!
      const w = node?.measured?.width ?? node?.width ?? 0
      const h = node?.measured?.height ?? node?.height ?? 0
      const zoom = flow.getZoom()
      const threshold = GUIDE_PX / zoom
      const siblings = flow
        .getNodes()
        .filter((n) => n.id !== change.id && n.parentId === node?.parentId && n.type !== 'external')
      const found: Guide[] = []
      const snapAxis = (axis: 'x' | 'y', size: number): void => {
        const mine = [pos[axis], pos[axis] + size / 2, pos[axis] + size]
        let best: { delta: number; at: number } | null = null
        for (const s of siblings) {
          const ss =
            axis === 'x' ? (s.measured?.width ?? s.width ?? 0) : (s.measured?.height ?? s.height ?? 0)
          for (const theirs of [s.position[axis], s.position[axis] + ss / 2, s.position[axis] + ss])
            for (const m of mine) {
              const delta = theirs - m
              if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta)))
                best = { delta, at: theirs }
            }
        }
        if (!best) return
        pos[axis] += best.delta
        const origin = node?.parentId ? absolute(node.parentId) : { x: 0, y: 0 }
        found.push(axis === 'x' ? { x: best.at + origin.x } : { y: best.at + origin.y })
      }
      snapAxis('x', w)
      snapAxis('y', h)
      setGuides(found)
      onNodesChangeBase(changes)
    },
    [flow, guides.length, onNodesChangeBase, absolute, applySelect]
  )

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    if (!c.sourceHandle || !c.targetHandle || c.source === c.target) return false
    if (c.source.startsWith(EXTERNAL) || c.target.startsWith(EXTERNAL)) return false
    const p = getProject()
    const a = findPort(p, c.source, c.sourceHandle)
    const b = findPort(p, c.target, c.targetHandle)
    if (!a || !b) return false
    return !a.interfaceId || !b.interfaceId || a.interfaceId === b.interfaceId
  }, [])

  const onConnect = useCallback((c: Connection): void => {
    if (!c.sourceHandle || !c.targetHandle) return
    const from = { moduleId: c.source, portId: c.sourceHandle }
    const to = { moduleId: c.target, portId: c.targetHandle }
    // Propagate the interface to an untyped end.
    update((d) => {
      const a = findPort(d, from.moduleId, from.portId)
      const b = findPort(d, to.moduleId, to.portId)
      if (a && b && !a.interfaceId) a.interfaceId = b.interfaceId
      if (a && b && !b.interfaceId) b.interfaceId = a.interfaceId
    })
    select({ kind: 'link', id: addLink(from, to) })
  }, [])

  /** Deepest visible module under a flow point (excluding `exclude`'s subtree). */
  const moduleAt = useCallback(
    (point: { x: number; y: number }, exclude?: Set<Id>): Id | null => {
      const p = getProject()
      let best: { id: Id; depth: number } | null = null
      for (const n of flow.getNodes()) {
        if (n.type !== 'module' || exclude?.has(n.id)) continue
        const a = absolute(n.id)
        const w = n.measured?.width ?? 0
        const h = n.measured?.height ?? 0
        if (point.x < a.x || point.x > a.x + w || point.y < a.y || point.y > a.y + h) continue
        let depth = 0
        for (let m = p.modules.find((m) => m.id === n.id); m?.parentId; depth++) {
          const parentId: Id = m.parentId
          m = p.modules.find((x) => x.id === parentId)
        }
        if (!best || depth > best.depth) best = { id: n.id, depth }
      }
      return best?.id ?? null
    },
    [flow, absolute]
  )

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_, node, dragged) => {
      setGuides([])
      const p = getProject()
      if (dragged.length > 1 || node.type === 'note') {
        // Several items: move them, keeping their parents.
        setLayouts(
          new Map(dragged.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]))
        )
        return
      }
      const abs = absolute(node.id)
      const w = node.measured?.width ?? node.width ?? 0
      const h = node.measured?.height ?? node.height ?? 0
      const center = { x: abs.x + w / 2, y: abs.y + h / 2 }
      // Deepest module under the dragged module's center becomes its parent.
      const own = subtreeIds(p, node.id)
      const target = moduleAt(center, own) ?? view.rootModuleId
      const parent =
        node.parentId ??
        (node.id === view.rootModuleId ? p.modules.find((m) => m.id === node.id)?.parentId : null) ??
        null
      if (target !== parent) {
        const base = target ? absolute(target) : { x: 0, y: 0 }
        reparentModule(node.id, target, Math.round(abs.x - base.x), Math.round(abs.y - base.y))
      } else {
        setLayouts(new Map([[node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]]))
      }
    },
    [absolute, moduleAt, view.rootModuleId]
  )

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport): void => patchDoc((d) => ({ viewports: { ...d.viewports, [viewId]: vp } })),
    [viewId]
  )

  const nodeMenu = (e: React.MouseEvent, node: Node): void => {
    e.preventDefault()
    if (node.id.startsWith(EXTERNAL)) {
      const id = node.id.slice(EXTERNAL.length)
      return openContextMenu(e, [
        { label: 'Show in global view', run: () => (openView(GLOBAL_VIEW), navigate({ kind: 'module', id })) }
      ])
    }
    if (!activeDoc().selectedIds.includes(node.id)) select(selectionOf(getProject(), node.id))
    const multiple = activeDoc().selectedIds.length > 1
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (node.type === 'note') {
      return openContextMenu(e, [
        item('edit.cut'),
        item('edit.copy'),
        item('edit.duplicate'),
        'separator',
        ...NOTE_COLORS.map(([label, color]) => ({
          label: `Color: ${label}`,
          run: () => updateNote(node.id, (n) => (color ? void (n.color = color) : void delete n.color))
        })),
        'separator',
        item('edit.delete')
      ])
    }
    openContextMenu(e, [
      ...(multiple
        ? [
            item('arrange.group'),
            item('arrange.left'),
            item('arrange.top'),
            item('arrange.distH'),
            item('arrange.distV')
          ]
        : [item('edit.rename'), item('insert.inPort'), item('insert.outPort'), item('insert.submodule')]),
      'separator',
      item('view.openModule'),
      item('view.openModuleSplit'),
      item('arrange.auto', 'Arrange content'),
      item('view.hide'),
      'separator',
      item('edit.cut'),
      item('edit.copy'),
      { label: 'Paste into', run: () => void paste(undefined, { at, parent: node.id }) },
      item('edit.duplicate'),
      'separator',
      item('edit.delete')
    ])
  }

  const edgeMenu = (e: React.MouseEvent, edge: Edge): void => {
    e.preventDefault()
    select({ kind: 'link', id: edge.id })
    const toggle = (fn: (l: Project['links'][number]) => void) => () =>
      update((d) => {
        const l = d.links.find((l) => l.id === edge.id)
        if (l) fn(l)
      })
    openContextMenu(e, [
      { label: 'Reverse direction', run: () => reverseLink(edge.id) },
      {
        label: 'Bidirectional',
        checked: getProject().links.find((l) => l.id === edge.id)?.constraints.direction === 'bidirectional',
        run: toggle(
          (l) =>
            void (l.constraints.direction =
              l.constraints.direction === 'bidirectional' ? 'unidirectional' : 'bidirectional')
        )
      },
      {
        label: 'Acknowledged',
        checked: getProject().links.find((l) => l.id === edge.id)?.constraints.ack.required,
        run: toggle((l) => void (l.constraints.ack.required = !l.constraints.ack.required))
      },
      'separator',
      { label: 'Delete link', danger: true, keys: 'Delete', run: () => (deleteLink(edge.id), select(null)) }
    ])
  }

  const paneMenu = (e: React.MouseEvent | MouseEvent): void => {
    e.preventDefault()
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const parent = moduleAt(at) ?? view.rootModuleId
    openContextMenu(e, [
      { label: 'Add module here', run: () => void addModuleAt(at, parent) },
      ...(view.rootModuleId
        ? []
        : [
            { label: 'Add note here', run: () => addNoteAt('note', at) },
            { label: 'Add frame here', run: () => addNoteAt('frame', at) }
          ]),
      { label: 'Paste here', keys: keyLabel('Ctrl+V'), run: () => void paste(undefined, { at, parent }) },
      'separator',
      item('arrange.auto', view.rootModuleId ? 'Arrange view' : 'Arrange all'),
      item('view.fitAll'),
      item('edit.selectAll'),
      ...(view.hidden.length ? [item('view.showAll')] : []),
      'separator',
      item('file.exportPng'),
      item('file.exportSvg')
    ])
  }

  return (
    <div
      className="canvas"
      ref={container}
      onPointerDownCapture={focusView}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
        const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        addModuleAt(at, moduleAt(at) ?? view.rootModuleId)
      }}
    >
      <Breadcrumbs view={view} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(e, n) => {
          if (n.id.startsWith(EXTERNAL) || e.shiftKey || e.ctrlKey || e.metaKey) return
          // A click on an already selected node keeps the group but shows that node.
          const doc = activeDoc()
          if (!doc.selection || !('id' in doc.selection) || doc.selection.id !== n.id)
            patchDoc({ selection: selectionOf(getProject(), n.id) })
        }}
        onNodeDoubleClick={(_, n) => {
          if (n.id.startsWith(EXTERNAL)) navigate({ kind: 'module', id: n.id.slice(EXTERNAL.length) })
        }}
        onEdgeClick={(_, e) => select({ kind: 'link', id: e.id })}
        onPaneClick={() => select(null)}
        onNodeContextMenu={nodeMenu}
        onEdgeContextMenu={edgeMenu}
        onPaneContextMenu={paneMenu}
        onSelectionContextMenu={(e) => paneMenuForSelection(e)}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onMove={(_, vp) => useUiStore.setState({ zoom: vp.zoom })}
        onMoveEnd={onMoveEnd}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Control', 'Meta']}
        // Fixed stacking: edges (1000) and their badges (1001) stay above modules even when selected.
        zIndexMode="manual"
        zoomOnDoubleClick={false}
        snapToGrid={settings.snapToGrid}
        snapGrid={[settings.gridSize, settings.gridSize]}
        colorMode={settings.theme}
        minZoom={0.1}
        defaultViewport={savedViewport.current}
        fitView={!savedViewport.current}
      >
        <Background gap={settings.gridSize} />
        <Controls />
        {settings.minimap && <MiniMap pannable zoomable />}
        <ViewportPortal>
          {guides.map((g, i) =>
            g.x !== undefined ? (
              <div key={i} className="guide v" style={{ transform: `translate(${g.x}px, -100000px)` }} />
            ) : (
              <div key={i} className="guide h" style={{ transform: `translate(-100000px, ${g.y}px)` }} />
            )
          )}
        </ViewportPortal>
      </ReactFlow>
    </div>
  )

  function paneMenuForSelection(e: React.MouseEvent): void {
    e.preventDefault()
    openContextMenu(e, [
      item('arrange.group'),
      item('arrange.left'),
      item('arrange.hcenter'),
      item('arrange.right'),
      item('arrange.top'),
      item('arrange.vcenter'),
      item('arrange.bottom'),
      item('arrange.distH'),
      item('arrange.distV'),
      item('arrange.sameSize'),
      'separator',
      item('edit.cut'),
      item('edit.copy'),
      item('edit.duplicate'),
      item('view.hide'),
      'separator',
      item('edit.delete')
    ])
  }
}

export const NOTE_COLORS: [string, string | undefined][] = [
  ['default', undefined],
  ['yellow', '#f5d76e'],
  ['green', '#7ed6a5'],
  ['blue', '#7fb3f5'],
  ['pink', '#f5a3c7'],
  ['purple', '#b9a3f5'],
  ['grey', '#b8bec9']
]
