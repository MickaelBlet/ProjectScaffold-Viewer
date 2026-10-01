// React Flow graph of a view: nodes and edges built from the project, and the link ends of a
// connection drawn between two handles.
import { MarkerType, type Connection, type Edge, type Node } from '@xyflow/react'
import {
  absoluteRect,
  allImported,
  findPort,
  importedSize,
  modulePath,
  orderLinkEnds,
  visibleModuleIds
} from '@/model/project'
import { ceilToGrid } from '@/model/grid'
import type { Id, LinkAnchor, PortRole, Project, View } from '@/model/types'
import type { ExternalNodeData, ExternalPort } from './ExternalNode'
import { inheritEdges } from './inheritEdges'
import { EXTERNAL, MODULE_HANDLE, PERF_COLORS, Z } from './constants'
import {
  freePorts,
  neededHeight,
  portAnchors,
  STAND_IN_HEADER,
  type PortPlacement,
  type PortSides,
  type StandIn
} from './portSides'

/** Data of module and imported module nodes: where their ports are drawn. */
export type PortNodeData = {
  /** Floating ports (see portSides.ts); else the orientation's default edges. */
  sides?: Record<Id, PortPlacement>
  /** Ports at a hand-set link attachment (see portAnchors), out of their edge's rows. */
  anchors: Record<Id, LinkAnchor>
}

/**
 * React Flow nodes of a view: its modules (parents first), notes and outside stand-ins. With
 * `selectToMove`, only selected nodes are draggable.
 */
export function toNodes(
  p: Project,
  view: View,
  selected: Set<Id>,
  sides: PortSides | null,
  externals: Node<ExternalNodeData>[],
  grid: number | null,
  selectToMove = false
): Node[] {
  const movable = (id: Id): boolean => !selectToMove || selected.has(id)
  // On the grid, sizes grown for their ports stay multiples of it.
  const fit = (v: number): number => (grid ? ceilToGrid(v, grid) : v)
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
        draggable: !n.locked && movable(n.id),
        zIndex: n.kind === 'frame' ? Z.frame : Z.note,
        data: {}
      })
  const parents = new Set(p.modules.flatMap((m) => m.parentId ?? []))
  // Modules drawn around others: links between their content go over them.
  const containers = new Set(p.modules.flatMap((m) => (visible.has(m.id) && m.parentId) || []))
  // Ports at a hand-set link attachment are drawn there, out of their edge's rows.
  const anchors = portAnchors(p, sides)
  const portData = (
    ports: { id: Id }[],
    placements: Record<Id, PortPlacement> | undefined
  ): PortNodeData => ({
    ...(placements && { sides: placements }),
    anchors: Object.fromEntries(
      ports.flatMap((pt) => (anchors.has(pt.id) ? [[pt.id, anchors.get(pt.id)!]] : []))
    )
  })
  for (const m of p.modules) {
    if (!visible.has(m.id)) continue
    const isRoot = m.id === view.rootModuleId
    const placements = sides?.get(m.id)
    // Containers draw the ports moved to another edge outside their frame: their size stays.
    const grow = placements && !parents.has(m.id)
    nodes.push({
      id: m.id,
      type: 'module',
      position: { x: m.layout.x, y: m.layout.y },
      width: m.layout.width,
      height: grow
        ? Math.max(m.layout.height, fit(neededHeight(freePorts(m.ports, anchors), placements)))
        : m.layout.height,
      parentId: isRoot ? undefined : (m.parentId ?? undefined),
      // The root of a drill-down view is the frame of the view.
      draggable: !isRoot && !m.locked && movable(m.id),
      selected: selected.has(m.id),
      zIndex: containers.has(m.id) ? Z.container : Z.module,
      data: portData(m.ports, placements)
    })
  }
  nodes.push(...externals)
  // Modules of other projects (global view only).
  for (const m of allImported(p)) {
    if (!visible.has(m.id)) continue
    const placements = sides?.get(m.id)
    const size = importedSize(m, p.orientation)
    nodes.push({
      id: m.id,
      type: 'imported',
      position: { ...m.position },
      width: fit(size.width),
      height: fit(
        placements
          ? Math.max(size.height, neededHeight(freePorts(m.ports, anchors), placements))
          : size.height
      ),
      selected: selected.has(m.id),
      draggable: movable(m.id),
      zIndex: Z.module,
      data: portData(m.ports, placements)
    })
  }
  return nodes
}

/**
 * Stand-ins for the modules outside a drill-down view linked to its content. Given where the
 * inside ports are drawn, stand-ins and their ports follow the order of the ports they link to.
 */
export function externalNodes(
  p: Project,
  view: View,
  visible: Set<Id>,
  inside: Map<Id, { x: number; y: number }> | null
): Node<ExternalNodeData>[] {
  const root = p.modules.find((m) => m.id === view.rootModuleId)
  if (!root) return []
  const outside = new Map<Id, ExternalPort[]>()
  /** Inside ports linked to each outside port. */
  const partners = new Map<Id, Id[]>()
  const add = (moduleId: Id, portId: Id, type: 'source' | 'target', partner: Id): void => {
    const port = findPort(p, moduleId, portId)
    if (!port) return
    const list = outside.get(moduleId) ?? []
    if (!list.some((x) => x.id === portId)) list.push({ id: portId, name: port.name, type })
    outside.set(moduleId, list)
    partners.set(portId, [...(partners.get(portId) ?? []), partner])
  }
  for (const l of p.links) {
    const fromIn = visible.has(l.from.moduleId)
    const toIn = visible.has(l.to.moduleId)
    if (fromIn && !toIn) add(l.to.moduleId, l.to.portId, 'target', l.from.portId)
    if (!fromIn && toIn) add(l.from.moduleId, l.from.portId, 'source', l.to.portId)
  }
  const r = root.layout
  const vertical = p.orientation === 'vertical'
  let groups = [...outside]
  if (inside) {
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity)
    const key = (portId: Id): number =>
      mean((partners.get(portId) ?? []).flatMap((id) => inside.get(id)?.[vertical ? 'x' : 'y'] ?? []))
    groups = groups
      .map(([id, ports]) => [id, [...ports].sort((a, b) => key(a.id) - key(b.id))] as const)
      .map(([id, ports]) => ({ id, ports, at: mean(ports.map((pt) => key(pt.id)).filter(Number.isFinite)) }))
      .sort((a, b) => a.at - b.at)
      .map(({ id, ports }) => [id, ports])
  }
  // Next free place along the edge of the view, for senders and receivers.
  let before = vertical ? r.x : r.y
  let after = before
  return groups.map(([moduleId, ports]) => {
    // Senders on the in side of the view (left, or above), receivers on the out side.
    const sender = ports.every((pt) => pt.type === 'source')
    const width = vertical ? Math.max(180, ports.length * 120) : 180
    const height = vertical ? 58 : STAND_IN_HEADER + ports.length * 24
    const along = sender ? before : after
    if (sender) before += (vertical ? width : height) + 20
    else after += (vertical ? width : height) + 20
    const position = vertical
      ? { x: along, y: sender ? r.y - height - 80 : r.y + r.height + 80 }
      : { x: sender ? r.x - width - 80 : r.x + r.width + 80, y: along }
    const side = vertical ? (sender ? 'bottom' : 'top') : sender ? 'right' : 'left'
    return {
      id: EXTERNAL + moduleId,
      type: 'external',
      position,
      width,
      height,
      draggable: false,
      selectable: false,
      zIndex: Z.module,
      data: { label: modulePath(p, moduleId), ports, side }
    }
  })
}

/** Outside modules at their stand-in, in the absolute coordinates of the project. */
export function standIns(p: Project, view: View, externals: Node<ExternalNodeData>[]): Map<Id, StandIn> {
  const root = p.modules.find((m) => m.id === view.rootModuleId)
  const out = new Map<Id, StandIn>()
  if (!root) return out
  // The root of the view is drawn at its layout, not at its absolute place.
  const abs = absoluteRect(p, root.id)
  const dx = abs.x - root.layout.x
  const dy = abs.y - root.layout.y
  for (const n of externals)
    out.set(n.id.slice(EXTERNAL.length), {
      rect: { x: n.position.x + dx, y: n.position.y + dy, width: n.width ?? 0, height: n.height ?? 0 },
      side: n.data.side,
      ports: n.data.ports.map((pt) => pt.id)
    })
  return out
}

export function toEdges(
  p: Project,
  visible: Set<Id>,
  drill: boolean,
  selectedLink: Id | null,
  inheritance: boolean
): Edge[] {
  const end = (moduleId: Id): string | null =>
    visible.has(moduleId) ? moduleId : drill ? EXTERNAL + moduleId : null
  const links = p.links.flatMap((l): Edge[] => {
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
        zIndex: Z.link
      }
    ]
  })
  return inheritance ? [...links, ...inheritEdges(p, visible)] : links
}

export interface ConnectEnd {
  moduleId: Id
  /** null: the module's own handle, linked through a new port. */
  portId: Id | null
  role: PortRole | null
}

export function endOf(p: Project, moduleId: Id, handle: string): ConnectEnd {
  if (handle === MODULE_HANDLE) return { moduleId, portId: null, role: null }
  return { moduleId, portId: handle, role: findPort(p, moduleId, handle)?.role ?? null }
}

/**
 * Ends of a connection drawn between two handles, in link order, or null when their ports cannot
 * be linked (roles, interfaces). Handles are dragged either way: the roles give the direction.
 */
export function linkEnds(p: Project, c: Connection | Edge): [ConnectEnd, ConnectEnd] | null {
  if (!c.sourceHandle || !c.targetHandle) return null
  const a = endOf(p, c.source, c.sourceHandle)
  const b = endOf(p, c.target, c.targetHandle)
  // Module to module: drop on the module instead (onConnectEnd).
  if (!a.portId && !b.portId) return null
  if ((a.portId && !a.role) || (b.portId && !b.role)) return null
  const ends = orderLinkEnds(p, a, b)
  if (!ends) return null
  const [x, y] = ends.map((e) => (e.portId ? findPort(p, e.moduleId, e.portId) : null))
  return !x?.interfaceId || !y?.interfaceId || x.interfaceId === y.interfaceId ? ends : null
}
