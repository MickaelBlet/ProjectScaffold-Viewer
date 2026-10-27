import { memo, useContext, useId, useState, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { findView, linkOrigin } from '@/model/project'
import type { BaseRoute, LinkAnchor, Side } from '@/model/types'
import { setBaseRoute, useProjectStore } from '@/store/project'
import { useSettings, type EdgeStyle } from '@/store/settings'
import { openContextMenu, useSelection, type MenuItem } from '@/store/ui'
import { anchorItems } from './anchorMenu'
import { OPPOSITE, POSITION } from './constants'
import type { InheritEdgeData } from './inheritEdges'
import { ALIGN_PX, follow } from './LinkEdge'
import {
  anchorPoint,
  DIR,
  insertIndex,
  nearestAnchor,
  pathPoints,
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
export function borderPoint(b: Box, to: { x: number; y: number }): { x: number; y: number } {
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

const ARROW = 14

interface End {
  x: number
  y: number
  side: Side
}

/** Where the line meets the modules, leaving and reaching them square to the sides it uses. */
function inheritEnds(s: Box, t: Box, inset: number, style: EdgeStyle): { from: End; to: End } {
  const cx = (b: Box): number => b.x + b.width / 2
  const cy = (b: Box): number => b.y + b.height / 2
  if (contains(t, s)) {
    const x = cx(s)
    return { from: { x, y: s.y, side: 'top' }, to: { x, y: t.y + inset, side: 'bottom' } }
  }
  if (contains(s, t)) {
    const x = cx(t)
    return { from: { x, y: s.y + inset, side: 'bottom' }, to: { x, y: t.y, side: 'top' } }
  }
  const vGap = Math.max(t.y - (s.y + s.height), s.y - (t.y + t.height))
  const hGap = Math.max(t.x - (s.x + s.width), s.x - (t.x + t.width))
  const vertical = vGap > 0 && vGap >= hGap
  if (style === 'straight') {
    // From center to center, the side only orienting the arrow.
    const from = borderPoint(s, { x: cx(t), y: cy(t) })
    const to = borderPoint(t, { x: cx(s), y: cy(s) })
    const side: Side = vertical ? (t.y > s.y ? 'top' : 'bottom') : t.x > s.x ? 'left' : 'right'
    return { from: { ...from, side: OPPOSITE[side] }, to: { ...to, side } }
  }
  // Facing sides, at the middle of the overlap of the modules, else at their centers.
  const middle = (lo: number, hi: number, a: number, b: number): [number, number] =>
    lo <= hi ? [(lo + hi) / 2, (lo + hi) / 2] : [a, b]
  if (vertical) {
    const below = t.y > s.y
    const [sx, tx] = middle(Math.max(s.x, t.x), Math.min(s.x + s.width, t.x + t.width), cx(s), cx(t))
    return {
      from: { x: sx, y: below ? s.y + s.height : s.y, side: below ? 'bottom' : 'top' },
      to: { x: tx, y: below ? t.y : t.y + t.height, side: below ? 'top' : 'bottom' }
    }
  }
  const right = cx(t) > cx(s)
  const [sy, ty] = middle(Math.max(s.y, t.y), Math.min(s.y + s.height, t.y + t.height), cy(s), cy(t))
  return {
    from: { x: right ? s.x + s.width : s.x, y: sy, side: right ? 'right' : 'left' },
    to: { x: right ? t.x : t.x + t.width, y: ty, side: right ? 'left' : 'right' }
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

/**
 * UML generalization from a module to its base: a double line in the link style ending in a
 * hollow triangle on the base. Between a container and its content, a vertical line from the top
 * of the inner module to the top of the outer one's content, below its header.
 */
export const InheritEdge = memo(function InheritEdge(props: EdgeProps<Edge<InheritEdgeData>>): ReactNode {
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  const { edgeStyle, snapToGrid, gridSize } = useSettings(
    useShallow((s) => ({ edgeStyle: s.edgeStyle, snapToGrid: s.snapToGrid, gridSize: s.gridSize }))
  )
  const flow = useReactFlow()
  const origin = useDrawn((p) =>
    linkOrigin(p, { from: { moduleId: props.source }, to: { moduleId: props.target } })
  )
  const route = useDrawn((p) => p.modules.find((m) => m.id === props.source)?.baseRoutes?.[props.target])
  const viewId = useContext(ViewContext)
  const drillDown = useProjectStore((s) => !!findView(s.project, viewId).rootModuleId)
  // Editable with its module selected.
  const selection = useSelection()
  const active = selection?.kind === 'module' && selection.id === props.source && !selection.member
  /** Shape being dragged, with absolute bend points. */
  const [draft, setDraft] = useState<BaseRoute | null>(null)
  // Unique across canvases showing the same edge.
  const mask = `inherit-gap${useId().replace(/[^\w-]/g, '')}`
  if (!source || !target) return null
  // Bend points are relative to the module holding both ends; absolute ones only fit the whole project.
  const originNode = origin ? flow.getInternalNode(origin) : undefined
  const editable = origin ? !!originNode : !drillDown
  const offset = originNode?.internals.positionAbsolute ?? { x: 0, y: 0 }
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
  const inset = props.data?.inset ?? 0
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
    : inheritEnds(s, t, inset, edgeStyle)
  const last = points[points.length - 1] ?? from
  const length = Math.hypot(to.x - last.x, to.y - last.y)
  if (!shapedByHand && length < ARROW) return null
  // Unit vector the line reaches the base along, and the triangle's base where the line stops.
  const straight = edgeStyle === 'straight' || (!shapedByHand && (from.x === to.x || from.y === to.y))
  const u =
    straight && length
      ? { x: (to.x - last.x) / length, y: (to.y - last.y) / length }
      : { x: -DIR[to.side].x, y: -DIR[to.side].y }
  const bx = to.x - u.x * ARROW
  const by = to.y - u.y * ARROW
  const half = ARROW * 0.6
  const triangle = `M ${to.x} ${to.y} L ${bx - u.y * half} ${by + u.x * half} L ${bx + u.y * half} ${by - u.x * half} Z`
  const shaped = shapedByHand ? routeThrough(edgeStyle, from, { x: bx, y: by, side: to.side }, points) : null
  const ends = {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: POSITION[from.side],
    targetX: bx,
    targetY: by,
    targetPosition: POSITION[to.side]
  }
  const [path] = shaped
    ? [shaped.path]
    : straight
      ? getStraightPath(ends)
      : edgeStyle === 'bezier'
        ? getBezierPath(ends)
        : getSmoothStepPath({ ...ends, borderRadius: edgeStyle === 'step' ? 0 : 8 })
  // The gap between the two lines: the middle of the wide stroke, masked out.
  const pts = pathPoints(path)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const box = {
    x: Math.min(...xs) - 10,
    y: Math.min(...ys) - 10,
    width: Math.max(...xs) - Math.min(...xs) + 20,
    height: Math.max(...ys) - Math.min(...ys) + 20
  }
  const className = `inherit-edge ${props.data?.realization ? 'realization' : ''} ${active ? 'active' : ''}`

  const commit = (r: BaseRoute): void => {
    setDraft(null)
    setBaseRoute(props.source, props.target, {
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

  return (
    <>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" {...box}>
          <rect {...box} fill="white" />
          <path d={path} className="inherit-gap" />
        </mask>
      </defs>
      <BaseEdge
        id={props.id}
        path={path}
        className={className}
        style={{ mask: `url(#${mask})` }}
        interactionWidth={12}
      />
      <path d={triangle} className={`inherit-arrow ${active ? 'active' : ''}`} />
      {/* Its module selected: drag the line to bend it there. */}
      {active && editable && (
        <path
          className="route-grab nodrag nopan"
          d={path}
          onPointerDown={grabLine}
          onClick={(e) => e.detail === 2 && addBend(e)}
        />
      )}
      {active && (
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
      )}
    </>
  )
})
