// React Flow graph of a view: nodes and edges built from the project as the view draws it (see
// inView: a drill-down view adds the modules outside it), and the link ends of a connection drawn
// between two handles.
import { MarkerType, type Connection, type Edge, type Node } from '@xyflow/react'
import {
  allImported,
  compartmentsHeight,
  findPort,
  importedSize,
  orderLinkEnds,
  viewNotes
} from '@/model/project'
import { ceilToGrid } from '@/model/grid'
import { outsideOf, shownModuleIds } from '@/model/viewLayout'
import type { Id, LinkAnchor, PortRole, Project, View } from '@/model/types'
import { inheritEdges } from './inheritEdges'
import { MODULE_HANDLE, PERF_COLORS, Z } from './constants'
import {
  containerIds,
  freePorts,
  neededHeight,
  portAnchors,
  type PortPlacement,
  type PortSides
} from './portSides'

/** Data of module and imported module nodes: where their ports are drawn. */
export type PortNodeData = {
  /** Floating ports (see portSides.ts); else the orientation's default edges. */
  sides?: Record<Id, PortPlacement>
  /** Ports at a hand-set link attachment (see portAnchors), out of their edge's rows. */
  anchors: Record<Id, LinkAnchor>
  /** Root of a drill-down view: moved and resized in it, never into another module. */
  frame?: true
  /** Module outside a drill-down view: drawn compact, without its content. */
  outside?: true
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
  grid: number | null,
  selectToMove = false
): Node[] {
  const movable = (id: Id): boolean => !selectToMove || selected.has(id)
  // On the grid, sizes grown for their ports stay multiples of it.
  const fit = (v: number): number => (grid ? ceilToGrid(v, grid) : v)
  const visible = shownModuleIds(p, view)
  const outside = outsideOf(p)
  const nodes: Node[] = []
  for (const n of viewNotes(p, view))
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
  const parents = containerIds(p)
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
        ? Math.max(
            m.layout.height,
            fit(neededHeight(freePorts(m.ports, anchors), placements, compartmentsHeight(m)))
          )
        : m.layout.height,
      // The root of a drill-down view and the modules outside it are drawn at the top level.
      parentId: m.parentId ?? undefined,
      draggable: !m.locked && movable(m.id),
      selected: selected.has(m.id),
      zIndex: containers.has(m.id) ? Z.container : Z.module,
      data: {
        ...portData(m.ports, placements),
        ...(isRoot && { frame: true as const }),
        ...(outside.has(m.id) && { outside: true as const })
      }
    })
  }
  // Modules of other projects (global view, or outside a drill-down view).
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
      data: { ...portData(m.ports, placements), ...(outside.has(m.id) && { outside: true as const }) }
    })
  }
  return nodes
}

/** Links between the modules a view draws (see shownModuleIds). */
export function toEdges(p: Project, shown: Set<Id>, selectedLink: Id | null, inheritance: boolean): Edge[] {
  const links = p.links.flatMap((l): Edge[] => {
    const source = l.from.moduleId
    const target = l.to.moduleId
    if (!shown.has(source) || !shown.has(target)) return []
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
  return inheritance ? [...links, ...inheritEdges(p, shown)] : links
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
