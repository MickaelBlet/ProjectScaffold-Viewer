import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Handle, useStore, ViewportPortal } from '@xyflow/react'
import type { Id, LinkAnchor, PortRole, Side } from '@/model/types'
import { setPortLabel } from '@/store/project'
import { Icon } from '@/components/Icon'
import { OPPOSITE, POSITION, Z } from './constants'

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

/**
 * Port name drawn in the viewport above the links (a container is below them), at the place of its
 * port point in the module, measured after each render of the module and on its moves.
 */
function Lifted(props: {
  moduleId: Id
  point: RefObject<HTMLSpanElement | null>
  children: ReactNode
}): ReactNode {
  const origin = useStore((s) => s.nodeLookup.get(props.moduleId)?.internals.positionAbsolute)
  const zoom = useStore((s) => s.transform[2])
  const at = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const point = props.point.current
    const node = point?.closest('.react-flow__node')
    if (!origin || !point || !node || !at.current) return
    const a = point.getBoundingClientRect()
    const b = node.getBoundingClientRect()
    at.current.style.transform = `translate(${origin.x + (a.left - b.left) / zoom}px, ${origin.y + (a.top - b.top) / zoom}px)`
  })
  return (
    <ViewportPortal>
      <div ref={at} className="port-point lifted" style={{ zIndex: Z.label }}>
        {props.children}
      </div>
    </ViewportPortal>
  )
}

/** Direction of `dx, dy` from the origin, along its main axis. */
function towards(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/**
 * Port as a point on its module's `edge` (placed by the parent's CSS, or `style`): its handle
 * there, its name on one side of it, by default `fallback`, dragged to another side; with `lift`,
 * the name is drawn above the links.
 */
export function PortPoint({
  moduleId,
  port,
  iface,
  title,
  edge,
  fallback,
  className = '',
  style,
  lift = false
}: {
  moduleId: Id
  port: { id: Id; role: PortRole; name: string; label?: Side }
  iface: string | undefined
  title: string
  edge: Side
  fallback: Side
  className?: string
  style?: CSSProperties
  lift?: boolean
}): ReactNode {
  /** Side of the name being dragged. */
  const [draft, setDraft] = useState<Side | null>(null)
  const label = draft ?? port.label ?? fallback
  const point = useRef<HTMLSpanElement>(null)

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

  const name = (
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
  )

  return (
    <span ref={point} className={`port-point at-${edge} ${port.role} ${className}`} style={style}>
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
      {lift ? (
        <Lifted moduleId={moduleId} point={point}>
          {name}
        </Lifted>
      ) : (
        name
      )}
    </span>
  )
}
