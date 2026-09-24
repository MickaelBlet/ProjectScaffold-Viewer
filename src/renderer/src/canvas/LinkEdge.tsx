import { memo, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import type { PerformanceClass } from '@/model/types'

export const PERF_COLORS: Record<PerformanceClass, string> = {
  realtime: 'var(--perf-realtime)',
  low: 'var(--perf-low)',
  normal: 'var(--perf-normal)',
  bulk: 'var(--perf-bulk)'
}

export const LinkEdge = memo(function LinkEdge(props: EdgeProps): ReactNode {
  const link = useProjectStore((s) => s.project.links.find((l) => l.id === props.id))
  const [path, labelX, labelY] = getBezierPath(props)
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
      <EdgeLabelRenderer>
        <div
          className={`edge-label nodrag nopan ${props.selected ? 'selected' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => select({ kind: 'link', id: link.id })}
          title={link.name}
        >
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
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
