import { memo, useEffect, type ReactNode } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import type { Id, ImportedPort } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { defaultSide, portsOn, type PortPlacement } from './portSides'

/** Module of another project: its ports floating (see portSides.ts) or on the orientation's default edges, linkable. */
export const ImportedNode = memo(function ImportedNode({ id, selected, data }: NodeProps): ReactNode {
  const imp = useProjectStore((s) => s.project.imports.find((i) => i.modules.some((m) => m.id === id)))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const orientation = useProjectStore((s) => s.project.orientation)
  const updateInternals = useUpdateNodeInternals()
  const module = imp?.modules.find((m) => m.id === id)
  const floating = (data as { sides?: Record<Id, PortPlacement> }).sides
  const placements: Record<Id, PortPlacement> =
    floating ??
    Object.fromEntries(
      (module?.ports ?? []).map((p) => [p.id, { side: defaultSide(p.role, orientation), order: null }])
    )
  // Handles move when ports change edge or order.
  const portsKey = (['top', 'bottom', 'left', 'right'] as const)
    .map((side) => portsOn(module?.ports ?? [], placements, side).map((p) => `${p.id}:${p.role}`).join(','))
    .join('|')
  useEffect(() => updateInternals(id), [id, portsKey, updateInternals])
  if (!imp || !module) return null
  const vertical = orientation === 'vertical'
  const [top, bottom, left, right] = (['top', 'bottom', 'left', 'right'] as const).map((side) =>
    portsOn(module.ports, placements, side)
  )
  const iface = (p: ImportedPort): string => p.interface ?? '—'
  const unknown = (p: ImportedPort): boolean =>
    !!p.interface && !interfaces.some((i) => i.name === p.interface)
  const title = (p: ImportedPort): string =>
    `${p.role} ${p.name}: ${iface(p)}${unknown(p) ? ' (interface not defined in this project)' : ''}`
  const handle = (p: ImportedPort, position: Position): ReactNode => (
    <Handle
      type={p.role === 'in' ? 'target' : 'source'}
      position={position}
      id={p.id}
      className={`handle ${p.role}`}
    />
  )
  const band = (list: ImportedPort[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side}`}>
      {list.map((p) => (
        <span key={p.id} className={`vport ${p.role} ${unknown(p) ? 'unknown' : ''}`} title={title(p)}>
          {handle(p, side === 'top' ? Position.Top : Position.Bottom)}
          <span className="vport-label">
            {p.name} <small>{iface(p)}</small>
          </span>
        </span>
      ))}
    </div>
  )
  const rows = Math.max(left!.length, right!.length)

  return (
    <div
      className={`module imported ${vertical ? 'vertical' : ''} ${selected ? 'selected' : ''}`}
      title={`${module.path} in ${imp.file}`}
    >
      {(top!.length > 0 || (!floating && vertical)) && band(top!, 'top')}
      <div className="module-header">
        <span className="module-name">
          <small className="imported-project">↗ {imp.name}</small> {module.path}
        </span>
      </div>
      {rows > 0 && (
        <div className="module-ports">
          {Array.from({ length: rows }, (_, i) => {
            const pl = left![i]
            const pr = right![i]
            return (
              <div className="port-row" key={i}>
                {pl && (
                  <span className={`port left ${pl.role} ${unknown(pl) ? 'unknown' : ''}`} title={title(pl)}>
                    {handle(pl, Position.Left)}
                    {pl.name}
                    <small>{iface(pl)}</small>
                  </span>
                )}
                {pr && (
                  <span className={`port right ${pr.role} ${unknown(pr) ? 'unknown' : ''}`} title={title(pr)}>
                    <small>{iface(pr)}</small>
                    {pr.name}
                    {handle(pr, Position.Right)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {(bottom!.length > 0 || (!floating && vertical)) && band(bottom!, 'bottom')}
    </div>
  )
})
