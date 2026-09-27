import { memo, useEffect, type ReactNode } from 'react'
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'

export interface ExternalPort {
  id: string
  name: string
  /** `source`: the link starts here (outside → inside). */
  type: 'source' | 'target'
}

/** `side`: edge facing the view, where all the handles sit (top / bottom in vertical orientation). */
export type ExternalNodeData = {
  label: string
  ports: ExternalPort[]
  side: 'left' | 'right' | 'top' | 'bottom'
}

const POSITION = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom
}

/** Stand-in for a module outside a drill-down view, holding the ports linked to the inside. */
export const ExternalNode = memo(function ExternalNode({
  id,
  data
}: NodeProps<Node<ExternalNodeData>>): ReactNode {
  const updateInternals = useUpdateNodeInternals()
  const portsKey = data.ports.map((p) => p.id).join(',')
  // Same node, handles on other edges when the orientation changes.
  useEffect(() => updateInternals(id), [id, data.side, portsKey, updateInternals])
  const handle = (p: ExternalPort): ReactNode => (
    <Handle
      type={p.type}
      position={POSITION[data.side]}
      id={p.id}
      className={`handle ${p.type === 'source' ? 'out' : 'in'}`}
      isConnectable={false}
    />
  )
  const label = <div className="external-label">↗ {data.label}</div>
  if (data.side === 'top' || data.side === 'bottom') {
    const band = (
      <div className={`port-band ${data.side}`}>
        {data.ports.map((p) => (
          <span key={p.id} className={`vport ${p.type === 'source' ? 'out' : 'in'}`}>
            {handle(p)}
            <span className="vport-label">{p.name}</span>
          </span>
        ))}
      </div>
    )
    return (
      <div className="external vertical" title={`${data.label} (outside this view)`}>
        {data.side === 'top' && band}
        {label}
        {data.side === 'bottom' && band}
      </div>
    )
  }
  return (
    <div className="external" title={`${data.label} (outside this view)`}>
      {label}
      {data.ports.map((p) => (
        <div className="port-row" key={p.id}>
          <span className={`port ${data.side} ${p.type === 'source' ? 'out' : 'in'}`}>
            {data.side === 'left' && handle(p)}
            {p.name}
            {data.side === 'right' && handle(p)}
          </span>
        </div>
      ))}
    </div>
  )
})
