// Automatic arrangement of modules with ELK (layered, hierarchical, port aware), placing bases and
// modules holding attributes before the modules they relate to, with as few crossings as possible.
import { produce } from 'immer'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import {
  attributeTargets,
  importedRoots,
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

interface Point {
  x: number
  y: number
}

/** Vertical center of the `i`-th of `rows` port rows of a leaf, centered below its header. */
const portY = (i: number, rows: number, height: number): number =>
  MODULE_HEADER + (height - MODULE_HEADER - rows * PORT_ROW) / 2 + i * PORT_ROW + PORT_ROW / 2

/** Estimated width of a side port's label (name and interface) with its margins. */
function labelWidth(p: Project, pt: Port): number {
  const iface = pt.interfaceId ? (p.interfaces.find((i) => i.id === pt.interfaceId)?.name ?? '?') : '—'
  return 34 + pt.name.length * 7 + iface.length * 6
}

interface Padding {
  top: number
  left: number
  bottom: number
  right: number
}

/**
 * Center each layer (row when `vertical`, column otherwise) of a container on the axis of its
 * content: ELK aligns modules to straighten links, which leaves narrow layers on one side.
 */
function centerLayers(n: ElkNode, vertical: boolean): void {
  const children = n.children ?? []
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

/**
 * Bottom-up: center the layers of each container, then fit it to its content and padding (never
 * below its minimum size). ELK leaves room for links to the container's own ports.
 */
function settle(
  n: ElkNode,
  vertical: boolean,
  frame: (id: string) => { padding: Padding; min: { width: number; height: number } } | undefined
): void {
  const children = n.children ?? []
  for (const c of children) settle(c, vertical, frame)
  centerLayers(n, vertical)
  const f = frame(n.id)
  if (!f || !children.length) return
  const b = boundsOf(
    children.map((c) => ({ x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 }))
  )
  const dx = f.padding.left - b.x
  const dy = f.padding.top - b.y
  for (const c of children) {
    c.x = (c.x ?? 0) + dx
    c.y = (c.y ?? 0) + dy
  }
  n.width = Math.max(f.min.width, f.padding.left + b.width + f.padding.right)
  n.height = Math.max(f.min.height, f.padding.top + b.height + f.padding.bottom)
}

/** Seeds of the ELK runs compared by `score`. */
const SEEDS = [1, 2, 3, 4, 5, 6]

/** Links set the flow and stay straight; relations give way to them. */
const LINK_PRIORITY = {
  'elk.layered.priority.direction': '10',
  'elk.layered.priority.straightness': '10'
}
const RELATION_PRIORITY = {
  'elk.layered.priority.direction': '1',
  'elk.layered.priority.straightness': '0'
}

/** A line between two modules drawn apart from the links: inheritance or association. */
export interface Relation {
  /** Earlier along the flow: the base, or the module holding the attribute. */
  from: Id
  to: Id
}

/**
 * Inheritance and association lines between modules of `nodes`, once per pair (not between a module
 * and its content, drawn inside it).
 */
export function relations(p: Project, nodes: Set<Id>): Relation[] {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const holds = (outer: Id, inner: Id): boolean => {
    for (let cur = byId.get(inner)?.parentId; cur; cur = byId.get(cur)?.parentId)
      if (cur === outer) return true
    return false
  }
  const seen = new Set<string>()
  const out: Relation[] = []
  const add = (from: Id, to: Id): void => {
    if (from === to || !nodes.has(from) || !nodes.has(to) || holds(from, to) || holds(to, from)) return
    const key = from < to ? `${from}>${to}` : `${to}>${from}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ from, to })
  }
  for (const m of p.modules) for (const b of m.bases ?? []) add(b, m.id)
  for (const m of p.modules)
    for (const a of m.attributes) for (const t of attributeTargets(p, a)) add(m.id, t)
  return out
}

/** A straight line between two modules (`ends`), for counting crossings. */
export interface Segment {
  from: Point
  to: Point
  ends: [Id, Id]
}

const orient = (a: Point, b: Point, c: Point): number =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))

const intersects = (a: Segment, b: Segment): boolean =>
  orient(a.from, a.to, b.from) * orient(a.from, a.to, b.to) < 0 &&
  orient(b.from, b.to, a.from) * orient(b.from, b.to, a.to) < 0

/** Crossings between segments, not counting segments with a module in common. */
export function crossings(segments: Segment[]): number {
  let n = 0
  for (const [i, a] of segments.entries())
    for (const b of segments.slice(i + 1))
      if (!a.ends.some((e) => b.ends.includes(e)) && intersects(a, b)) n++
  return n
}

/** Where the segment from the center of `r` towards `to` leaves `r`. */
function borderPoint(r: Rect, to: Point): Point {
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  const dx = to.x - cx
  const dy = to.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const t = Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * t, y: cy + dy * t }
}

/**
 * Crossings and total length of the lines of a laid out graph, as the canvas draws them roughly:
 * links straight between their ports, relations straight between the borders of their modules.
 */
function score(
  root: ElkNode,
  links: ElkExtendedEdge[],
  related: Relation[],
  portOwner: Map<Id, Id>
): { crossings: number; length: number } {
  const boxes = new Map<Id, Rect>()
  const ports = new Map<Id, Point>()
  const walk = (n: ElkNode, ox: number, oy: number): void => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0)
      const y = oy + (c.y ?? 0)
      boxes.set(c.id, { x, y, width: c.width ?? 0, height: c.height ?? 0 })
      for (const pt of c.ports ?? [])
        ports.set(pt.id, {
          x: x + (pt.x ?? 0) + (pt.width ?? 0) / 2,
          y: y + (pt.y ?? 0) + (pt.height ?? 0) / 2
        })
      walk(c, x, y)
    }
  }
  walk(root, 0, 0)
  const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const segments: Segment[] = []
  for (const l of links) {
    const [s, t] = [l.sources[0]!, l.targets[0]!]
    const from = ports.get(s)
    const to = ports.get(t)
    if (from && to) segments.push({ from, to, ends: [portOwner.get(s)!, portOwner.get(t)!] })
  }
  for (const r of related) {
    const a = boxes.get(r.from)
    const b = boxes.get(r.to)
    if (a && b)
      segments.push({ from: borderPoint(a, center(b)), to: borderPoint(b, center(a)), ends: [r.from, r.to] })
  }
  const length = segments.reduce((sum, s) => sum + Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y), 0)
  return { crossings: crossings(segments), length }
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
  // Imported modules sit at the top level, fixed size, with their content.
  const imported = scopeId ? [] : importedRoots(p)
  for (const m of imported) inGraph.add(m.id)
  const related = relations(p, inGraph)
  const portOwner = new Map<Id, Id>()

  const o = options.orientation
  const vertical = o === 'vertical'
  const direction = vertical ? 'DOWN' : 'RIGHT'
  // Leaves get their default size when the ports move to other edges.
  const reset = o !== p.orientation
  // Horizontal: a container's side port labels sit inside its frame (see ModuleNode), clear of its content.
  const labels = (m: Pick<Module, 'ports'>, role: PortRole): number =>
    vertical ? 0 : Math.max(0, ...m.ports.filter((pt) => pt.role === role).map((pt) => labelWidth(p, pt)))
  const paddingOf = (m: Pick<Module, 'ports' | 'attributes' | 'methods'>): Padding => ({
    top: contentTop(o, m) + LAYOUT_PAD / 2,
    left: Math.max(LAYOUT_PAD, labels(m, 'in')),
    bottom: contentBottom(o),
    right: Math.max(LAYOUT_PAD, labels(m, 'out'))
  })
  const padding = (m: Pick<Module, 'ports' | 'attributes' | 'methods'>): string => {
    const { top, left, bottom, right } = paddingOf(m)
    return `[top=${top},left=${left},bottom=${bottom},right=${right}]`
  }

  // Spacing applies to each container's own content.
  const spacing = {
    'elk.spacing.nodeNode': String(options.spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(options.spacing * 1.6),
    'elk.spacing.edgeNode': String(options.spacing / 3),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(options.spacing / 3),
    // Fewer crossings, at some cost.
    'elk.layered.thoroughness': '30',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED'
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
    return [
      ...ins.map((pt, i) => port(pt.id, i, 'in')),
      ...outs.map((pt, i) => port(pt.id, i, 'out')),
      ...relationPorts(ownerId, ins.length, outs.length, width, height, leaf)
    ]
  }

  // Relations end on ports of their own, centered on the sides links come in and go out.
  const relationIn = (id: Id): Id => `__relation_in__${id}`
  const relationOut = (id: Id): Id => `__relation_out__${id}`
  const relationEnds = { in: new Set(related.map((r) => r.to)), out: new Set(related.map((r) => r.from)) }
  const relationPorts = (
    ownerId: Id,
    ins: number,
    outs: number,
    width: number,
    height: number,
    leaf: boolean
  ): ElkPort[] => {
    const port = (role: 'in' | 'out'): ElkPort => {
      const side = vertical ? (role === 'in' ? 'NORTH' : 'SOUTH') : role === 'in' ? 'WEST' : 'EAST'
      const x = vertical ? width / 2 - 1 : role === 'in' ? -1 : width - 1
      const y = vertical ? (role === 'in' ? -1 : height - 1) : height / 2 - 1
      return {
        id: role === 'in' ? relationIn(ownerId) : relationOut(ownerId),
        width: 2,
        height: 2,
        ...(leaf ? { x, y } : {}),
        layoutOptions: { 'elk.port.side': side, 'elk.port.index': String(role === 'in' ? ins : outs) }
      }
    }
    return [
      ...(relationEnds.in.has(ownerId) ? [port('in')] : []),
      ...(relationEnds.out.has(ownerId) ? [port('out')] : [])
    ]
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
  const children = [...childModules(p, scopeId).map(node), ...imported.map(importedNode)]
  const links: ElkExtendedEdge[] = p.links
    .filter((l) => portOwner.has(l.from.portId) && portOwner.has(l.to.portId))
    .map((l) => ({
      id: l.id,
      sources: [l.from.portId],
      targets: [l.to.portId],
      layoutOptions: LINK_PRIORITY
    }))
  const relationEdges = related.map((r, i): ElkExtendedEdge => ({
    id: `__relation__${i}`,
    sources: [relationOut(r.from)],
    targets: [relationIn(r.to)],
    layoutOptions: RELATION_PRIORITY
  }))

  const graph = (seed: number, withRelations: boolean): ElkNode => ({
    id: '__root__',
    children: structuredClone(children),
    edges: structuredClone(withRelations ? [...links, ...relationEdges] : links),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      ...spacing,
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.randomSeed': String(seed),
      'elk.padding': scope ? padding(scope) : `[top=0,left=0,bottom=0,right=0]`
    }
  })

  elk ??= new ELK()
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  // ELK counts crossings on its own routes: keep the run whose lines, as drawn, cross the least.
  const layout = async (withRelations: boolean) => {
    const settled = await Promise.allSettled(
      SEEDS.map(async (seed) => {
        const result = await elk!.layout(graph(seed, withRelations))
        settle(result, vertical, (id) => {
          const m = id === '__root__' ? scope : byId.get(id)
          return m && { padding: paddingOf(m), min: minSize(m, o) }
        })
        return { result, score: score(result, links, related, portOwner) }
      })
    )
    const runs = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    if (!runs.length) throw (settled[0] as PromiseRejectedResult).reason
    return runs
  }
  // ELK may fail on relations across nested modules: then without them.
  const runs = related.length ? await layout(true).catch(() => layout(false)) : await layout(false)
  const { result } = runs.reduce((a, b) =>
    b.score.crossings < a.score.crossings ||
    (b.score.crossings === a.score.crossings && b.score.length < a.score.length)
      ? b
      : a
  )

  const rects = new Map<Id, Rect>()
  const collect = (n: ElkNode): void => {
    for (const c of n.children ?? []) {
      if (inGraph.has(c.id))
        rects.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 })
      collect(c)
    }
  }
  collect(result)
  // The arranged container fits its new content.
  if (scope) rects.set(scope.id, { ...scope.layout, width: result.width ?? 0, height: result.height ?? 0 })

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
