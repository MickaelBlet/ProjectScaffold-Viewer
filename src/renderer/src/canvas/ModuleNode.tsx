import { memo, useEffect, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { leafHeight } from '@/model/project'
import { setModuleLayout, useProjectStore } from '@/store/project'
import type { Port } from '@/model/types'

export const ModuleNode = memo(function ModuleNode({ id, selected }: NodeProps): ReactNode {
  const mod = useProjectStore((s) => s.project.modules.find((m) => m.id === id))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const hasChildren = useProjectStore((s) => s.project.modules.some((m) => m.parentId === id))
  const updateInternals = useUpdateNodeInternals()
  const portsKey = mod?.ports.map((p) => `${p.id}:${p.role}`).join(',')
  useEffect(() => updateInternals(id), [id, portsKey, updateInternals])
  if (!mod) return null

  const ins = mod.ports.filter((p) => p.role === 'in')
  const outs = mod.ports.filter((p) => p.role === 'out')
  const rows = Math.max(ins.length, outs.length)
  const ifaceName = (p: Port): string =>
    p.interfaceId ? (interfaces.find((i) => i.id === p.interfaceId)?.name ?? '?') : '—'

  return (
    <div
      className={`module ${hasChildren ? 'container' : ''} ${selected ? 'selected' : ''}`}
      title={mod.description}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={leafHeight(rows)}
        onResizeEnd={(_, r) => setModuleLayout(id, { x: r.x, y: r.y, width: r.width, height: r.height })}
      />
      <div className="module-header">{mod.name}</div>
      <div className="module-ports">
        {Array.from({ length: rows }, (_, i) => {
          const pin = ins[i]
          const pout = outs[i]
          return (
            <div className="port-row" key={i}>
              {pin && (
                <span className="port in" title={`in ${pin.name}: ${ifaceName(pin)}`}>
                  <Handle type="target" position={Position.Left} id={pin.id} className="handle in" />
                  {pin.name}
                  <small>{ifaceName(pin)}</small>
                </span>
              )}
              {pout && (
                <span className="port out" title={`out ${pout.name}: ${ifaceName(pout)}`}>
                  <small>{ifaceName(pout)}</small>
                  {pout.name}
                  <Handle type="source" position={Position.Right} id={pout.id} className="handle out" />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})
