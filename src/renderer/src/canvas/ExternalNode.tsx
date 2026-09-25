import { memo, type ReactNode } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

export interface ExternalPort {
  id: string
  name: string
  /** `source`: the link starts here (outside → inside). */
  type: 'source' | 'target'
}

/** `side`: edge facing the view, where all the handles sit. */
export type ExternalNodeData = { label: string; ports: ExternalPort[]; side: 'left' | 'right' }

/** Stand-in for a module outside a drill-down view, holding the ports linked to the inside. */
export const ExternalNode = memo(function ExternalNode({
  data
}: NodeProps<Node<ExternalNodeData>>): ReactNode {
  const handle = (p: ExternalPort, position: Position): ReactNode => (
    <Handle
      type={p.type}
      position={position}
      id={p.id}
      className={`handle ${p.type === 'source' ? 'out' : 'in'}`}
      isConnectable={false}
    />
  )
  return (
    <div className="external" title={`${data.label} (outside this view)`}>
      <div className="external-label">↗ {data.label}</div>
      {data.ports.map((p) => (
        <div className="port-row" key={p.id}>
          <span className={`port ${data.side} ${p.type === 'source' ? 'out' : 'in'}`}>
            {data.side === 'left' && handle(p, Position.Left)}
            {p.name}
            {data.side === 'right' && handle(p, Position.Right)}
          </span>
        </div>
      ))}
    </div>
  )
})
