import { useState, type CSSProperties, type ReactNode } from 'react'
import { Handle } from '@xyflow/react'
import type { Id, LinkAnchor, PortRole, Side } from '@/model/types'
import { setPortLabel } from '@/store/project'
import { Icon } from '@/components/Icon'
import { OPPOSITE, POSITION } from './constants'

/** Direction pointing into a module from its `edge`. */
export const inward = (edge: Side): Side => OPPOSITE[edge]

/** Place of a port point at a hand-set link attachment (see portAnchors), along its edge. */
export function anchorStyle(a: LinkAnchor): CSSProperties {
  const at = `${Math.min(1, Math.max(0, a.at)) * 100}%`
  return a.side === 'left' || a.side === 'right' ? { top: at } : { left: at }
}

/** Screen pixels a name is dragged before it moves. */
const DRAG_PX = 4

/** Interface of a port beside its name, a warning when it has none. */
function IfaceLabel({ name }: { name: string | undefined }): ReactNode {
  return name === undefined ? (
    <small className="no-iface" title="No interface">
      <Icon name="warning" />
    </small>
  ) : (
    <small>{name}</small>
  )
}

/** Direction of `dx, dy` from the origin, along its main axis. */
function towards(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/**
 * Port as a point on its module's `edge` (placed by the parent's CSS, or `style`): its handle
 * there, its name on one side of it, by default `fallback`, dragged to another side.
 */
export function PortPoint({
  moduleId,
  port,
  iface,
  title,
  edge,
  fallback,
  className = '',
  style
}: {
  moduleId: Id
  port: { id: Id; role: PortRole; name: string; label?: Side }
  iface: string | undefined
  title: string
  edge: Side
  fallback: Side
  className?: string
  style?: CSSProperties
}): ReactNode {
  /** Side of the name being dragged. */
  const [draft, setDraft] = useState<Side | null>(null)
  const label = draft ?? port.label ?? fallback

  /** Drags the name around the handle, to the side the pointer is on. */
  const dragLabel = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    const point = e.currentTarget.parentElement!.getBoundingClientRect()
    const start = { x: e.clientX, y: e.clientY }
    let moved: Side | null = null
    const move = (ev: PointerEvent): void => {
      if (moved === null && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return
      setDraft((moved = towards(ev.clientX - point.x, ev.clientY - point.y)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      if (!moved) return
      // The click ending a drag does not select the module.
      const swallow = (ev: MouseEvent): void => ev.stopPropagation()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }))
      if (moved !== label) setPortLabel(moduleId, port.id, moved === fallback ? undefined : moved)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <span className={`port-point at-${edge} ${port.role} ${className}`} style={style}>
      <Handle
        type={port.role === 'in' ? 'target' : 'source'}
        position={POSITION[edge]}
        id={port.id}
        className={`handle ${port.role}`}
        title={title}
      />
      {/* Same port seen from the inside, for links between a container and its content: an in
          port as a source, an out port as a target, both leaving inwards. Dropping on it links
          the port, as on its handle. */}
      <Handle
        type={port.role === 'in' ? 'source' : 'target'}
        position={POSITION[inward(edge)]}
        id={port.id}
        className="inner-handle"
        isConnectableStart={false}
      />
      <span
        className={`port-label label-${label} nodrag nopan ${draft ? 'dragging' : ''}`}
        title={`${title}\nDrag around the port to move its name; double-click to reset`}
        onPointerDown={dragLabel}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (port.label) setPortLabel(moduleId, port.id, undefined)
        }}
      >
        {port.name}
        <IfaceLabel name={iface} />
      </span>
    </span>
  )
}
