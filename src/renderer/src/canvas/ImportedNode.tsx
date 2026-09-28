import { memo, useEffect, type ReactNode } from 'react'
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import type { Id, ImportedPort, LinkAnchor, Side } from '@/model/types'
import { anchorStyle, inward, PortPoint } from './PortPoint'
import { useProjectStore } from '@/store/project'
import { defaultSide, portsOn, type PortPlacement } from './portSides'
import { Icon } from '@/components/Icon'

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
  // Ports at a hand-set link attachment (see portAnchors), out of their edge's rows.
  const anchors = (data as { anchors?: Record<Id, LinkAnchor> }).anchors ?? {}
  const free = (module?.ports ?? []).filter((p) => !anchors[p.id])
  // Handles move when ports change edge, order or attachment.
  const portsKey = [
    ...(['top', 'bottom', 'left', 'right'] as const).map((side) =>
      portsOn(free, placements, side)
        .map((p) => `${p.id}:${p.role}`)
        .join(',')
    ),
    ...Object.entries(anchors).map(([p, a]) => `${p}:${a.side}:${a.at}`)
  ].join('|')
  useEffect(() => updateInternals(id), [id, portsKey, updateInternals])
  if (!imp || !module) return null
  const vertical = orientation === 'vertical'
  const [top, bottom, left, right] = (['top', 'bottom', 'left', 'right'] as const).map((side) =>
    portsOn(free, placements, side)
  )
  const iface = (p: ImportedPort): string | undefined => p.interface ?? undefined
  const unknown = (p: ImportedPort): boolean =>
    !!p.interface && !interfaces.some((i) => i.name === p.interface)
  const title = (p: ImportedPort): string =>
    `${p.role} ${p.name}: ${iface(p) ?? 'no interface'}${unknown(p) ? ' (interface not defined in this project)' : ''}`
  const point = (p: ImportedPort, edge: Side, fallback = inward(edge), anchor?: LinkAnchor): ReactNode => (
    <PortPoint
      key={p.id}
      moduleId={id}
      port={p}
      iface={iface(p)}
      title={title(p)}
      edge={edge}
      fallback={fallback}
      className={`${unknown(p) ? 'unknown' : ''} ${anchor ? 'anchored' : ''}`}
      style={anchor && anchorStyle(anchor)}
    />
  )
  const band = (list: ImportedPort[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side}`}>
      {list.map((p) => (
        <span key={p.id} className="vport">
          {point(p, side)}
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
          <small className="imported-project">
            <Icon name="arrow-up-right" /> {imp.name}
          </small>{' '}
          {module.path}
        </span>
      </div>
      {rows > 0 && (
        <div className="module-ports">
          {Array.from({ length: rows }, (_, i) => {
            const pl = left![i]
            const pr = right![i]
            return (
              <div className="port-row" key={i}>
                {pl && point(pl, 'left')}
                {pr && point(pr, 'right')}
              </div>
            )
          })}
        </div>
      )}
      {(bottom!.length > 0 || (!floating && vertical)) && band(bottom!, 'bottom')}
      {module.ports.map((p) => {
        const a = anchors[p.id]
        // Past top / bottom attachments the name goes outside, clear of the header.
        return a && point(p, a.side, a.side === 'left' || a.side === 'right' ? inward(a.side) : a.side, a)
      })}
    </div>
  )
})
