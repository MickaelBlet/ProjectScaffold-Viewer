import { memo, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Position,
  useInternalNode,
  useStoreApi,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'
import { useProjectStore } from '@/store/project'
import { useSettings } from '@/store/settings'
import { select } from '@/store/ui'
import type { PerformanceClass } from '@/model/types'
import { orientLinkEnds, type Side } from './linkEnds'

export const PERF_COLORS: Record<PerformanceClass, string> = {
  realtime: 'var(--perf-realtime)',
  low: 'var(--perf-low)',
  normal: 'var(--perf-normal)',
  bulk: 'var(--perf-bulk)'
}

type Lookup = (id: string) => InternalNode | undefined

function isAncestor(lookup: Lookup, ancestor: string, id: string): boolean {
  let cur = lookup(id)?.parentId
  while (cur) {
    if (cur === ancestor) return true
    cur = lookup(cur)?.parentId
  }
  return false
}

const POSITION: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom
}

const rectOf = (n: InternalNode) => ({
  ...n.internals.positionAbsolute,
  width: n.measured.width ?? 0,
  height: n.measured.height ?? 0
})

/** End points of a link: at the ports, or auto-oriented towards the other end. */
function endPoints(
  props: EdgeProps,
  source: InternalNode | undefined,
  target: InternalNode | undefined,
  lookup: Lookup,
  auto: boolean
) {
  const base = {
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    moved: [false, false]
  }
  if (!auto || !source || !target) return base
  // A container's port links to its content from the inside: keep the sides.
  if (isAncestor(lookup, source.id, target.id) || isAncestor(lookup, target.id, source.id)) return base
  const ends = orientLinkEnds(
    { rect: rectOf(source), handle: { x: props.sourceX, y: props.sourceY } },
    { rect: rectOf(target), handle: { x: props.targetX, y: props.targetY } }
  )
  return {
    sourceX: ends.source.x,
    sourceY: ends.source.y,
    sourcePosition: POSITION[ends.source.side],
    targetX: ends.target.x,
    targetY: ends.target.y,
    targetPosition: POSITION[ends.target.side],
    moved: [ends.source.side !== 'right', ends.target.side !== 'left']
  }
}

export const LinkEdge = memo(function LinkEdge(props: EdgeProps): ReactNode {
  const link = useProjectStore((s) => s.project.links.find((l) => l.id === props.id))
  const { edgeStyle, edgeBadges, autoOrientLinks } = useSettings()
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  const store = useStoreApi()
  const lookup: Lookup = (id) => store.getState().nodeLookup.get(id)
  const ends = endPoints(props, source, target, lookup, autoOrientLinks)
  const [path, labelX, labelY] =
    edgeStyle === 'straight'
      ? getStraightPath(ends)
      : edgeStyle === 'bezier'
        ? getBezierPath(ends)
        : getSmoothStepPath({ ...ends, borderRadius: edgeStyle === 'step' ? 0 : 8 })
  if (!link) return null
  const c = link.constraints
  const color = PERF_COLORS[c.performance.class]
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        interactionWidth={16}
        style={{
          stroke: color,
          strokeWidth: props.selected ? 3 : 2,
          strokeDasharray: c.remote.enabled ? '6 4' : undefined
        }}
      />
      {/* Attachment dots where an end left its port's side. */}
      {ends.moved[0] && (
        <circle className="attach" cx={ends.sourceX} cy={ends.sourceY} r={3.5} fill={color} />
      )}
      {ends.moved[1] && (
        <circle className="attach" cx={ends.targetX} cy={ends.targetY} r={3.5} fill={color} />
      )}
      <EdgeLabelRenderer>
        <div
          className={`edge-label nodrag nopan ${props.selected ? 'selected' : ''} ${edgeBadges ? '' : 'compact'}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => select({ kind: 'link', id: link.id })}
          title={link.name}
        >
          {edgeBadges ? (
            <>
              <span className="badge dir">{c.direction === 'bidirectional' ? '⇄' : '→'}</span>
              {c.ack.required && (
                <span className="badge ack">ACK{c.ack.timeoutMs ? ` ${c.ack.timeoutMs}ms` : ''}</span>
              )}
              {c.performance.class !== 'normal' && (
                <span className="badge perf" style={{ borderColor: color, background: color }}>
                  {c.performance.class}
                </span>
              )}
              {c.remote.enabled && <span className="badge remote">⇢ {c.remote.transport || 'remote'}</span>}
            </>
          ) : (
            <span className="edge-dot" style={{ background: color }} />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
