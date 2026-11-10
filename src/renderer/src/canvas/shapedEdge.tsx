// Lines between two modules drawn in the link style (inheritance, associations), shaped by hand
// like links: ends attached anywhere on the border of their module, and bend points.
import { useContext, useState, type ReactNode } from 'react'
import {
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  type InternalNode
} from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { findView, linkOrigin } from '@/model/project'
import type { BaseRoute, Id, LinkAnchor, Side } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { useSettings, type EdgeStyle } from '@/store/settings'
import { openContextMenu, type MenuItem } from '@/store/ui'
import { anchorItems } from './anchorMenu'
import { OPPOSITE, POSITION } from './constants'
import { ALIGN_PX, follow } from './LinkEdge'
import {
  anchorPoint,
  DIR,
  insertIndex,
  nearestAnchor,
  routeThrough,
  snapToNeighbours,
  type Point
} from './linkRoute'
import { useDrawn, ViewContext } from './viewContext'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export const boxOf = (n: InternalNode): Box => ({
  ...n.internals.positionAbsolute,
  width: n.measured.width ?? n.width ?? 0,
  height: n.measured.height ?? n.height ?? 0
})

/** Where the segment from the center of `b` towards `to` leaves `b`. */
export function borderPoint(b: Box, to: Point): Point {
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const dx = to.x - cx
  const dy = to.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const t = Math.min(dx ? b.width / 2 / Math.abs(dx) : Infinity, dy ? b.height / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * t, y: cy + dy * t }
}

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

export interface End {
  x: number
  y: number
  side: Side
}

/**
 * Where the line meets the modules, leaving and reaching them square to the sides it uses;
 * `spread` moves it sideways, apart from the other lines between the same modules (`flip`: the
 * line goes the other way, so that lines in both directions spread alike).
 */
function moduleEnds(
  s: Box,
  t: Box,
  inset: number,
  style: EdgeStyle,
  spread: number,
  flip: boolean
): { from: End; to: End } {
  const cx = (b: Box): number => b.x + b.width / 2
  const cy = (b: Box): number => b.y + b.height / 2
  if (contains(t, s)) {
    const x = cx(s) + spread
    return { from: { x, y: s.y, side: 'top' }, to: { x, y: t.y + inset, side: 'bottom' } }
  }
  if (contains(s, t)) {
    const x = cx(t) + spread
    return { from: { x, y: s.y + inset, side: 'bottom' }, to: { x, y: t.y, side: 'top' } }
  }
  const vGap = Math.max(t.y - (s.y + s.height), s.y - (t.y + t.height))
  const hGap = Math.max(t.x - (s.x + s.width), s.x - (t.x + t.width))
  const vertical = vGap > 0 && vGap >= hGap
  if (style === 'straight') {
    // From center to center, the side only orienting the arrow.
    const from = borderPoint(s, { x: cx(t), y: cy(t) })
    const to = borderPoint(t, { x: cx(s), y: cy(s) })
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const k = (flip ? -spread : spread) / len
    const n = { x: -(to.y - from.y) * k, y: (to.x - from.x) * k }
    const side: Side = vertical ? (t.y > s.y ? 'top' : 'bottom') : t.x > s.x ? 'left' : 'right'
    return {
      from: { x: from.x + n.x, y: from.y + n.y, side: OPPOSITE[side] },
      to: { x: to.x + n.x, y: to.y + n.y, side }
    }
  }
  // Facing sides, at the middle of the overlap of the modules, else at their centers.
  const middle = (lo: number, hi: number, a: number, b: number): [number, number] =>
    lo <= hi ? [(lo + hi) / 2, (lo + hi) / 2] : [a, b]
  if (vertical) {
    const below = t.y > s.y
    const [sx, tx] = middle(Math.max(s.x, t.x), Math.min(s.x + s.width, t.x + t.width), cx(s), cx(t))
    return {
      from: { x: sx + spread, y: below ? s.y + s.height : s.y, side: below ? 'bottom' : 'top' },
      to: { x: tx + spread, y: below ? t.y : t.y + t.height, side: below ? 'top' : 'bottom' }
    }
  }
  const right = cx(t) > cx(s)
  const [sy, ty] = middle(Math.max(s.y, t.y), Math.min(s.y + s.height, t.y + t.height), cy(s), cy(t))
  return {
    from: { x: right ? s.x + s.width : s.x, y: sy + spread, side: right ? 'right' : 'left' },
    to: { x: right ? t.x : t.x + t.width, y: ty + spread, side: right ? 'left' : 'right' }
  }
}

/** Keeps the ends of a bent line off the rounded corners. */
const CORNER = 8

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Where a bent line leaves `b` for the bend point `p`: square to the side facing it, or from the
 * top of its content (`inset`) when the point is inside it.
 */
function endToward(b: Box, p: Point, inset: number, style: EdgeStyle): End {
  const fx = clamp(p.x, b.x + CORNER, b.x + b.width - CORNER)
  const fy = clamp(p.y, b.y + CORNER, b.y + b.height - CORNER)
  const dx = Math.max(b.x - p.x, p.x - (b.x + b.width), 0)
  const dy = Math.max(b.y - p.y, p.y - (b.y + b.height), 0)
  if (!dx && !dy) return { x: fx, y: b.y + inset, side: 'bottom' }
  const vertical = dy >= dx
  const side: Side = vertical ? (p.y < b.y ? 'top' : 'bottom') : p.x < b.x ? 'left' : 'right'
  if (style === 'straight') return { ...borderPoint(b, p), side }
  if (vertical) return { x: fx, y: side === 'top' ? b.y : b.y + b.height, side }
  return { x: side === 'left' ? b.x : b.x + b.width, y: fy, side }
}

const unit = (a: Point, b: Point): Point | null => {
  const l = Math.hypot(b.x - a.x, b.y - a.y)
  return l ? { x: (b.x - a.x) / l, y: (b.y - a.y) / l } : null
}

export interface ShapedEdgeOptions {
  source: Id
  target: Id
  /** Saved shape, bend points relative to the module holding both ends (see LinkRoute). */
  route: BaseRoute | undefined
  setRoute: (route: BaseRoute | undefined) => void
  /** Editable: drawn with handles for its ends and bend points. */
  active: boolean
  /** One module holds the other: top of its content, where the line stops below its header. */
  inset?: number
  /** Unshaped: sideways offset, apart from the other lines between the same modules. */
  spread?: number
  /** The line goes against the order its `spread` is given in. */
  flip?: boolean
  /** Length of the head on the target the line stops at. */
  head: number
}

export interface ShapedEdge {
  from: End
  to: End
  /** Directions the line leaves the source and reaches the target along. */
  out: Point
  into: Point
  /** SVG path, from the source to the head. */
  path: string
  /** Middle of the line, for a label. */
  label: Point
  /** Line to drag to bend it, and handles of the ends and bend points (the line selected). */
  overlay: ReactNode
}

/** Shape of a line between two modules, editable as a link. */
export function useShapedEdge(o: ShapedEdgeOptions): ShapedEdge | null {
  const source = useInternalNode(o.source)
  const target = useInternalNode(o.target)
  const { edgeStyle, snapToGrid, gridSize } = useSettings(
    useShallow((s) => ({ edgeStyle: s.edgeStyle, snapToGrid: s.snapToGrid, gridSize: s.gridSize }))
  )
  const flow = useReactFlow()
  const origin = useDrawn((p) => linkOrigin(p, { from: { moduleId: o.source }, to: { moduleId: o.target } }))
  const viewId = useContext(ViewContext)
  const drillDown = useProjectStore((s) => !!findView(s.project, viewId).rootModuleId)
  /** Shape being dragged, with absolute bend points. */
  const [draft, setDraft] = useState<BaseRoute | null>(null)
  if (!source || !target) return null
  // Bend points are relative to the module holding both ends; absolute ones only fit the whole project.
  const originNode = origin ? flow.getInternalNode(origin) : undefined
  const editable = origin ? !!originNode : !drillDown
  const offset = originNode?.internals.positionAbsolute ?? { x: 0, y: 0 }
  const { route, head, active } = o
  // Attachments fit any view.
  const saved = route && {
    ...route,
    points: editable ? route.points.map((pt) => ({ x: pt.x + offset.x, y: pt.y + offset.y })) : []
  }
  const base: BaseRoute = draft ?? saved ?? { points: [] }
  const { points } = base
  const shapedByHand = !!(points.length || base.from || base.to)
  const s = boxOf(source)
  const t = boxOf(target)
  const inset = o.inset ?? 0
  /** An attached end; leaving inwards from a module holding the other. */
  const attached = (b: Box, other: Box, a: LinkAnchor | undefined): End | null =>
    a ? { ...anchorPoint(b, a), side: contains(b, other) ? OPPOSITE[a.side] : a.side } : null
  const fromSet = attached(s, t, base.from)
  const toSet = attached(t, s, base.to)
  const { from, to } = shapedByHand
    ? {
        from: fromSet ?? endToward(s, points[0] ?? toSet!, contains(s, t) ? inset : 0, edgeStyle),
        to:
          toSet ?? endToward(t, points[points.length - 1] ?? fromSet!, contains(t, s) ? inset : 0, edgeStyle)
      }
    : moduleEnds(s, t, inset, edgeStyle, o.spread ?? 0, !!o.flip)
  const last = points[points.length - 1] ?? from
  const length = Math.hypot(to.x - last.x, to.y - last.y)
  if (!shapedByHand && length < Math.max(head, 10)) return null
  const straight = edgeStyle === 'straight' || (!shapedByHand && (from.x === to.x || from.y === to.y))
  const into = (straight && unit(last, to)) || { x: -DIR[to.side].x, y: -DIR[to.side].y }
  const out = (straight && unit(from, points[0] ?? to)) || DIR[from.side]
  const stop = { x: to.x - into.x * head, y: to.y - into.y * head, side: to.side }
  const shaped = shapedByHand ? routeThrough(edgeStyle, from, stop, points) : null
  const ends = {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: POSITION[from.side],
    targetX: stop.x,
    targetY: stop.y,
    targetPosition: POSITION[to.side]
  }
  const [path, labelX, labelY] = shaped
    ? [shaped.path, shaped.label.x, shaped.label.y]
    : straight
      ? getStraightPath(ends)
      : edgeStyle === 'bezier'
        ? getBezierPath(ends)
        : getSmoothStepPath({ ...ends, borderRadius: edgeStyle === 'step' ? 0 : 8 })

  const commit = (r: BaseRoute): void => {
    setDraft(null)
    o.setRoute({
      ...r,
      points: editable
        ? r.points.map((pt) => ({ x: Math.round(pt.x - offset.x), y: Math.round(pt.y - offset.y) }))
        : (route?.points ?? [])
    })
  }
  const flowPoint = (ev: { clientX: number; clientY: number }): Point =>
    flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
  /** Drags bend point `i` of `list`: on the grid, then on the lines of its neighbours; Alt places freely. */
  const dragBend = (e: React.PointerEvent, list: Point[], i: number): void => {
    const controls = [from, ...list, to]
    let moved: BaseRoute | null = null
    follow(
      e,
      (ev) => {
        const p = flowPoint(ev)
        const q =
          ev.altKey || !snapToGrid
            ? p
            : { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize }
        const next = [...list]
        next[i] = ev.altKey
          ? q
          : snapToNeighbours(q, [controls[i]!, controls[i + 2]!], ALIGN_PX / flow.getZoom())
        setDraft((moved = { ...base, points: next }))
      },
      () => moved && commit(moved)
    )
  }
  const insertAt = (at: Point): number => (shaped ? insertIndex(shaped, at) : 0)
  /** A drag on the line adds a bend point there. */
  const grabLine = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const at = flowPoint(e)
    const i = insertAt(at)
    dragBend(e, [...points.slice(0, i), at, ...points.slice(i)], i)
  }
  const addBend = (e: React.MouseEvent): void => {
    const at = flowPoint(e)
    const i = insertAt(at)
    commit({ ...base, points: [...points.slice(0, i), at, ...points.slice(i)] })
  }
  const removeBend = (i: number): void => commit({ ...base, points: points.filter((_, k) => k !== i) })

  /** Drags an end along the border of its module, in line with its neighbour or the module's center. */
  const dragEnd = (e: React.PointerEvent, which: 'from' | 'to'): void => {
    if (e.button !== 0) return
    const r = which === 'from' ? s : t
    const neighbour = which === 'from' ? (points[0] ?? to) : (points[points.length - 1] ?? from)
    const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    let moved: BaseRoute | null = null
    follow(
      e,
      (ev) => {
        const p = ev.altKey
          ? flowPoint(ev)
          : snapToNeighbours(flowPoint(ev), [neighbour, center], ALIGN_PX / flow.getZoom())
        setDraft((moved = { ...base, [which]: nearestAnchor(r, p) }))
      },
      () => moved && commit(moved)
    )
  }
  const attach = (which: 'from' | 'to', anchor: LinkAnchor | undefined): void =>
    commit({ ...base, [which]: anchor })
  const menu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e, items)
  }
  const at = (p: Point) => ({ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` })

  const overlay = active && (
    <>
      {/* Selected: drag the line to bend it there. */}
      {editable && (
        <path
          className="route-grab nodrag nopan"
          d={path}
          onPointerDown={grabLine}
          onClick={(e) => e.detail === 2 && addBend(e)}
        />
      )}
      <EdgeLabelRenderer>
        {(['from', 'to'] as const).map((which) => (
          <div
            key={which}
            className={`route-handle end nodrag nopan ${base[which] ? 'set' : ''}`}
            style={at(which === 'from' ? from : to)}
            title={
              base[which]
                ? 'Drag along the module to move the attachment; double-click to attach automatically'
                : 'Drag along the module to attach the line there'
            }
            onPointerDown={(e) => dragEnd(e, which)}
            onClick={(e) => e.detail === 2 && base[which] && attach(which, undefined)}
            onContextMenu={(e) =>
              menu(
                e,
                anchorItems(base[which], 'Automatic', (a) => attach(which, a))
              )
            }
          />
        ))}
        {editable &&
          points.map((pt, i) => (
            <div
              key={i}
              className="route-handle bend nodrag nopan"
              style={at(pt)}
              title="Drag to move the bend; double-click to remove it (Alt: no snapping)"
              onPointerDown={(e) => e.button === 0 && dragBend(e, points, i)}
              onClick={(e) => e.detail === 2 && removeBend(i)}
              onContextMenu={(e) => menu(e, [{ label: 'Remove bend', run: () => removeBend(i) }])}
            />
          ))}
      </EdgeLabelRenderer>
    </>
  )
  return { from, to, out, into, path, label: { x: labelX, y: labelY }, overlay }
}
