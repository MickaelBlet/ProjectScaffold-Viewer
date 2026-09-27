// Floating ports: each port of a module sits on the edge facing the modules it is linked to, with
// its name, so that links leave from where the port is drawn. A container's port linked to its
// content keeps its edge.
import { absoluteRect, allImported, MODULE_HEADER, PORT_BAND, PORT_ROW, subtreeIds } from '@/model/project'
import type { Id, Orientation, PortRole, Project, Rect } from '@/model/types'
import type { Side } from './linkEnds'

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
export interface StandIn {
  rect: Rect
  side: Side
  ports: Id[]
}

/** Height of a stand-in's label, above its port rows. */
export const STAND_IN_HEADER = 34
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

/** Where each port of a module is drawn (near enough to order the ports linked to it). */
function placePorts(
  ports: { id: Id }[],
  placements: Record<Id, PortPlacement>,
  r: Rect,
  topBand: boolean,
  out: Map<Id, Point>
): void {
  const rowsTop = MODULE_HEADER + (topBand ? PORT_BAND : 0) + 6
  for (const side of SIDES) {
    const on = portsOn(ports, placements, side)
    on.forEach((pt, i) => out.set(pt.id, portPoint(r, side, i, on.length, rowsTop)))
  }
}

/** Where the ports of the stand-ins are drawn. */
function placeStandIns(standIns: Map<Id, StandIn>, out: Map<Id, Point>): void {
  for (const s of standIns.values())
    s.ports.forEach((id, i) => out.set(id, portPoint(s.rect, s.side, i, s.ports.length, STAND_IN_HEADER)))
}

/**
 * Placement of the ports of the visible modules (imported ones included). A port linked several
 * times goes where most of its links go; unlinked ports, links to hidden or enclosing modules, and
 * container ports linked to their content keep the orientation's default edge. `standIns` are the
 * modules outside a drill-down view, drawn at their stand-in.
 *
 * Along an edge, ports follow the ports they are linked to (barycenter sweeps), so that the links
 * between two edges do not cross.
 */
export function floatingPortSides(p: Project, visible: Set<Id>, standIns = new Map<Id, StandIn>()): PortSides {
  const parents = new Set(p.modules.flatMap((m) => m.parentId ?? []))
  const rects = new Map<Id, Rect>()
  const rect = (id: Id): Rect => {
    let r = standIns.get(id)?.rect ?? rects.get(id)
    if (!r) rects.set(id, (r = absoluteRect(p, id)))
    return r
  }
  const nested = (a: Id, b: Id): boolean => subtreeIds(p, a).has(b) || subtreeIds(p, b).has(a)
  /** Link ends of each port: the edge facing the other end, and that end. */
  const ends = new Map<Id, { side: Side; other: { moduleId: Id; portId: Id }; index: number }[]>()
  /** Container ports linked to their content. */
  const pinned = new Set<Id>()
  for (const [index, l] of p.links.entries())
    for (const [end, other] of [
      [l.from, l.to],
      [l.to, l.from]
    ] as const) {
      if (!visible.has(end.moduleId)) continue
      if (parents.has(end.moduleId) && subtreeIds(p, end.moduleId).has(other.moduleId)) pinned.add(end.portId)
      if (!(visible.has(other.moduleId) || standIns.has(other.moduleId)) || nested(end.moduleId, other.moduleId))
        continue
      // A hand-set attachment takes its port to its side.
      const anchor = end === l.from ? l.route?.from : l.route?.to
      const side = anchor?.side ?? facingSide(rect(end.moduleId), rect(other.moduleId), p.orientation)
      const list = ends.get(end.portId) ?? []
      list.push({ side, other, index })
      ends.set(end.portId, list)
    }

  const out: PortSides = new Map()
  const modules = [...p.modules, ...allImported(p)].filter((m) => visible.has(m.id))
  for (const m of modules) {
    const placements: Record<Id, PortPlacement> = {}
    for (const pt of m.ports) {
      const fallback = defaultSide(pt.role, p.orientation)
      const list = pinned.has(pt.id) ? [] : (ends.get(pt.id) ?? [])
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

  const vertical = p.orientation === 'vertical'
  const topBand = (m: (typeof modules)[number], placements: Record<Id, PortPlacement>): boolean =>
    m.ports.some((pt) => placements[pt.id]!.side === 'top') || (vertical && parents.has(m.id))
  const points = new Map<Id, Point>()
  placeStandIns(standIns, points)
  for (const m of modules) placePorts(m.ports, out.get(m.id)!, rect(m.id), topBand(m, out.get(m.id)!), points)
  for (let sweep = 0; sweep < SWEEPS; sweep++)
    for (const m of modules) {
      const placements = out.get(m.id)!
      for (const pt of m.ports) {
        const { side } = placements[pt.id]!
        const list = pinned.has(pt.id) ? [] : (ends.get(pt.id) ?? []).filter((e) => e.side === side)
        if (!list.length) continue
        const axis = side === 'top' || side === 'bottom' ? 'x' : 'y'
        // Links between the same two ports keep their order at both ends.
        const at = list.map((e) => points.get(e.other.portId)![axis] + e.index * 1e-6)
        placements[pt.id] = { side, order: at.reduce((a, b) => a + b, 0) / at.length }
      }
      placePorts(m.ports, placements, rect(m.id), topBand(m, placements), points)
    }
  return out
}

/** Where the ports of the visible modules are drawn, placed by `sides` or on their default edges. */
export function portPoints(p: Project, visible: Set<Id>, sides: PortSides | null): Map<Id, Point> {
  const parents = new Set(p.modules.flatMap((m) => m.parentId ?? []))
  const points = new Map<Id, Point>()
  for (const m of [...p.modules, ...allImported(p)]) {
    if (!visible.has(m.id)) continue
    const placements =
      sides?.get(m.id) ??
      Object.fromEntries(m.ports.map((pt) => [pt.id, { side: defaultSide(pt.role, p.orientation), order: null }]))
    const topBand =
      m.ports.some((pt) => placements[pt.id]?.side === 'top') ||
      (p.orientation === 'vertical' && (!sides || parents.has(m.id)))
    placePorts(m.ports, placements, absoluteRect(p, m.id), topBand, points)
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

/** Height a module needs to draw its ports where they are placed. */
export function neededHeight(ports: { id: Id }[], placements: Record<Id, PortPlacement>): number {
  const count = (side: Side): number => portsOn(ports, placements, side).length
  const rows = Math.max(count('left'), count('right'))
  const bands = (count('top') ? 1 : 0) + (count('bottom') ? 1 : 0)
  return MODULE_HEADER + bands * PORT_BAND + (rows ? rows * PORT_ROW + 12 : 12)
}
