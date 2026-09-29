import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type OnNodeDrag,
  type Viewport
} from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { toPng, toSvg } from 'html-to-image'
import {
  findImported,
  findView,
  isImportedId,
  minSize,
  orderLinkEnds,
  subtreeIds,
  visibleModuleIds
} from '@/model/project'
import { NOTE_MIN, snapRect, snapValue } from '@/model/grid'
import { GLOBAL_VIEW, type Id, type Project, type View } from '@/model/types'
import {
  connect,
  deleteLink,
  getProject,
  reparentModule,
  reverseLink,
  setLayouts,
  setLinkRoute,
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
  importProjectContent,
  linkOtherProject,
  navigate,
  openImportSource,
  openModuleView,
  paste,
  refreshDependencies,
  showDependency,
  selectionOf,
  showAllInView
} from '@/actions'
import { commandItem as item, keyLabel } from '@/commands'
import { fileName } from '@/fileOps'
import { openView, registerCanvas } from '@/shell/controllers'
import { EXTERNAL } from './constants'
import { endOf, externalNodes, linkEnds, standIns, toEdges, toNodes } from './flowGraph'
import { INHERIT } from './inheritEdges'
import { reuseUnchanged } from './reuseUnchanged'
import { floatingPortSides, portPoints } from './portSides'
import { ModuleNode } from './ModuleNode'
import { NoteNode } from './NoteNode'
import { ExternalNode } from './ExternalNode'
import { ImportedNode } from './ImportedNode'
import { LinkEdge } from './LinkEdge'
import { InheritEdge } from './InheritEdge'

const nodeTypes = { module: ModuleNode, note: NoteNode, external: ExternalNode, imported: ImportedNode }
const edgeTypes = { link: LinkEdge, inherit: InheritEdge }

const GUIDE_PX = 6

const NOTE_COLORS: [string, string | undefined][] = [
  ['default', undefined],
  ['yellow', '#f5d76e'],
  ['green', '#7ed6a5'],
  ['blue', '#7fb3f5'],
  ['pink', '#f5a3c7'],
  ['purple', '#b9a3f5'],
  ['grey', '#b8bec9']
]

interface Guide {
  /** Vertical line at x, or horizontal line at y (absolute flow coordinates). */
  x?: number
  y?: number
}

type Point = { x: number; y: number }

/** Nodes inside the dragged frames, with their positions when the drag started. */
interface FrameDrag {
  /** Dragged node whose moves give the offset. */
  id: string
  from: Point
  nodes: Map<string, Point>
}

type Box = Point & { width: number; height: number }

const within = (r: Box, f: Box): boolean =>
  r.x >= f.x && r.y >= f.y && r.x + r.width <= f.x + f.width && r.y + r.height <= f.y + f.height

/** Nodes inside a dragged frame follow it. */
function followFrame(changes: NodeChange<Node>[], drag: FrameDrag | null): void {
  if (!drag) return
  const c = changes.find(
    (x): x is Extract<NodeChange<Node>, { type: 'position' }> =>
      x.type === 'position' && x.id === drag.id && !!x.position
  )
  if (!c?.position) return
  const dx = c.position.x - drag.from.x
  const dy = c.position.y - drag.from.y
  for (const [id, at] of drag.nodes)
    changes.push({ id, type: 'position', position: { x: at.x + dx, y: at.y + dy } })
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
  // Viewport of this view when last shown, read once.
  const [savedViewport] = useState(() => activeDoc().viewports[viewId])
  const settings = useSettings(
    useShallow((s) => ({
      autoOrientLinks: s.autoOrientLinks,
      snapToGrid: s.snapToGrid,
      gridSize: s.gridSize,
      theme: s.theme,
      minimap: s.minimap,
      inheritance: s.inheritance
    }))
  )
  const flow = useReactFlow()
  const { screenToFlowPosition, getInternalNode, fitView } = flow
  const container = useRef<HTMLDivElement>(null)
  const [guides, setGuides] = useState<Guide[]>([])

  const view = useMemo(() => findView(project, viewId), [project, viewId])
  const visible = useMemo(() => visibleModuleIds(project, view), [project, view])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedLink = selection?.kind === 'link' ? selection.id : null
  const colors = useMemo(() => {
    const m = new Map<Id, string>()
    for (const x of [...project.modules, ...project.notes]) if (x.color) m.set(x.id, x.color)
    return m
  }, [project])

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([])
  const frameDrag = useRef<FrameDrag | null>(null)
  // Ports follow their links when link ends are auto-oriented; outside stand-ins follow the ports
  // they link to, and the ports follow them back.
  const { sides, externals } = useMemo(() => {
    const auto = settings.autoOrientLinks
    let externals = externalNodes(project, view, visible, null)
    let sides = auto ? floatingPortSides(project, visible, standIns(project, view, externals)) : null
    if (externals.length) {
      externals = externalNodes(project, view, visible, portPoints(project, visible, sides))
      if (auto) sides = floatingPortSides(project, visible, standIns(project, view, externals))
    }
    return { sides, externals }
  }, [project, view, visible, settings.autoOrientLinks])
  const grid = settings.snapToGrid ? settings.gridSize : null
  // Nodes and links are rebuilt on every edit; only those that changed get new objects (and render again).
  useEffect(
    () =>
      setNodes((prev) => reuseUnchanged(prev, toNodes(project, view, selectedSet, sides, externals, grid))),
    [project, view, selectedSet, sides, externals, grid, setNodes]
  )
  const [edges, setEdges] = useEdgesState<Edge>([])
  useEffect(
    () =>
      setEdges((prev) =>
        reuseUnchanged(
          prev,
          toEdges(project, visible, !!view.rootModuleId, selectedLink, settings.inheritance)
        )
      ),
    [project, visible, view.rootModuleId, selectedLink, settings.inheritance, setEdges]
  )

  const absolute = useCallback(
    (id: string) => getInternalNode(id)?.internals.positionAbsolute ?? { x: 0, y: 0 },
    [getInternalNode]
  )

  /** Absolute rect of a node; `measured` is lost while nodes are rebuilt, the given size is not. */
  const nodeRect = useCallback(
    (id: string) => {
      const n = getInternalNode(id)
      return n
        ? {
            ...n.internals.positionAbsolute,
            width: n.measured.width ?? n.width ?? 0,
            height: n.measured.height ?? n.height ?? 0
          }
        : null
    },
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
        reveal: (ids) => {
          // A module outside a drill-down view shows as its stand-in.
          const rects = ids.map((id) => nodeRect(id) ?? nodeRect(EXTERNAL + id)).filter((r) => !!r)
          if (!rects.length) return
          const x = Math.min(...rects.map((r) => r.x))
          const y = Math.min(...rects.map((r) => r.y))
          const width = Math.max(...rects.map((r) => r.x + r.width)) - x
          const height = Math.max(...rects.map((r) => r.y + r.height)) - y
          const box = container.current?.getBoundingClientRect()
          // Keep the zoom unless the target does not fit.
          const fit = box ? Math.min((box.width * 0.85) / width, (box.height * 0.85) / height) : Infinity
          void flow.setCenter(x + width / 2, y + height / 2, {
            zoom: Math.max(Math.min(Math.max(flow.getZoom(), 0.8), fit), 0.1),
            duration: 250
          })
        },
        zoomBy: (f) => void flow.zoomTo(flow.getZoom() * f, { duration: 150 }),
        zoomTo: (z) => void flow.zoomTo(z, { duration: 150 }),
        nodeRect,
        exportImage: async (format) => {
          const el = container.current?.querySelector<HTMLElement>('.react-flow__viewport')
          if (!el) return
          // The hook resolves the absolute position of nested modules.
          const bounds = flow.getNodesBounds(flow.getNodes())
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
          const saved = await window.api.saveImage(`${base}-${view.name}.${format}`, url)
          if (saved) setStatus('info', `Exported ${saved}`)
        }
      }),
    [viewId, view.name, flow, fitView, screenToFlowPosition, nodeRect]
  )

  useEffect(() => {
    if (viewEpoch <= 1 && savedViewport) return
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 50)
    return () => clearTimeout(t)
  }, [viewEpoch, savedViewport, fitView])

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
      p.modules.some((m) => m.id === id) || p.notes.some((n) => n.id === id) || !!findImported(p, id)
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

  /** Smallest size of a resizable node. */
  const minOf = useCallback((id: string) => {
    const p = getProject()
    const m = p.modules.find((m) => m.id === id) ?? findImported(p, id)?.module
    return m ? minSize(m, p.orientation) : NOTE_MIN
  }, [])

  /** Grid: every dragged node lands on it, a resized node keeps both edges on it. */
  const snapToGrid = useCallback(
    (changes: NodeChange<Node>[], grid: number): void => {
      const originOf = (id: string): { x: number; y: number } => {
        const parentId = flow.getNode(id)?.parentId
        return parentId ? absolute(parentId) : { x: 0, y: 0 }
      }
      for (const c of [...changes]) {
        if (c.type === 'position' && c.dragging && c.position) {
          const o = originOf(c.id)
          c.position = {
            x: snapValue(o.x + c.position.x, grid) - o.x,
            y: snapValue(o.y + c.position.y, grid) - o.y
          }
        }
        if (c.type !== 'dimensions' || c.resizing === undefined || !c.dimensions) continue
        const node = flow.getNode(c.id)
        if (!node) continue
        const move = changes.find(
          (x): x is Extract<NodeChange<Node>, { type: 'position' }> =>
            x.type === 'position' && x.id === c.id && !!x.position
        )
        const o = originOf(c.id)
        const at = move?.position ?? node.position
        // Resizing from the left (top) moves the node: the other edge stays.
        const r = snapRect({ x: o.x + at.x, y: o.y + at.y, ...c.dimensions }, grid, minOf(c.id), {
          right: at.x !== node.position.x,
          bottom: at.y !== node.position.y
        })
        c.dimensions = { width: r.width, height: r.height }
        const position = { x: r.x - o.x, y: r.y - o.y }
        if (move) move.position = position
        else if (c.resizing && (position.x !== node.position.x || position.y !== node.position.y))
          changes.push({ id: c.id, type: 'position', position })
      }
    },
    [flow, absolute, minOf]
  )

  // Alignment guides: snap a dragged node to its siblings' edges and centers.
  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]): void => {
      applySelect(changes)
      const { snapToGrid: onGrid, gridSize, guides: showGuides } = useSettings.getState()
      const grid = onGrid ? gridSize : null
      if (grid) snapToGrid(changes, grid)
      const moving = changes.filter((c) => c.type === 'position' && c.dragging && c.position)
      if (moving.length !== 1 || !showGuides) {
        if (guides.length) setGuides([])
        followFrame(changes, frameDrag.current)
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
      // On the grid, a guide only shows an alignment: it never pulls the node off the grid.
      const offGrid = (delta: number): boolean =>
        !!grid && Math.abs(delta / grid - Math.round(delta / grid)) > 1e-6
      const snapAxis = (axis: 'x' | 'y', size: number): void => {
        const mine = [pos[axis], pos[axis] + size / 2, pos[axis] + size]
        let best: { delta: number; at: number } | null = null
        for (const s of siblings) {
          const ss =
            axis === 'x' ? (s.measured?.width ?? s.width ?? 0) : (s.measured?.height ?? s.height ?? 0)
          for (const theirs of [s.position[axis], s.position[axis] + ss / 2, s.position[axis] + ss])
            for (const m of mine) {
              const delta = theirs - m
              if (offGrid(delta)) continue
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
      followFrame(changes, frameDrag.current)
      onNodesChangeBase(changes)
    },
    [flow, guides.length, onNodesChangeBase, absolute, applySelect, snapToGrid]
  )

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    if (!c.sourceHandle || !c.targetHandle || c.source === c.target) return false
    if (c.source.startsWith(EXTERNAL) || c.target.startsWith(EXTERNAL)) return false
    // A link to another project needs one end here.
    if (isImportedId(c.source) && isImportedId(c.target)) return false
    return !!linkEnds(getProject(), c)
  }, [])

  const onConnect = useCallback((c: Connection): void => {
    const ends = linkEnds(getProject(), c)
    if (!ends) return
    const [from, to] = ends
    const id = connect(from, to)
    if (id) select({ kind: 'link', id })
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

  // Dropped on a module rather than a port: link to a new port there.
  const onConnectEnd: OnConnectEnd = useCallback(
    (e, state) => {
      const origin = state.fromHandle
      if (state.isValid || !origin?.id || origin.nodeId.startsWith(EXTERNAL)) return
      const { clientX, clientY } = 'changedTouches' in e ? e.changedTouches[0]! : e
      const target = moduleAt(flow.screenToFlowPosition({ x: clientX, y: clientY }))
      if (!target || target === origin.nodeId) return
      const ends = orderLinkEnds(getProject(), endOf(getProject(), origin.nodeId, origin.id), {
        moduleId: target,
        portId: null,
        role: null
      })
      if (!ends) return
      const id = connect(ends[0], ends[1])
      if (id) select({ kind: 'link', id })
    },
    [flow, moduleAt]
  )

  // A dragged frame carries the top-level nodes lying fully inside it.
  const onNodeDragStart: OnNodeDrag = useCallback(
    (_, node, dragged) => {
      frameDrag.current = null
      const notes = getProject().notes
      const frames = dragged
        .filter((n) => notes.find((x) => x.id === n.id)?.kind === 'frame')
        .map((n) => nodeRect(n.id))
        .filter((r) => !!r)
      if (!frames.length) return
      const moving = new Set(dragged.map((n) => n.id))
      const nodes = new Map<string, Point>()
      for (const n of flow.getNodes()) {
        if (moving.has(n.id) || n.parentId || n.draggable === false || n.type === 'external') continue
        const r = nodeRect(n.id)
        if (r && frames.some((f) => within(r, f))) nodes.set(n.id, { ...n.position })
      }
      if (nodes.size) frameDrag.current = { id: node.id, from: { ...node.position }, nodes }
    },
    [flow, nodeRect]
  )

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_, node, dragged) => {
      setGuides([])
      const p = getProject()
      const carried = [...(frameDrag.current?.nodes.keys() ?? [])].flatMap((id) => flow.getNode(id) ?? [])
      frameDrag.current = null
      if (dragged.length > 1 || node.type === 'note' || node.type === 'imported') {
        // Several items: move them, keeping their parents.
        setLayouts(
          new Map(
            [...dragged, ...carried].map((n) => [
              n.id,
              { x: Math.round(n.position.x), y: Math.round(n.position.y) }
            ])
          )
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
    [flow, absolute, moduleAt, view.rootModuleId]
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
    if (node.type === 'imported') {
      const dep = findImported(getProject(), node.id)?.dep
      return openContextMenu(e, [
        ...(dep
          ? [
              { label: 'Refresh from its project', run: () => void refreshDependencies([dep.id]) },
              { label: `Open ${dep.file}`, run: () => openImportSource(dep.file) },
              { label: `Show dependency ${dep.name}`, run: () => showDependency(dep.id) }
            ]
          : []),
        'separator',
        item('edit.delete', 'Remove from this project')
      ])
    }
    const multiple = activeDoc().selectedIds.length > 1
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (node.type === 'note') {
      return openContextMenu(e, [
        item('edit.cut'),
        item('edit.copy'),
        item('edit.duplicate'),
        item('arrange.lock', 'Locked'),
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
      item('arrange.horizontal', 'Arrange content horizontally'),
      item('arrange.vertical', 'Arrange content vertically'),
      item('view.hide'),
      item('arrange.lock', 'Locked'),
      'separator',
      item('edit.cut'),
      item('edit.copy'),
      { label: 'Paste into', run: () => void paste(undefined, { at, parent: node.id }) },
      { label: 'Import another project into…', run: () => importProjectContent(node.id) },
      item('edit.duplicate'),
      'separator',
      item('edit.delete')
    ])
  }

  const edgeMenu = (e: React.MouseEvent, edge: Edge): void => {
    e.preventDefault()
    if (edge.id.startsWith(INHERIT)) {
      select({ kind: 'module', id: edge.source })
      openContextMenu(e, [
        { label: 'Go to base', run: () => navigate({ kind: 'module', id: edge.target }) },
        {
          label: 'Remove base',
          run: () =>
            update((d) => {
              const m = d.modules.find((m) => m.id === edge.source)
              if (!m?.bases) return
              m.bases = m.bases.filter((b) => b !== edge.target)
              if (!m.bases.length) delete m.bases
            })
        }
      ])
      return
    }
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
      ...(getProject().links.find((l) => l.id === edge.id)?.route
        ? [{ label: 'Reset shape', run: () => setLinkRoute(edge.id, undefined) }]
        : []),
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
      'separator',
      { label: 'Link to another project…', run: () => linkOtherProject(at) },
      { label: 'Import another project here…', run: () => importProjectContent(parent, at) },
      'separator',
      { label: 'Paste here', keys: keyLabel('Ctrl+V'), run: () => void paste(undefined, { at, parent }) },
      'separator',
      item('arrange.horizontal', view.rootModuleId ? 'Arrange view horizontally' : 'Arrange horizontally'),
      item('arrange.vertical', view.rootModuleId ? 'Arrange view vertically' : 'Arrange vertically'),
      item('view.fitAll'),
      item('edit.selectAll'),
      ...(view.hidden.length ? [item('view.showAll')] : []),
      'separator',
      item('file.exportPng'),
      item('file.exportSvg')
    ])
  }

  const selectionMenu = (e: React.MouseEvent): void => {
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
      item('arrange.lock', 'Locked'),
      'separator',
      item('edit.cut'),
      item('edit.copy'),
      item('edit.duplicate'),
      item('view.hide'),
      'separator',
      item('edit.delete')
    ])
  }

  return (
    <div className="canvas" ref={container} onPointerDownCapture={focusView}>
      <Breadcrumbs view={view} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
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
          const dep = n.type === 'imported' ? findImported(getProject(), n.id)?.dep : undefined
          if (dep) openImportSource(dep.file)
        }}
        onEdgeClick={(_, e) =>
          select(e.type === 'inherit' ? { kind: 'module', id: e.source } : { kind: 'link', id: e.id })
        }
        onPaneClick={() => select(null)}
        onNodeContextMenu={nodeMenu}
        onEdgeContextMenu={edgeMenu}
        onPaneContextMenu={paneMenu}
        onSelectionContextMenu={selectionMenu}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        // Links go either way between ports (see linkEnds), into a container from its in ports.
        connectionMode={ConnectionMode.Loose}
        onMove={(_, vp) => useUiStore.setState({ zoom: vp.zoom })}
        onMoveEnd={onMoveEnd}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Control', 'Meta']}
        // Fixed stacking (see Z), even when selected; link badges (1001) stay above everything.
        zIndexMode="manual"
        snapToGrid={settings.snapToGrid}
        snapGrid={[settings.gridSize, settings.gridSize]}
        colorMode={settings.theme}
        minZoom={0.1}
        defaultViewport={savedViewport}
        fitView={!savedViewport}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={settings.gridSize} />
        <Controls />
        {settings.minimap && <MiniMap pannable zoomable nodeColor={(n) => colors.get(n.id) ?? ''} />}
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
}
