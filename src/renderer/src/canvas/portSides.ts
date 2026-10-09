// Floating ports: each port of a module sits on the edge facing the modules it is linked to, with
// its name, so that links leave from where the port is drawn. A container's port linked to its
// content keeps its edge.
import { absoluteRect, allImported, MODULE_HEADER, PORT_BAND, PORT_ROW, subtreeIds } from '@/model/project'
import type { Id, LinkAnchor, Orientation, PortRole, Project, Rect } from '@/model/types'
import type { Side } from './linkEnds'
import { outsideOf } from '@/model/viewLayout'
import { anchorPoint } from './linkRoute'

export interface PortPlacement {
  side: Side
  /** Position along a top / bottom band (the linked modules' center x); null keeps the port order. */
  order: number | null
}

/** Ports by module, for the modules whose ports float. */
export type PortSides = Map<Id, Record<Id, PortPlacement>>

export function defaultSide(role: PortRole, o: Orientation): Side {
  if (o === 'vertical') return role === 'in' ? 'top' : 'bottom'
  return role === 'in' ? 'left' : 'right'
}

const centerX = (r: Rect): number => r.x + r.width / 2
const centerY = (r: Rect): number => r.y + r.height / 2

/**
 * Edge of `a` facing `b`. Horizontal orientation: modules one above the other face through their
 * top / bottom edges, others through their sides. Vertical orientation mirrors this.
 */
export function facingSide(a: Rect, b: Rect, o: Orientation): Side {
  const below = b.y >= a.y + a.height
  const vGap = below ? b.y - (a.y + a.height) : a.y - (b.y + b.height)
  const right = b.x >= a.x + a.width
  const hGap = right ? b.x - (a.x + a.width) : a.x - (b.x + b.width)
  if (o === 'horizontal') {
    if (vGap > 0 && vGap >= hGap) return below ? 'bottom' : 'top'
    return centerX(b) < centerX(a) ? 'left' : 'right'
  }
  if (hGap > 0 && hGap >= vGap) return right ? 'right' : 'left'
  return centerY(b) < centerY(a) ? 'top' : 'bottom'
}

/** Stand-in of a module outside a drill-down view: its rect and its ports, in order, on one edge. */
/** Modules drawn with content: holding others, unless outside a drill-down view. */
export function containerIds(p: Project): Set<Id> {
  const outside = outsideOf(p)
  return new Set(p.modules.flatMap((m) => (m.parentId && !outside.has(m.parentId) ? m.parentId : [])))
}

/** Barycenter sweeps ordering the ports along their edges. */
const SWEEPS = 4

interface Point {
  x: number
  y: number
}

/** Point of the `i`th of `n` ports on an edge of `r`; rows start `rowsTop` below its top. */
function portPoint(r: Rect, side: Side, i: number, n: number, rowsTop: number): Point {
  const y = r.y + rowsTop + PORT_ROW * (i + 0.5)
  const x = r.x + (r.width * (i + 0.5)) / n
  switch (side) {
    case 'left':
      return { x: r.x, y }
    case 'right':
      return { x: r.x + r.width, y }
    case 'top':
      return { x, y: r.y }
    case 'bottom':
      return { x, y: r.y + r.height }
  }
}

const SIDES: Side[] = ['left', 'right', 'top', 'bottom']

/**
 * Top of a module's side port rows, relative to it: centered between the header (and top band)
 * and the bottom band, centered on the frame of a container (drawn outside it). See ModuleNode.
 */
function rowsTop(
  ports: { id: Id }[],
  placements: Record<Id, PortPlacement>,
  anchors: Map<Id, LinkAnchor>,
  r: Rect,
  container: boolean,
  o: Orientation,
  floating: boolean
): number {
  const free = freePorts(ports, anchors)
  const count = (side: Side): number => free.filter((pt) => placements[pt.id]?.side === side).length
  const vertical = o === 'vertical'
  const topBand = count('top') > 0 || (vertical && (!floating || container))
  const bottomBand = count('bottom') > 0 || (vertical && (!floating || container))
  const rows = Math.max(count('left'), count('right'))
  const body = MODULE_HEADER + (topBand ? PORT_BAND : 0)
  if (container) return (r.height - rows * PORT_ROW) / 2
  return body + (r.height - body - (bottomBand ? PORT_BAND : 0) - rows * PORT_ROW) / 2
}

/** Where each port of a module is drawn (near enough to order the ports linked to it). */
function placePorts(
  ports: { id: Id }[],
  placements: Record<Id, PortPlacement>,
  anchors: Map<Id, LinkAnchor>,
  r: Rect,
  rowsTop: number,
  out: Map<Id, Point>
): void {
  const free = freePorts(ports, anchors)
  for (const side of SIDES) {
    const on = portsOn(free, placements, side)
    on.forEach((pt, i) => out.set(pt.id, portPoint(r, side, i, on.length, rowsTop)))
  }
  for (const pt of ports) {
    const a = anchors.get(pt.id)
    if (a) out.set(pt.id, anchorPoint(r, a))
  }
}

/**
 * Ports drawn at a hand-set attachment of one of their links (the first one on the edge the port
 * is placed on, any edge when ports do not float), not in their edge's rows.
 */
export function portAnchors(p: Project, sides: PortSides | null): Map<Id, LinkAnchor> {
  const out = new Map<Id, LinkAnchor>()
  for (const l of p.links)
    for (const [end, anchor] of [
      [l.from, l.route?.from],
      [l.to, l.route?.to]
    ] as const) {
      if (!anchor || out.has(end.portId)) continue
      const placed = sides?.get(end.moduleId)?.[end.portId]
      if (placed && placed.side !== anchor.side) continue
      out.set(end.portId, anchor)
    }
  return out
}

/** Ports of a module drawn in their edge's rows, not at an attachment. */
export function freePorts<T extends { id: Id }>(ports: T[], anchors: Map<Id, LinkAnchor>): T[] {
  return ports.filter((pt) => !anchors.has(pt.id))
}

/**
 * Placement of the ports of the visible modules (imported ones included). A port linked several
 * times goes where most of its links go; unlinked ports, links to hidden or enclosing modules, and
 * container ports linked to their content keep the orientation's default edge, unless a link is
 * attached by hand elsewhere. Modules outside a drill-down view (see outsideOf) are drawn
 * without their content.
 *
 * Along an edge, ports follow the ports they are linked to (barycenter sweeps), so that the links
 * between two edges do not cross.
 */
export function floatingPortSides(p: Project, visible: Set<Id>): PortSides {
  const parents = containerIds(p)
  const rects = new Map<Id, Rect>()
  const rect = (id: Id): Rect => {
    let r = rects.get(id)
    if (!r) rects.set(id, (r = absoluteRect(p, id)))
    return r
  }
  const nested = (a: Id, b: Id): boolean => subtreeIds(p, a).has(b) || subtreeIds(p, b).has(a)
  /** Link ends of each port: the edge facing the other end, and that end. */
  const ends = new Map<
    Id,
    { side: Side; other: { moduleId: Id; portId: Id }; index: number; anchored: boolean }[]
  >()
  /** Container ports linked to their content. */
  const pinned = new Set<Id>()
  for (const [index, l] of p.links.entries())
    for (const [end, other] of [
      [l.from, l.to],
      [l.to, l.from]
    ] as const) {
      if (!visible.has(end.moduleId)) continue
      if (parents.has(end.moduleId) && subtreeIds(p, end.moduleId).has(other.moduleId)) pinned.add(end.portId)
      // A hand-set attachment takes its port to its side, whatever the other end.
      const anchor = end === l.from ? l.route?.from : l.route?.to
      if (!anchor && (!visible.has(other.moduleId) || nested(end.moduleId, other.moduleId))) continue
      const side = anchor?.side ?? facingSide(rect(end.moduleId), rect(other.moduleId), p.orientation)
      const list = ends.get(end.portId) ?? []
      list.push({ side, other, index, anchored: !!anchor })
      ends.set(end.portId, list)
    }

  const out: PortSides = new Map()
  const modules = [...p.modules, ...allImported(p)].filter((m) => visible.has(m.id))
  for (const m of modules) {
    const placements: Record<Id, PortPlacement> = {}
    for (const pt of m.ports) {
      const fallback = defaultSide(pt.role, p.orientation)
      // Container ports linked to their content keep their edge, unless attached elsewhere by hand.
      const list = (ends.get(pt.id) ?? []).filter((v) => v.anchored || !pinned.has(pt.id))
      const count = new Map<Side, number>()
      for (const v of list) count.set(v.side, (count.get(v.side) ?? 0) + 1)
      const best = Math.max(0, ...count.values())
      // Ties keep the default edge when it is one of them.
      const side = !list.length
        ? fallback
        : count.get(fallback) === best
          ? fallback
          : [...count].find(([, n]) => n === best)![0]
      placements[pt.id] = { side, order: null }
    }
    out.set(m.id, placements)
  }

  const anchors = portAnchors(p, out)
  const top = (m: (typeof modules)[number], placements: Record<Id, PortPlacement>): number =>
    rowsTop(m.ports, placements, anchors, rect(m.id), parents.has(m.id), p.orientation, true)
  const points = new Map<Id, Point>()
  for (const m of modules)
    placePorts(m.ports, out.get(m.id)!, anchors, rect(m.id), top(m, out.get(m.id)!), points)
  for (let sweep = 0; sweep < SWEEPS; sweep++)
    for (const m of modules) {
      const placements = out.get(m.id)!
      for (const pt of m.ports) {
        const { side } = placements[pt.id]!
        const list =
          pinned.has(pt.id) || anchors.has(pt.id)
            ? []
            : (ends.get(pt.id) ?? []).filter((e) => e.side === side)
        if (!list.length) continue
        const axis = side === 'top' || side === 'bottom' ? 'x' : 'y'
        // Links between the same two ports keep their order at both ends.
        const at = list.flatMap((e) => {
          const pt = points.get(e.other.portId)
          return pt ? [pt[axis] + e.index * 1e-6] : []
        })
        if (!at.length) continue
        placements[pt.id] = { side, order: at.reduce((a, b) => a + b, 0) / at.length }
      }
      placePorts(m.ports, placements, anchors, rect(m.id), top(m, placements), points)
    }
  return out
}

/** Where the ports of the visible modules are drawn, placed by `sides` or on their default edges. */
export function portPoints(p: Project, visible: Set<Id>, sides: PortSides | null): Map<Id, Point> {
  const parents = containerIds(p)
  const anchors = portAnchors(p, sides)
  const points = new Map<Id, Point>()
  for (const m of [...p.modules, ...allImported(p)]) {
    if (!visible.has(m.id)) continue
    const placements =
      sides?.get(m.id) ??
      Object.fromEntries(
        m.ports.map((pt) => [pt.id, { side: defaultSide(pt.role, p.orientation), order: null }])
      )
    const r = absoluteRect(p, m.id)
    const top = rowsTop(m.ports, placements, anchors, r, parents.has(m.id), p.orientation, !!sides)
    placePorts(m.ports, placements, anchors, r, top, points)
  }
  return points
}

/** Ports of a module on one edge, in drawing order. */
export function portsOn<T extends { id: Id }>(
  ports: T[],
  placements: Record<Id, PortPlacement>,
  side: Side
): T[] {
  const on = ports.filter((pt) => placements[pt.id]?.side === side)
  // Linked ports follow the ports they link to; unlinked ones stay in their order, last.
  return on
    .map((pt, i) => ({ pt, i, order: placements[pt.id]!.order }))
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.i - b.i)
    .map((x) => x.pt)
}

/** Height a module needs to draw its ports where they are placed, below its `compartments` height. */
export function neededHeight(
  ports: { id: Id }[],
  placements: Record<Id, PortPlacement>,
  compartments = 0
): number {
  const count = (side: Side): number => portsOn(ports, placements, side).length
  const rows = Math.max(count('left'), count('right'))
  const bands = (count('top') ? 1 : 0) + (count('bottom') ? 1 : 0)
  return MODULE_HEADER + compartments + bands * PORT_BAND + (rows ? rows * PORT_ROW + 12 : 12)
}
