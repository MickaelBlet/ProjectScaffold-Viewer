import { memo, type ReactNode } from 'react'
import { BaseEdge, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react'
import type { InheritEdgeData } from './inheritEdges'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const boxOf = (n: InternalNode): Box => ({
  ...n.internals.positionAbsolute,
  width: n.measured.width ?? n.width ?? 0,
  height: n.measured.height ?? n.height ?? 0
})

/** Where the segment from the center of `b` towards `to` leaves `b`. */
function borderPoint(b: Box, to: { x: number; y: number }): { x: number; y: number } {
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

/**
 * UML generalization from a module to its base: a straight line between their borders ending
 * in a hollow triangle on the base. Between a container and its content, a vertical line from
 * the top of the inner module to the top of the outer one's content, below its header.
 */
export const InheritEdge = memo(function InheritEdge(props: EdgeProps<Edge<InheritEdgeData>>): ReactNode {
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  if (!source || !target) return null
  const s = boxOf(source)
  const t = boxOf(target)
  let from: { x: number; y: number }
  let to: { x: number; y: number }
  const inset = props.data?.inset ?? 0
  if (contains(t, s)) {
    from = { x: s.x + s.width / 2, y: s.y }
    to = { x: from.x, y: t.y + inset }
  } else if (contains(s, t)) {
    to = { x: t.x + t.width / 2, y: t.y }
    from = { x: to.x, y: s.y + inset }
  } else {
    from = borderPoint(s, { x: t.x + t.width / 2, y: t.y + t.height / 2 })
    to = borderPoint(t, { x: s.x + s.width / 2, y: s.y + s.height / 2 })
  }
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length < ARROW) return null
  // Unit vector along the line, and the triangle's base where the line stops.
  const ux = (to.x - from.x) / length
  const uy = (to.y - from.y) / length
  const bx = to.x - ux * ARROW
  const by = to.y - uy * ARROW
  const half = ARROW * 0.6
  const triangle = `M ${to.x} ${to.y} L ${bx - uy * half} ${by + ux * half} L ${bx + uy * half} ${by - ux * half} Z`
  const className = `inherit-edge ${props.data?.realization ? 'realization' : ''}`
  return (
    <>
      <BaseEdge
        id={props.id}
        path={`M ${from.x} ${from.y} L ${bx} ${by}`}
        className={className}
        interactionWidth={12}
      />
      <path d={triangle} className="inherit-arrow" />
    </>
  )
})
