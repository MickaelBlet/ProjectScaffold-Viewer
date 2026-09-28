import { memo, useEffect, type CSSProperties, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { minSize, nameError } from '@/model/project'
import { defaultSide, portsOn, type PortPlacement } from './portSides'
import { getProject, setLocked, setModuleLayout, update, useProjectStore } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { openModuleView } from '@/actions'
import type { Id, LinkAnchor, Port, Side } from '@/model/types'
import { anchorStyle, inward, PortPoint } from './PortPoint'
import { Icon } from '@/components/Icon'

/** Handle of a module itself: dragged to another module, links them through new ports. */
export const MODULE_HANDLE = 'module'

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
  // Ports at a hand-set link attachment (see portAnchors), out of their edge's rows.
  const anchors = (data as { anchors?: Record<Id, LinkAnchor> }).anchors ?? {}
  const free = (mod?.ports ?? []).filter((p) => !anchors[p.id])
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
  if (!mod) return null

  const [top, bottom, left, right] = (['top', 'bottom', 'left', 'right'] as const).map((side) =>
    portsOn(free, placements, side)
  )
  const rows = Math.max(left!.length, right!.length)
  const vertical = orientation === 'vertical'
  // Containers keep both bands in vertical orientation: their content starts below them.
  const topBand = top!.length > 0 || (vertical && (!floating || hasChildren))
  const bottomBand = bottom!.length > 0 || (vertical && (!floating || hasChildren))
  // Container ports moved off the orientation's edges go outside the frame, clear of the content.
  const outsideBands = hasChildren && !vertical
  const min = minSize(mod, orientation)
  const ifaceName = (p: Port): string | undefined =>
    p.interfaceId ? (interfaces.find((i) => i.id === p.interfaceId)?.name ?? '?') : undefined
  const title = (p: Port): string => `${p.role} ${p.name}: ${ifaceName(p) ?? 'no interface'}`
  const style = mod.color ? ({ '--module-color': mod.color } as CSSProperties) : undefined

  const point = (p: Port, edge: Side, fallback = inward(edge), anchor?: LinkAnchor): ReactNode => (
    <PortPoint
      key={p.id}
      moduleId={id}
      port={p}
      iface={ifaceName(p)}
      title={title(p)}
      edge={edge}
      fallback={fallback}
      className={anchor ? 'anchored' : ''}
      style={anchor && anchorStyle(anchor)}
    />
  )
  const band = (ports: Port[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side} ${outsideBands ? 'outside' : ''}`}>
      {ports.map((p) => (
        <span key={p.id} className="vport">
          {point(p, side, outsideBands ? side : inward(side))}
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
        <Handle
          type="source"
          position={vertical ? Position.Bottom : Position.Right}
          id={MODULE_HANDLE}
          className="module-connect"
          title="Drag to another module or port to link them"
        >
          <Icon name="arrow-right" />
        </Handle>
        <button
          type="button"
          className={`module-open module-lock nodrag ${mod.locked ? 'locked' : ''}`}
          title={mod.locked ? 'Unlock position and size (Ctrl+L)' : 'Lock position and size (Ctrl+L)'}
          onClick={(e) => {
            e.stopPropagation()
            setLocked([id], !mod.locked)
          }}
        >
          <Icon name={mod.locked ? 'lock' : 'unlock'} />
        </button>
        <button
          type="button"
          className="module-open nodrag"
          title="Open in its own view (Alt+Enter)"
          onClick={(e) => {
            e.stopPropagation()
            openModuleView(id)
          }}
        >
          <Icon name="expand" />
        </button>
      </div>
      {rows > 0 && (
        // A container's side ports are centered on its frame, over its content.
        <div className={`module-ports ${hasChildren ? 'framed' : ''}`}>
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
      {bottomBand && band(bottom!, 'bottom')}
      {mod.ports.map((p) => {
        const a = anchors[p.id]
        // Past top / bottom attachments the name goes outside, clear of the header.
        return a && point(p, a.side, a.side === 'left' || a.side === 'right' ? inward(a.side) : a.side, a)
      })}
    </div>
  )
})
