import { memo, useEffect, type ReactNode } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import type { ImportedPort } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { defaultSide } from './portSides'

/** Module of another project: its ports on the orientation's default edges, linkable. */
export const ImportedNode = memo(function ImportedNode({ id, selected }: NodeProps): ReactNode {
  const imp = useProjectStore((s) => s.project.imports.find((i) => i.modules.some((m) => m.id === id)))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const orientation = useProjectStore((s) => s.project.orientation)
  const updateInternals = useUpdateNodeInternals()
  const module = imp?.modules.find((m) => m.id === id)
  const portsKey = module?.ports.map((p) => `${p.id}:${p.role}`).join(',')
  useEffect(() => updateInternals(id), [id, portsKey, orientation, updateInternals])
  if (!imp || !module) return null
  const ports = module.ports
  const vertical = orientation === 'vertical'
  const ins = ports.filter((p) => p.role === 'in')
  const outs = ports.filter((p) => p.role === 'out')
  const iface = (p: ImportedPort): string => p.interface ?? '—'
  const unknown = (p: ImportedPort): boolean =>
    !!p.interface && !interfaces.some((i) => i.name === p.interface)
  const title = (p: ImportedPort): string =>
    `${p.role} ${p.name}: ${iface(p)}${unknown(p) ? ' (interface not defined in this project)' : ''}`
  const handle = (p: ImportedPort): ReactNode => {
    const side = defaultSide(p.role, orientation)
    const position = {
      left: Position.Left,
      right: Position.Right,
      top: Position.Top,
      bottom: Position.Bottom
    }[side]
    return (
      <Handle
        type={p.role === 'in' ? 'target' : 'source'}
        position={position}
        id={p.id}
        className={`handle ${p.role}`}
      />
    )
  }
  const band = (list: ImportedPort[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side}`}>
      {list.map((p) => (
        <span key={p.id} className={`vport ${p.role} ${unknown(p) ? 'unknown' : ''}`} title={title(p)}>
          {handle(p)}
          <span className="vport-label">
            {p.name} <small>{iface(p)}</small>
          </span>
        </span>
      ))}
    </div>
  )
  const rows = Math.max(ins.length, outs.length)

  return (
    <div
      className={`module imported ${vertical ? 'vertical' : ''} ${selected ? 'selected' : ''}`}
      title={`${module.path} in ${imp.file}`}
    >
      {vertical && band(ins, 'top')}
      <div className="module-header">
        <span className="module-name">
          <small className="imported-project">↗ {imp.name}</small> {module.path}
        </span>
      </div>
      {!vertical && rows > 0 && (
        <div className="module-ports">
          {Array.from({ length: rows }, (_, i) => {
            const pl = ins[i]
            const pr = outs[i]
            return (
              <div className="port-row" key={i}>
                {pl && (
                  <span className={`port left in ${unknown(pl) ? 'unknown' : ''}`} title={title(pl)}>
                    {handle(pl)}
                    {pl.name}
                    <small>{iface(pl)}</small>
                  </span>
                )}
                {pr && (
                  <span className={`port right out ${unknown(pr) ? 'unknown' : ''}`} title={title(pr)}>
                    <small>{iface(pr)}</small>
                    {pr.name}
                    {handle(pr)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {vertical && band(outs, 'bottom')}
    </div>
  )
})
