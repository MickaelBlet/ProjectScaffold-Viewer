import { memo, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react'
import type { AssociationEdgeData } from './associationEdges'
import { borderPoint, boxOf } from './InheritEdge'

const DIAMOND = 16
const ARROW = 10

/**
 * UML association from a module to a module one of its attributes references: a straight dotted
 * line between their borders, a diamond on the owner (filled when owned, hollow when shared) and
 * an open arrow on the referenced module, labelled with the attribute and its multiplicity.
 */
export const AssociationEdge = memo(function AssociationEdge(
  props: EdgeProps<Edge<AssociationEdgeData>>
): ReactNode {
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  if (!source || !target || !props.data) return null
  const s = boxOf(source)
  const t = boxOf(target)
  const from = borderPoint(s, { x: t.x + t.width / 2, y: t.y + t.height / 2 })
  const to = borderPoint(t, { x: s.x + s.width / 2, y: s.y + s.height / 2 })
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length < DIAMOND + ARROW) return null
  const ux = (to.x - from.x) / length
  const uy = (to.y - from.y) / length
  const { ownership, label } = props.data
  const diamond = ownership === 'owned' || ownership === 'shared'
  // The diamond: from the owner's border, half as wide as long.
  const tip = { x: from.x + ux * DIAMOND, y: from.y + uy * DIAMOND }
  const mid = { x: from.x + (ux * DIAMOND) / 2, y: from.y + (uy * DIAMOND) / 2 }
  const w = DIAMOND / 4
  const diamondPath = `M ${from.x} ${from.y} L ${mid.x - uy * w} ${mid.y + ux * w} L ${tip.x} ${tip.y} L ${mid.x + uy * w} ${mid.y - ux * w} Z`
  const start = diamond ? tip : from
  // Open arrow head on the referenced module.
  const bx = to.x - ux * ARROW
  const by = to.y - uy * ARROW
  const half = ARROW * 0.6
  const arrow = `M ${bx - uy * half} ${by + ux * half} L ${to.x} ${to.y} L ${bx + uy * half} ${by - ux * half}`
  const at = { x: to.x - ux * (ARROW + 18), y: to.y - uy * (ARROW + 18) }
  return (
    <>
      <BaseEdge
        id={props.id}
        path={`M ${start.x} ${start.y} L ${to.x} ${to.y}`}
        className={`association-edge ${ownership ?? ''}`}
        interactionWidth={10}
      />
      {diamond && <path d={diamondPath} className={`association-diamond ${ownership}`} />}
      <path d={arrow} className="association-arrow" />
      <EdgeLabelRenderer>
        <div
          className="association-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
