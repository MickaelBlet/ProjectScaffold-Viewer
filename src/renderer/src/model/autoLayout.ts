// Automatic arrangement of modules with ELK (layered, hierarchical, port aware).
import { produce } from 'immer'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import {
  boundsOf,
  childModules,
  contentBottom,
  contentTop,
  defaultSize,
  growAncestors,
  LAYOUT_PAD,
  MODULE_HEADER,
  minSize,
  PORT_ROW,
  subtreeIds
} from './project'
import type { Id, Module, Orientation, Project, Rect } from './types'

export interface ArrangeOptions {
  /** `horizontal`: layers left to right, ports on the sides. `vertical`: top to bottom, ports on top / bottom. */
  orientation: Orientation
  /** Space between modules. */
  spacing: number
}

export const DEFAULT_ARRANGE: ArrangeOptions = { orientation: 'horizontal', spacing: 70 }

export function arrangeOptions(orientation: Orientation): ArrangeOptions {
  return { ...DEFAULT_ARRANGE, orientation }
}

let elk: InstanceType<typeof ELK> | null = null

/** Vertical center of the `i`-th port row of a module. */
const portY = (i: number): number => MODULE_HEADER + 6 + i * PORT_ROW + PORT_ROW / 2

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
  const padding = (m: Pick<Module, 'ports'>): string =>
    `[top=${contentTop(m, o) + LAYOUT_PAD / 2},left=${LAYOUT_PAD},bottom=${contentBottom(o)},right=${LAYOUT_PAD}]`

  // Spacing applies to each container's own content.
  const spacing = {
    'elk.spacing.nodeNode': String(options.spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(options.spacing * 1.6),
    'elk.spacing.edgeNode': String(options.spacing / 3),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(options.spacing / 3)
  }

  const node = (m: Module): ElkNode => {
    const children = childModules(p, m.id).map(node)
    const ins = m.ports.filter((pt) => pt.role === 'in')
    const outs = m.ports.filter((pt) => pt.role === 'out')
    const leaf = !children.length
    const min = minSize(m, o)
    const size = reset ? defaultSize(m, o) : m.layout
    const width = leaf ? Math.max(size.width, min.width) : min.width
    const height = leaf ? Math.max(size.height, min.height) : min.height
    const port = (id: Id, i: number, role: 'in' | 'out'): ElkPort => {
      portOwner.set(id, m.id)
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
        ...(leaf ? { x: side === 'WEST' ? -1 : width - 1, y: portY(i) - 1 } : {}),
        layoutOptions: {
          'elk.port.side': side,
          'elk.port.index': String(side === 'WEST' ? ins.length - i : i)
        }
      }
    }
    return {
      id: m.id,
      width,
      height,
      children,
      ports: [...ins.map((pt, i) => port(pt.id, i, 'in')), ...outs.map((pt, i) => port(pt.id, i, 'out'))],
      layoutOptions: {
        'elk.portConstraints': leaf ? 'FIXED_POS' : 'FIXED_ORDER',
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

  const children = childModules(p, scopeId).map(node)
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
    const tops = childModules(p, null)
    const before = boundsOf(tops.map((m) => m.layout))
    const after = boundsOf(tops.flatMap((m) => rects.get(m.id) ?? []))
    for (const m of tops) {
      const r = rects.get(m.id)
      if (r) rects.set(m.id, { ...r, x: r.x - after.x + before.x, y: r.y - after.y + before.y })
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
    for (const m of d.modules) if (rects.has(m.id)) growAncestors(d, m.id)
    if (scopeId) growAncestors(d, childModules(d, scopeId)[0]?.id ?? scopeId)
  })
}
