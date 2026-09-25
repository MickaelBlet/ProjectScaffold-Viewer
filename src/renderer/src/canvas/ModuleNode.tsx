import { memo, useEffect, type CSSProperties, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { minSize, nameError } from '@/model/project'
import { defaultSide, portsOn, type PortPlacement } from './portSides'
import { getProject, setModuleLayout, update, useProjectStore } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { openModuleView } from '@/actions'
import type { Id, Port } from '@/model/types'

function RenameInput({
  id,
  name,
  parentId
}: {
  id: string
  name: string
  parentId: string | null
}): ReactNode {
  const done = (value: string | null): void => {
    useUiStore.setState({ renaming: null })
    if (value === null || value === name) return
    if (nameError(getProject(), { kind: 'module', id, parentId }, value)) return
    update((d) => {
      const m = d.modules.find((m) => m.id === id)
      if (m) m.name = value
    })
  }
  return (
    <input
      className="module-rename nodrag"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') done(e.currentTarget.value)
        if (e.key === 'Escape') done(null)
      }}
      onBlur={(e) => done(e.target.value)}
      onChange={(e) => {
        const error = nameError(getProject(), { kind: 'module', id, parentId }, e.target.value)
        e.target.classList.toggle('invalid', !!error && e.target.value !== name)
        e.target.title = error ?? ''
      }}
    />
  )
}

export const ModuleNode = memo(function ModuleNode({ id, selected, draggable, data }: NodeProps): ReactNode {
  const mod = useProjectStore((s) => s.project.modules.find((m) => m.id === id))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const hasChildren = useProjectStore((s) => s.project.modules.some((m) => m.parentId === id))
  const orientation = useProjectStore((s) => s.project.orientation)
  const renaming = useUiStore((s) => s.renaming === id)
  const updateInternals = useUpdateNodeInternals()
  // Floating ports (see portSides.ts), else the orientation's default edges.
  const floating = (data as { sides?: Record<Id, PortPlacement> }).sides
  const placements: Record<Id, PortPlacement> =
    floating ??
    Object.fromEntries(
      (mod?.ports ?? []).map((p) => [p.id, { side: defaultSide(p.role, orientation), order: null }])
    )
  const portsKey = mod?.ports.map((p) => `${p.id}:${p.role}:${placements[p.id]?.side}`).join(',')
  useEffect(() => updateInternals(id), [id, portsKey, updateInternals])
  if (!mod) return null

  const [top, bottom, left, right] = (['top', 'bottom', 'left', 'right'] as const).map((side) =>
    portsOn(mod.ports, placements, side)
  )
  const rows = Math.max(left!.length, right!.length)
  const vertical = orientation === 'vertical'
  // Containers keep both bands in vertical orientation: their content starts below them.
  const topBand = top!.length > 0 || (!floating && vertical)
  const bottomBand = bottom!.length > 0 || (!floating && vertical)
  const min = minSize(mod, orientation)
  const ifaceName = (p: Port): string =>
    p.interfaceId ? (interfaces.find((i) => i.id === p.interfaceId)?.name ?? '?') : '—'
  const style = mod.color ? ({ '--module-color': mod.color } as CSSProperties) : undefined

  const handle = (p: Port, position: Position): ReactNode => (
    <Handle
      type={p.role === 'in' ? 'target' : 'source'}
      position={position}
      id={p.id}
      className={`handle ${p.role}`}
    />
  )
  const band = (ports: Port[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side}`}>
      {ports.map((p) => (
        <span key={p.id} className={`vport ${p.role}`} title={`${p.role} ${p.name}: ${ifaceName(p)}`}>
          {handle(p, side === 'top' ? Position.Top : Position.Bottom)}
          {p.name}
          <small>{ifaceName(p)}</small>
        </span>
      ))}
    </div>
  )

  return (
    <div
      className={`module ${vertical ? 'vertical' : ''} ${hasChildren ? 'container' : ''} ${selected ? 'selected' : ''} ${mod.color ? 'colored' : ''}`}
      style={style}
      title={mod.description}
    >
      <NodeResizer
        isVisible={selected && draggable}
        minWidth={min.width}
        minHeight={min.height}
        onResizeEnd={(_, r) => setModuleLayout(id, { x: r.x, y: r.y, width: r.width, height: r.height })}
      />
      {topBand && band(top!, 'top')}
      <div className="module-header" onDoubleClick={() => useUiStore.setState({ renaming: id })}>
        {renaming ? (
          <RenameInput id={id} name={mod.name} parentId={mod.parentId} />
        ) : (
          <span className="module-name">{mod.name}</span>
        )}
        {hasChildren && (
          <button
            type="button"
            className="module-open nodrag"
            title="Open in its own view (Alt+Enter)"
            onClick={(e) => {
              e.stopPropagation()
              openModuleView(id)
            }}
          >
            ⤢
          </button>
        )}
      </div>
      {rows > 0 && (
        <div className="module-ports">
          {Array.from({ length: rows }, (_, i) => {
            const pl = left![i]
            const pr = right![i]
            return (
              <div className="port-row" key={i}>
                {pl && (
                  <span className={`port left ${pl.role}`} title={`${pl.role} ${pl.name}: ${ifaceName(pl)}`}>
                    {handle(pl, Position.Left)}
                    {pl.name}
                    <small>{ifaceName(pl)}</small>
                  </span>
                )}
                {pr && (
                  <span className={`port right ${pr.role}`} title={`${pr.role} ${pr.name}: ${ifaceName(pr)}`}>
                    <small>{ifaceName(pr)}</small>
                    {pr.name}
                    {handle(pr, Position.Right)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {bottomBand && band(bottom!, 'bottom')}
    </div>
  )
})
