import { memo, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react'
import { setAssociationRoute } from '@/store/project'
import { useSelection } from '@/store/ui'
import type { AssociationEdgeData } from './associationEdges'
import { Z } from './constants'
import { useShapedEdge } from './shapedEdge'
import { useDrawn } from './viewContext'

const DIAMOND = 16
const ARROW = 10

/**
 * UML association from a module to a module one of its attributes references: a dotted line in
 * the link style, a diamond on the owner (filled when owned, hollow when shared) and an open arrow
 * on the referenced module, labelled in its middle with the attribute and its multiplicity. Shaped by hand like
 * the inheritance lines, with its module selected.
 */
export const AssociationEdge = memo(function AssociationEdge(
  props: EdgeProps<Edge<AssociationEdgeData>>
): ReactNode {
  const attributeId = props.data?.attributeId ?? ''
  const route = useDrawn(
    (p) => p.modules.find((m) => m.id === props.source)?.associationRoutes?.[attributeId]?.[props.target]
  )
  const selection = useSelection()
  const active = selection?.kind === 'module' && selection.id === props.source && !selection.member
  const shape = useShapedEdge({
    source: props.source,
    target: props.target,
    route,
    setRoute: (r) => setAssociationRoute(props.source, attributeId, props.target, r),
    active,
    spread: props.data?.spread,
    flip: props.data?.flip,
    head: 0
  })
  if (!shape || !props.data) return null
  const { from, to, out, into: u, path } = shape
  const { ownership, label } = props.data
  const diamond = ownership === 'owned' || ownership === 'shared'
  // The diamond: from the owner's border, half as wide as long, over the line.
  const tip = { x: from.x + out.x * DIAMOND, y: from.y + out.y * DIAMOND }
  const mid = { x: from.x + (out.x * DIAMOND) / 2, y: from.y + (out.y * DIAMOND) / 2 }
  const w = DIAMOND / 4
  const diamondPath = `M ${from.x} ${from.y} L ${mid.x - out.y * w} ${mid.y + out.x * w} L ${tip.x} ${tip.y} L ${mid.x + out.y * w} ${mid.y - out.x * w} Z`
  // Open arrow head on the referenced module.
  const bx = to.x - u.x * ARROW
  const by = to.y - u.y * ARROW
  const half = ARROW * 0.6
  const arrow = `M ${bx - u.y * half} ${by + u.x * half} L ${to.x} ${to.y} L ${bx + u.y * half} ${by - u.x * half}`
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        className={`association-edge ${ownership ?? ''} ${active ? 'active' : ''}`}
        interactionWidth={10}
      />
      {diamond && (
        <path d={diamondPath} className={`association-diamond ${ownership} ${active ? 'active' : ''}`} />
      )}
      <path d={arrow} className={`association-arrow ${active ? 'active' : ''}`} />
      <EdgeLabelRenderer>
        <div
          className="association-label nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${shape.label.x}px, ${shape.label.y}px)`,
            zIndex: Z.label
          }}
        >
          {label}
        </div>
      </EdgeLabelRenderer>
      {shape.overlay}
    </>
  )
})
