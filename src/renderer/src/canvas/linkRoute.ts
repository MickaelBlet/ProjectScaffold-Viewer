// Links shaped by hand: ends attached anywhere on their module's border, and bend points the
// link goes through, drawn in the link style.
import type { LinkAnchor, Rect, Side } from '@/model/types'
import type { EdgeStyle } from '@/store/settings'

export interface Point {
  x: number
  y: number
}

export interface RouteEnd extends Point {
  side: Side
}

const DIR: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 }
}
/** Straight part of a step link before its first turn. */
const STUB = 20
/** Keeps attachments off the rounded corners. */
const CORNER = 8

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)
const along = (p: Point, side: Side, d: number): Point => ({
  x: p.x + DIR[side].x * d,
  y: p.y + DIR[side].y * d
})

/** Point of the border of `r` an anchor stands for. */
export function anchorPoint(r: Rect, a: LinkAnchor): Point {
  const at = clamp(a.at, 0, 1)
  switch (a.side) {
    case 'left':
      return { x: r.x, y: r.y + at * r.height }
    case 'right':
      return { x: r.x + r.width, y: r.y + at * r.height }
    case 'top':
      return { x: r.x + at * r.width, y: r.y }
    case 'bottom':
      return { x: r.x + at * r.width, y: r.y + r.height }
  }
}

/** Anchor on the border of `r` nearest to `p`. */
export function nearestAnchor(r: Rect, p: Point): LinkAnchor {
  const fx = (x: number): number => (r.width ? clamp(x, r.x + CORNER, r.x + r.width - CORNER) : r.x)
  const fy = (y: number): number => (r.height ? clamp(y, r.y + CORNER, r.y + r.height - CORNER) : r.y)
  const candidates: [Side, Point][] = [
    ['left', { x: r.x, y: fy(p.y) }],
    ['right', { x: r.x + r.width, y: fy(p.y) }],
    ['top', { x: fx(p.x), y: r.y }],
    ['bottom', { x: fx(p.x), y: r.y + r.height }]
  ]
  const [side, q] = candidates.reduce((a, b) => (dist(b[1], p) < dist(a[1], p) ? b : a))
  const at =
    side === 'left' || side === 'right' ? (q.y - r.y) / (r.height || 1) : (q.x - r.x) / (r.width || 1)
  return { side, at: Math.round(at * 1000) / 1000 }
}

/** Removes repeated points and points in the middle of a straight run. */
function simplify(pts: Point[]): Point[] {
  const out: Point[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    const prev = out[out.length - 2]
    if (last && prev && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) {
      // Same line, and not turning back.
      if ((last.x - prev.x) * (p.x - last.x) + (last.y - prev.y) * (p.y - last.y) >= 0) out.pop()
    }
    out.push(p)
  }
  return out
}

/**
 * Orthogonal line through the bend points: out of the source's side, then each leg turns before
 * going to the next point, so that each bend point is a corner.
 */
function orthogonal(s: RouteEnd, t: RouteEnd, points: Point[]): { line: Point[]; marks: number[] } {
  const line: Point[] = [s, along(s, s.side, STUB)]
  const marks = [0]
  let horizontal = s.side === 'left' || s.side === 'right'
  for (const q of [...points, along(t, t.side, STUB)]) {
    const c = line[line.length - 1]!
    if (c.x === q.x) horizontal = false
    else if (c.y === q.y) horizontal = true
    else line.push(horizontal ? { x: c.x, y: q.y } : { x: q.x, y: c.y })
    line.push(q)
    marks.push(line.length - 1)
  }
  line.push({ x: t.x, y: t.y })
  marks[marks.length - 1] = line.length - 1
  return { line, marks }
}

/** Smooth curve through the points, leaving and reaching the modules square to their sides. */
function curve(s: RouteEnd, t: RouteEnd, points: Point[]): { d: string; line: Point[]; marks: number[] } {
  const pts: Point[] = [s, ...points, t]
  const n = pts.length - 1
  const tangent = (i: number): Point => {
    if (i === 0)
      return { x: DIR[s.side].x * dist(pts[0]!, pts[1]!), y: DIR[s.side].y * dist(pts[0]!, pts[1]!) }
    if (i === n) {
      const d = dist(pts[n - 1]!, pts[n]!)
      return { x: -DIR[t.side].x * d, y: -DIR[t.side].y * d }
    }
    return { x: (pts[i + 1]!.x - pts[i - 1]!.x) / 2, y: (pts[i + 1]!.y - pts[i - 1]!.y) / 2 }
  }
  let d = `M${s.x},${s.y}`
  const line: Point[] = [s]
  const marks = [0]
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const ta = tangent(i)
    const tb = tangent(i + 1)
    const c1 = { x: a.x + ta.x / 3, y: a.y + ta.y / 3 }
    const c2 = { x: b.x - tb.x / 3, y: b.y - tb.y / 3 }
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`
    // Sampled, to place the label and find the leg under the pointer.
    for (let k = 1; k <= 16; k++) {
      const u = k / 16
      const v = 1 - u
      line.push({
        x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x,
        y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y
      })
    }
    marks.push(line.length - 1)
  }
  return { d, line, marks }
}

/** Polyline with corners rounded to `radius`. */
function rounded(pts: Point[], radius: number): string {
  let d = `M${pts[0]!.x},${pts[0]!.y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, c, b] = [pts[i - 1]!, pts[i]!, pts[i + 1]!]
    const r = Math.min(radius, dist(a, c) / 2, dist(c, b) / 2)
    if (!r) {
      d += ` L${c.x},${c.y}`
      continue
    }
    const p1 = { x: c.x + ((a.x - c.x) / dist(a, c)) * r, y: c.y + ((a.y - c.y) / dist(a, c)) * r }
    const p2 = { x: c.x + ((b.x - c.x) / dist(c, b)) * r, y: c.y + ((b.y - c.y) / dist(c, b)) * r }
    d += ` L${p1.x},${p1.y} Q${c.x},${c.y} ${p2.x},${p2.y}`
  }
  const last = pts[pts.length - 1]!
  return `${d} L${last.x},${last.y}`
}

const length = (pts: Point[]): number => pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i]!, p), 0)

/** Point halfway along a polyline. */
export function midpoint(pts: Point[]): Point {
  let rest = length(pts) / 2
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const l = dist(a, b)
    if (l >= rest && l > 0) return { x: a.x + ((b.x - a.x) * rest) / l, y: a.y + ((b.y - a.y) * rest) / l }
    rest -= l
  }
  return { ...pts[0]! }
}

/** Middle of the longest leg between two bend points, clear of the bends. */
function labelAt(line: Point[], marks: number[]): Point {
  const legs = marks.slice(1).map((m, k) => line.slice(marks[k], m + 1))
  return midpoint(legs.reduce((a, b) => (length(b) > length(a) ? b : a)))
}

export interface Route {
  /** SVG path. */
  path: string
  label: Point
  /** Drawn line as a polyline (curves sampled). */
  line: Point[]
  /** Index in `line` of the source, of each bend point, and of the target. */
  marks: number[]
}

/** A link from `s` to `t` through the bend points, in the link style. */
export function routeThrough(style: EdgeStyle, s: RouteEnd, t: RouteEnd, points: Point[]): Route {
  if (style === 'bezier') {
    const { d, line, marks } = curve(s, t, points)
    return { path: d, label: labelAt(line, marks), line, marks }
  }
  if (style === 'straight') {
    const line = [s, ...points, t]
    const marks = line.map((_, i) => i)
    return { path: rounded(line, 0), label: labelAt(line, marks), line, marks }
  }
  const { line, marks } = orthogonal(s, t, points)
  // Corners are rounded on the simplified line; marks stay on the full one.
  return { path: rounded(simplify(line), style === 'step' ? 0 : 8), label: labelAt(line, marks), line, marks }
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
  const u = l2 ? clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2, 0, 1) : 0
  return dist(p, { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) })
}

/** Where a bend point at `p` goes in the list: after the bend points before the leg under `p`. */
export function insertIndex(route: Pick<Route, 'line' | 'marks'>, p: Point): number {
  let best = { i: 0, d: Infinity }
  for (let i = 1; i < route.line.length; i++) {
    const d = distToSegment(p, route.line[i - 1]!, route.line[i]!)
    if (d < best.d) best = { i, d }
  }
  // The leg ending at the first mark at or after the nearest segment's end.
  const leg = route.marks.findIndex((m) => m >= best.i)
  return Math.max(0, leg - 1)
}

/** Moves `p` onto the lines of its neighbours when it is within `tolerance` of them. */
export function snapToNeighbours(p: Point, neighbours: Point[], tolerance: number): Point {
  const out = { ...p }
  for (const axis of ['x', 'y'] as const) {
    const near = neighbours
      .map((n) => n[axis])
      .filter((v) => Math.abs(v - p[axis]) <= tolerance)
      .sort((a, b) => Math.abs(a - p[axis]) - Math.abs(b - p[axis]))
    if (near.length) out[axis] = near[0]!
  }
  return out
}
