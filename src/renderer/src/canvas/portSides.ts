// Floating ports: on a module without submodules, each port sits on the edge facing the modules
// it is linked to, with its name, so that links leave from where the port is drawn.
import { absoluteRect, MODULE_HEADER, PORT_BAND, PORT_ROW, subtreeIds } from '@/model/project'
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

/**
 * Placement of the ports of the visible modules without submodules. A port linked several times
 * goes where most of its links go; unlinked ports, and links to hidden or enclosing modules, keep
 * the orientation's default edge.
 */
export function floatingPortSides(p: Project, visible: Set<Id>): PortSides {
  const parents = new Set(p.modules.flatMap((m) => m.parentId ?? []))
  const rects = new Map<Id, Rect>()
  const rect = (id: Id): Rect => {
    let r = rects.get(id)
    if (!r) rects.set(id, (r = absoluteRect(p, id)))
    return r
  }
  const nested = (a: Id, b: Id): boolean => subtreeIds(p, a).has(b) || subtreeIds(p, b).has(a)
  const votes = new Map<Id, { side: Side; key: number }[]>()
  for (const [index, l] of p.links.entries())
    for (const [end, other] of [
      [l.from, l.to],
      [l.to, l.from]
    ] as const) {
      if (parents.has(end.moduleId) || !visible.has(end.moduleId)) continue
      if (!visible.has(other.moduleId) || nested(end.moduleId, other.moduleId)) continue
      const b = rect(other.moduleId)
      const side = facingSide(rect(end.moduleId), b, p.orientation)
      const list = votes.get(end.portId) ?? []
      // Along a band: towards the linked module; links between the same two modules keep the
      // same order at both ends, so that they do not cross.
      const along = side === 'top' || side === 'bottom' ? centerX(b) : centerY(b)
      list.push({ side, key: along + index * 1e-6 })
      votes.set(end.portId, list)
    }

  const out: PortSides = new Map()
  for (const m of p.modules) {
    if (parents.has(m.id) || !visible.has(m.id)) continue
    const placements: Record<Id, PortPlacement> = {}
    for (const pt of m.ports) {
      const fallback = defaultSide(pt.role, p.orientation)
      const list = votes.get(pt.id) ?? []
      const count = new Map<Side, number>()
      for (const v of list) count.set(v.side, (count.get(v.side) ?? 0) + 1)
      const best = Math.max(0, ...count.values())
      // Ties keep the default edge when it is one of them.
      const side = !list.length
        ? fallback
        : count.get(fallback) === best
          ? fallback
          : [...count].find(([, n]) => n === best)![0]
      const keys = list.filter((v) => v.side === side).map((v) => v.key)
      const band = side === 'top' || side === 'bottom'
      placements[pt.id] = {
        side,
        order: band && keys.length ? keys.reduce((a, b) => a + b, 0) / keys.length : null
      }
    }
    out.set(m.id, placements)
  }
  return out
}

/** Ports of a module on one edge, in drawing order. */
export function portsOn<T extends { id: Id }>(
  ports: T[],
  placements: Record<Id, PortPlacement>,
  side: Side
): T[] {
  const on = ports.filter((pt) => placements[pt.id]?.side === side)
  // Band ports follow the modules they link to; unlinked ones stay in their order, last.
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
