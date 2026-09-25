import { memo, type ReactNode } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

export interface ExternalPort {
  id: string
  name: string
  /** `source`: the link starts here (outside → inside). */
  type: 'source' | 'target'
}

export type ExternalNodeData = { label: string; ports: ExternalPort[] }

/** Stand-in for a module outside a drill-down view, holding the ports linked to the inside. */
export const ExternalNode = memo(function ExternalNode({
  data
}: NodeProps<Node<ExternalNodeData>>): ReactNode {
  return (
    <div className="external" title={`${data.label} (outside this view)`}>
      <div className="external-label">↗ {data.label}</div>
      {data.ports.map((p) => (
        <div className="port-row" key={p.id}>
          <span className={`port ${p.type === 'source' ? 'out' : 'in'}`}>
            {p.type === 'target' && (
              <Handle
                type="target"
                position={Position.Left}
                id={p.id}
                className="handle in"
                isConnectable={false}
              />
            )}
            {p.name}
            {p.type === 'source' && (
              <Handle
                type="source"
                position={Position.Right}
                id={p.id}
                className="handle out"
                isConnectable={false}
              />
            )}
          </span>
        </div>
      ))}
    </div>
  )
})
