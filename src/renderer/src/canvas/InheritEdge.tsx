import { memo, useId, type ReactNode } from 'react'
import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react'
import { setBaseRoute } from '@/store/project'
import { useSelection } from '@/store/ui'
import type { InheritEdgeData } from './inheritEdges'
import { pathPoints } from './linkRoute'
import { useShapedEdge } from './shapedEdge'
import { useDrawn } from './viewContext'

const ARROW = 14

/**
 * UML generalization from a module to its base: a double line in the link style ending in a
 * hollow triangle on the base. Between a container and its content, a vertical line from the top
 * of the inner module to the top of the outer one's content, below its header.
 */
export const InheritEdge = memo(function InheritEdge(props: EdgeProps<Edge<InheritEdgeData>>): ReactNode {
  const route = useDrawn((p) => p.modules.find((m) => m.id === props.source)?.baseRoutes?.[props.target])
  // Editable with its module selected.
  const selection = useSelection()
  const active = selection?.kind === 'module' && selection.id === props.source && !selection.member
  // Unique across canvases showing the same edge.
  const mask = `inherit-gap${useId().replace(/[^\w-]/g, '')}`
  const shape = useShapedEdge({
    source: props.source,
    target: props.target,
    route,
    setRoute: (r) => setBaseRoute(props.source, props.target, r),
    active,
    inset: props.data?.inset,
    head: ARROW
  })
  if (!shape) return null
  const { to, into: u, path } = shape
  const bx = to.x - u.x * ARROW
  const by = to.y - u.y * ARROW
  const half = ARROW * 0.6
  const triangle = `M ${to.x} ${to.y} L ${bx - u.y * half} ${by + u.x * half} L ${bx + u.y * half} ${by - u.x * half} Z`
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
      {shape.overlay}
    </>
  )
})
