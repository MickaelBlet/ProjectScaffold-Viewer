import { memo, useId, type ReactNode } from 'react'
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'
import type { Side } from '@/model/types'
import { useSettings, type EdgeStyle } from '@/store/settings'
import { OPPOSITE, POSITION } from './constants'
import type { InheritEdgeData } from './inheritEdges'
import { DIR, pathPoints } from './linkRoute'

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

/**
 * UML generalization from a module to its base: a double line in the link style ending in a
 * hollow triangle on the base. Between a container and its content, a vertical line from the top
 * of the inner module to the top of the outer one's content, below its header.
 */
export const InheritEdge = memo(function InheritEdge(props: EdgeProps<Edge<InheritEdgeData>>): ReactNode {
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  const edgeStyle = useSettings((s) => s.edgeStyle)
  // Unique across canvases showing the same edge.
  const mask = `inherit-gap${useId().replace(/[^\w-]/g, '')}`
  if (!source || !target) return null
  const s = boxOf(source)
  const t = boxOf(target)
  const { from, to } = inheritEnds(s, t, props.data?.inset ?? 0, edgeStyle)
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length < ARROW) return null
  // Unit vector the line reaches the base along, and the triangle's base where the line stops.
  const straight = edgeStyle === 'straight' || from.x === to.x || from.y === to.y
  const u = straight
    ? { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
    : { x: -DIR[to.side].x, y: -DIR[to.side].y }
  const bx = to.x - u.x * ARROW
  const by = to.y - u.y * ARROW
  const half = ARROW * 0.6
  const triangle = `M ${to.x} ${to.y} L ${bx - u.y * half} ${by + u.x * half} L ${bx + u.y * half} ${by - u.x * half} Z`
  const ends = {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: POSITION[from.side],
    targetX: bx,
    targetY: by,
    targetPosition: POSITION[to.side]
  }
  const [path] = straight
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
  const className = `inherit-edge ${props.data?.realization ? 'realization' : ''}`
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
      <path d={triangle} className="inherit-arrow" />
    </>
  )
})
