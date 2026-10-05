// Automatic arrangement of modules with ELK (layered, hierarchical, port aware).
import { produce } from 'immer'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import {
  allImported,
  boundsOf,
  childModules,
  contentBottom,
  contentTop,
  defaultSize,
  growAncestors,
  importedSize,
  LAYOUT_PAD,
  MODULE_HEADER,
  minSize,
  PORT_ROW,
  subtreeIds
} from './project'
import type { Id, ImportedModule, Module, Orientation, Port, PortRole, Project, Rect } from './types'

export interface ArrangeOptions {
  /** `horizontal`: layers left to right, ports on the sides. `vertical`: top to bottom, ports on top / bottom. */
  orientation: Orientation
  /** Space between modules. */
  spacing: number
}

const DEFAULT_ARRANGE: ArrangeOptions = { orientation: 'horizontal', spacing: 70 }

export function arrangeOptions(orientation: Orientation): ArrangeOptions {
  return { ...DEFAULT_ARRANGE, orientation }
}

let elk: InstanceType<typeof ELK> | null = null

/** Vertical center of the `i`-th of `rows` port rows of a leaf, centered below its header. */
const portY = (i: number, rows: number, height: number): number =>
  MODULE_HEADER + (height - MODULE_HEADER - rows * PORT_ROW) / 2 + i * PORT_ROW + PORT_ROW / 2

/** Estimated width of a side port's label (name and interface) with its margins. */
function labelWidth(p: Project, pt: Port): number {
  const iface = pt.interfaceId ? (p.interfaces.find((i) => i.id === pt.interfaceId)?.name ?? '?') : '—'
  return 34 + pt.name.length * 7 + iface.length * 6
}

/**
 * Center each layer (row when `vertical`, column otherwise) of every container on the axis of its
 * content: ELK aligns modules to straighten links, which leaves narrow layers on one side.
 */
function centerLayers(n: ElkNode, vertical: boolean): void {
  const children = n.children ?? []
  for (const c of children) centerLayers(c, vertical)
  if (children.length < 2) return
  // Along the flow, cross-axis otherwise.
  const flow = (c: ElkNode): [number, number] =>
    vertical ? [c.y ?? 0, (c.y ?? 0) + (c.height ?? 0)] : [c.x ?? 0, (c.x ?? 0) + (c.width ?? 0)]
  const cross = (c: ElkNode): [number, number] =>
    vertical ? [c.x ?? 0, (c.x ?? 0) + (c.width ?? 0)] : [c.y ?? 0, (c.y ?? 0) + (c.height ?? 0)]
  const mid = (list: ElkNode[]): number =>
    (Math.min(...list.map((c) => cross(c)[0])) + Math.max(...list.map((c) => cross(c)[1]))) / 2
  // Layers: modules overlapping along the flow.
  const layers: ElkNode[][] = []
  let end = -Infinity
  for (const c of [...children].sort((a, b) => flow(a)[0] - flow(b)[0])) {
    if (flow(c)[0] >= end) layers.push([])
    layers[layers.length - 1]!.push(c)
    end = Math.max(end, flow(c)[1])
  }
  const axis = mid(children)
  for (const layer of layers) {
    const shift = axis - mid(layer)
    for (const c of layer) {
      if (vertical) c.x = (c.x ?? 0) + shift
      else c.y = (c.y ?? 0) + shift
    }
  }
}

/** New rects (parent-relative) for the modules inside `scopeId` (or all modules). */
export async function computeArrangement(
  p: Project,
  scopeId: Id | null,
  options: ArrangeOptions = DEFAULT_ARRANGE
): Promise<Map<Id, Rect>> {
  const scope = scopeId ? p.modules.find((m) => m.id === scopeId) : undefined
  const inGraph = new Set(scopeId ? subtreeIds(p, scopeId) : p.modules.map((m) => m.id))
  if (scopeId) inGraph.delete(scopeId)
  const portOwner = new Map<Id, Id>()

  const o = options.orientation
  const vertical = o === 'vertical'
  const direction = vertical ? 'DOWN' : 'RIGHT'
  // Leaves get their default size when the ports move to other edges.
  const reset = o !== p.orientation
  // Horizontal: a container's side port labels sit inside its frame (see ModuleNode), clear of its content.
  const labels = (m: Pick<Module, 'ports'>, role: PortRole): number =>
    vertical ? 0 : Math.max(0, ...m.ports.filter((pt) => pt.role === role).map((pt) => labelWidth(p, pt)))
  const padding = (m: Pick<Module, 'ports' | 'attributes' | 'methods'>): string =>
    `[top=${contentTop(o, m) + LAYOUT_PAD / 2},left=${Math.max(LAYOUT_PAD, labels(m, 'in'))},` +
    `bottom=${contentBottom(o)},right=${Math.max(LAYOUT_PAD, labels(m, 'out'))}]`

  // Spacing applies to each container's own content.
  const spacing = {
    'elk.spacing.nodeNode': String(options.spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(options.spacing * 1.6),
    'elk.spacing.edgeNode': String(options.spacing / 3),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(options.spacing / 3)
  }

  /** ELK ports of a module (fixed positions on a leaf). */
  const portsOf = (
    ownerId: Id,
    ports: { id: Id; role: PortRole }[],
    width: number,
    height: number,
    leaf: boolean
  ): ElkPort[] => {
    const ins = ports.filter((pt) => pt.role === 'in')
    const outs = ports.filter((pt) => pt.role === 'out')
    const port = (id: Id, i: number, role: 'in' | 'out'): ElkPort => {
      portOwner.set(id, ownerId)
      if (vertical) {
        // Ports share their band evenly (see ModuleNode).
        const n = role === 'in' ? ins.length : outs.length
        return {
          id,
          width: 2,
          height: 2,
          ...(leaf ? { x: ((i + 0.5) * width) / n - 1, y: role === 'in' ? -1 : height - 1 } : {}),
          layoutOptions: { 'elk.port.side': role === 'in' ? 'NORTH' : 'SOUTH', 'elk.port.index': String(i) }
        }
      }
      const side = role === 'in' ? 'WEST' : 'EAST'
      return {
        id,
        width: 2,
        height: 2,
        ...(leaf
          ? {
              x: side === 'WEST' ? -1 : width - 1,
              y: portY(i, Math.max(ins.length, outs.length), height) - 1
            }
          : {}),
        layoutOptions: {
          'elk.port.side': side,
          'elk.port.index': String(side === 'WEST' ? ins.length - i : i)
        }
      }
    }
    return [...ins.map((pt, i) => port(pt.id, i, 'in')), ...outs.map((pt, i) => port(pt.id, i, 'out'))]
  }

  const node = (m: Module): ElkNode => {
    const children = childModules(p, m.id).map(node)
    const leaf = !children.length
    const min = minSize(m, o)
    const size = reset ? defaultSize(m, o) : m.layout
    const width = leaf ? Math.max(size.width, min.width) : min.width
    const height = leaf ? Math.max(size.height, min.height) : min.height
    return {
      id: m.id,
      width,
      height,
      children,
      ports: portsOf(m.id, m.ports, width, height, leaf),
      layoutOptions: {
        'elk.portConstraints': leaf ? 'FIXED_POS' : 'FIXED_ORDER',
        // Centered in their layer rather than aligned on its start.
        'elk.alignment': 'CENTER',
        ...(leaf
          ? {}
          : {
              ...spacing,
              'elk.direction': direction,
              'elk.padding': padding(m),
              'elk.nodeSize.constraints': 'MINIMUM_SIZE',
              'elk.nodeSize.minimum': `(${width}, ${height})`
            })
      }
    }
  }

  // Imported modules sit at the top level, fixed size.
  const imported = scopeId ? [] : allImported(p)
  const importedNode = (m: ImportedModule): ElkNode => {
    const { width, height } = importedSize(m, o)
    return {
      id: m.id,
      width,
      height,
      ports: portsOf(m.id, m.ports, width, height, true),
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS', 'elk.alignment': 'CENTER' }
    }
  }
  for (const m of imported) inGraph.add(m.id)
  const children = [...childModules(p, scopeId).map(node), ...imported.map(importedNode)]
  const edges: ElkExtendedEdge[] = p.links
    .filter((l) => portOwner.has(l.from.portId) && portOwner.has(l.to.portId))
    .map((l) => ({ id: l.id, sources: [l.from.portId], targets: [l.to.portId] }))

  const graph: ElkNode = {
    id: '__root__',
    children,
    edges,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      ...spacing,
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.padding': scope ? padding(scope) : `[top=0,left=0,bottom=0,right=0]`
    }
  }

  elk ??= new ELK()
  const result = await elk.layout(graph)
  centerLayers(result, vertical)
  const rects = new Map<Id, Rect>()
  const collect = (n: ElkNode): void => {
    for (const c of n.children ?? []) {
      if (inGraph.has(c.id))
        rects.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 })
      collect(c)
    }
  }
  collect(result)

  // Top level: keep the arrangement where the modules were.
  if (!scopeId) {
    const tops = [
      ...childModules(p, null).map((m) => ({ id: m.id, rect: m.layout })),
      ...imported.map((m) => ({ id: m.id, rect: { ...m.position, ...importedSize(m, p.orientation) } }))
    ]
    const before = boundsOf(tops.map((t) => t.rect))
    const after = boundsOf(tops.flatMap((t) => rects.get(t.id) ?? []))
    for (const t of tops) {
      const r = rects.get(t.id)
      if (r) rects.set(t.id, { ...r, x: r.x - after.x + before.x, y: r.y - after.y + before.y })
    }
  }
  return rects
}

/** The project with the modules inside `scopeId` (or all modules) arranged. */
export async function arrange(
  p: Project,
  scopeId: Id | null,
  options: ArrangeOptions = DEFAULT_ARRANGE
): Promise<Project> {
  const rects = await computeArrangement(p, scopeId, options)
  return applyArrangement(p, rects, scopeId, options.orientation)
}

export function applyArrangement(
  p: Project,
  rects: Map<Id, Rect>,
  scopeId: Id | null,
  orientation: Orientation = p.orientation
): Project {
  return produce(p, (d) => {
    d.orientation = orientation
    for (const m of d.modules) {
      const r = rects.get(m.id)
      if (r)
        m.layout = {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
    }
    for (const m of d.dependencies.flatMap((x) => x.modules)) {
      const r = rects.get(m.id)
      if (r) m.position = { x: Math.round(r.x), y: Math.round(r.y) }
    }
    for (const m of d.modules) if (rects.has(m.id)) growAncestors(d, m.id)
    if (scopeId) growAncestors(d, childModules(d, scopeId)[0]?.id ?? scopeId)
  })
}
