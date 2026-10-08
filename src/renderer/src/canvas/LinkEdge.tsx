import { memo, useState, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Position,
  useInternalNode,
  useReactFlow,
  useStoreApi,
  type EdgeProps,
  type InternalNode
} from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { indexById, linkOrigin } from '@/model/project'
import { setLinkRoute, useProjectStore } from '@/store/project'
import { useSettings } from '@/store/settings'
import { openContextMenu, select } from '@/store/ui'
import { revealInspector } from '@/shell/controllers'
import type { LinkRoute, Orientation } from '@/model/types'
import { OPPOSITE, PERF_COLORS, POSITION, SIDE, Z } from './constants'
import { orientLinkEnds } from './linkEnds'
import {
  anchorPoint,
  fractionAlong,
  insertIndex,
  nearestAnchor,
  pathPoints,
  pointAlong,
  routeThrough,
  snapToNeighbours,
  type Point,
  type Route
} from './linkRoute'
import { Icon } from '@/components/Icon'
import { useDrawn } from './viewContext'

type Lookup = (id: string) => InternalNode | undefined

function isAncestor(lookup: Lookup, ancestor: string, id: string): boolean {
  let cur = lookup(id)?.parentId
  while (cur) {
    if (cur === ancestor) return true
    cur = lookup(cur)?.parentId
  }
  return false
}

const rectOf = (n: InternalNode) => ({
  ...n.internals.positionAbsolute,
  width: n.measured.width ?? 0,
  height: n.measured.height ?? 0
})

/** End points of a link: where set by hand, else at the ports or auto-oriented towards the other end. */
function endPoints(
  props: EdgeProps,
  source: InternalNode | undefined,
  target: InternalNode | undefined,
  lookup: Lookup,
  auto: boolean,
  orientation: Orientation,
  route: LinkRoute | undefined
) {
  const ends = portEnds(props, source, target, lookup, auto, orientation)
  const anchored = (node: InternalNode | undefined, anchor: LinkRoute['from']) =>
    node && anchor ? anchorPoint(rectOf(node), anchor) : null
  const from = anchored(source, route?.from)
  const to = anchored(target, route?.to)
  // Ports are drawn at their attachment (portAnchors) unless another link's attachment took them.
  const atPort = (p: Point, x: number, y: number): boolean => Math.hypot(p.x - x, p.y - y) < 8
  const out = {
    ...ends,
    ...(from && { sourceX: from.x, sourceY: from.y, sourcePosition: POSITION[route!.from!.side] }),
    ...(to && { targetX: to.x, targetY: to.y, targetPosition: POSITION[route!.to!.side] }),
    moved: [
      from ? !atPort(from, props.sourceX, props.sourceY) : ends.moved[0]!,
      to ? !atPort(to, props.targetX, props.targetY) : ends.moved[1]!
    ]
  }
  // A container's end of a link to its content leaves inwards, from the edge it sits on.
  const inwards = (node: InternalNode, x: number, y: number): Position =>
    POSITION[OPPOSITE[nearestAnchor(rectOf(node), { x, y }).side]]
  if (source && target && isAncestor(lookup, source.id, target.id))
    out.sourcePosition = inwards(source, out.sourceX, out.sourceY)
  if (source && target && isAncestor(lookup, target.id, source.id))
    out.targetPosition = inwards(target, out.targetX, out.targetY)
  return out
}

function portEnds(
  props: EdgeProps,
  source: InternalNode | undefined,
  target: InternalNode | undefined,
  lookup: Lookup,
  auto: boolean,
  orientation: Orientation
) {
  const base = {
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    moved: [false, false]
  }
  if (!auto || !source || !target) return base
  // A container's port links to its content from the inside: keep the sides.
  if (isAncestor(lookup, source.id, target.id) || isAncestor(lookup, target.id, source.id)) return base
  // Floating ports already sit on the facing edge (portSides.ts): the link starts at the port.
  const floats = [source, target].map((n) => !!(n.data as { sides?: unknown }).sides)
  if (floats[0] && floats[1]) return base
  const ends = orientLinkEnds(
    { rect: rectOf(source), handle: { x: props.sourceX, y: props.sourceY } },
    { rect: rectOf(target), handle: { x: props.targetX, y: props.targetY } },
    orientation
  )
  const from = floats[0]
    ? { x: props.sourceX, y: props.sourceY, position: props.sourcePosition }
    : { x: ends.source.x, y: ends.source.y, position: POSITION[ends.source.side] }
  const to = floats[1]
    ? { x: props.targetX, y: props.targetY, position: props.targetPosition }
    : { x: ends.target.x, y: ends.target.y, position: POSITION[ends.target.side] }
  return {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: from.position,
    targetX: to.x,
    targetY: to.y,
    targetPosition: to.position,
    // Fixed ports (containers) whose link leaves from another edge get a dot there.
    moved: [
      !floats[0] && ends.source.side !== (orientation === 'vertical' ? 'bottom' : 'right'),
      !floats[1] && ends.target.side !== (orientation === 'vertical' ? 'top' : 'left')
    ]
  }
}

/** Screen pixels within which a dragged point lines up with its neighbours. */
const ALIGN_PX = 6

/** Swallow the click a drag ends with: released off the handle, it would land on the pane (deselecting). */
function swallowClick(): void {
  const stop = (ev: MouseEvent): void => ev.stopPropagation()
  window.addEventListener('click', stop, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }))
}

/**
 * Follows the pointer from a pointer down on a handle until it is released. Pointer downs are
 * cancelled on the canvas, so no `dblclick` follows: double clicks are clicks with `detail` 2.
 */
function follow(e: React.PointerEvent, move: (ev: PointerEvent) => void, end: () => void): void {
  e.preventDefault()
  e.stopPropagation()
  // Grabbing cursor wherever the pointer goes until released.
  document.documentElement.classList.add('grabbing')
  const start = { x: e.clientX, y: e.clientY }
  let dragged = false
  const onMove = (ev: PointerEvent): void => {
    dragged ||= ev.clientX !== start.x || ev.clientY !== start.y
    move(ev)
  }
  const up = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', up)
    document.documentElement.classList.remove('grabbing')
    if (dragged) swallowClick()
    end()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', up)
}

export const LinkEdge = memo(function LinkEdge(props: EdgeProps): ReactNode {
  // Shape of the link in the canvas's view.
  const link = useDrawn((p) => indexById(p.links).get(props.id))
  const origin = useDrawn((p) => {
    const l = indexById(p.links).get(props.id)
    return l ? linkOrigin(p, l) : null
  })
  const { edgeStyle, edgeBadges, autoOrientLinks, snapToGrid, gridSize } = useSettings(
    useShallow((s) => ({
      edgeStyle: s.edgeStyle,
      edgeBadges: s.edgeBadges,
      autoOrientLinks: s.autoOrientLinks,
      snapToGrid: s.snapToGrid,
      gridSize: s.gridSize
    }))
  )
  const source = useInternalNode(props.source)
  const target = useInternalNode(props.target)
  const store = useStoreApi()
  const flow = useReactFlow()
  const lookup: Lookup = (id) => store.getState().nodeLookup.get(id)
  const orientation = useProjectStore((s) => s.project.orientation)
  /** Shape being dragged, with absolute bend points. */
  const [draft, setDraft] = useState<LinkRoute | null>(null)

  // Bend points are relative to the module holding both ends as the view draws it (none for the
  // links to the modules outside a drill-down view: absolute).
  const originNode = origin ? lookup(origin) : undefined
  const editable = !origin || !!originNode
  const offset = originNode?.internals.positionAbsolute ?? { x: 0, y: 0 }
  const saved =
    editable && link?.route
      ? { ...link.route, points: link.route.points.map((pt) => ({ x: pt.x + offset.x, y: pt.y + offset.y })) }
      : undefined
  const route = draft ?? saved
  const ends = endPoints(props, source, target, lookup, autoOrientLinks, orientation, route)
  const s = { x: ends.sourceX, y: ends.sourceY, side: SIDE[ends.sourcePosition] }
  const t = { x: ends.targetX, y: ends.targetY, side: SIDE[ends.targetPosition] }
  const shaped: Route | null = route?.points.length ? routeThrough(edgeStyle, s, t, route.points) : null
  const [path, midX, midY] = shaped
    ? [shaped.path, shaped.label.x, shaped.label.y]
    : edgeStyle === 'straight'
      ? getStraightPath(ends)
      : edgeStyle === 'bezier'
        ? getBezierPath(ends)
        : getSmoothStepPath({ ...ends, borderRadius: edgeStyle === 'step' ? 0 : 8 })
  const label = route?.label !== undefined ? pointAlong(pathPoints(path), route.label) : { x: midX, y: midY }
  if (!link) return null
  const c = link.constraints
  const color = PERF_COLORS[c.performance.class]

  const base: LinkRoute = route ?? { points: [] }
  const commit = (r: LinkRoute): void => {
    setDraft(null)
    setLinkRoute(link.id, {
      ...r,
      points: r.points.map((pt) => ({ x: Math.round(pt.x - offset.x), y: Math.round(pt.y - offset.y) }))
    })
  }
  const flowPoint = (ev: { clientX: number; clientY: number }): Point =>
    flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
  /** Grid, then the lines of the neighbours; Alt places freely. */
  const place = (p: Point, neighbours: Point[], ev: PointerEvent): Point => {
    if (ev.altKey) return p
    const q = snapToGrid
      ? { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize }
      : p
    return snapToNeighbours(q, neighbours, ALIGN_PX / flow.getZoom())
  }

  /** Drags bend point `i` of `points`. */
  const dragBend = (e: React.PointerEvent, points: Point[], i: number): void => {
    const controls = [s, ...points, t]
    let moved: LinkRoute | null = null
    follow(
      e,
      (ev) => {
        const next = [...points]
        next[i] = place(flowPoint(ev), [controls[i]!, controls[i + 2]!], ev)
        setDraft((moved = { ...base, points: next }))
      },
      () => moved && commit(moved)
    )
  }
  /** A drag on the selected line adds a bend point there. */
  const grabLine = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const at = flowPoint(e)
    const i = shaped ? insertIndex(shaped, at) : 0
    dragBend(e, [...base.points.slice(0, i), at, ...base.points.slice(i)], i)
  }
  const addBend = (e: React.MouseEvent): void => {
    const at = flowPoint(e)
    const i = shaped ? insertIndex(shaped, at) : 0
    commit({ ...base, points: [...base.points.slice(0, i), at, ...base.points.slice(i)] })
  }
  const removeBend = (i: number): void => commit({ ...base, points: base.points.filter((_, k) => k !== i) })

  /** Drags an end along the border of its module. */
  const dragEnd = (e: React.PointerEvent, which: 'from' | 'to'): void => {
    const node = which === 'from' ? source : target
    if (e.button !== 0 || !node) return
    const r = rectOf(node)
    const controls = [s, ...base.points, t]
    const neighbour = which === 'from' ? controls[1]! : controls[controls.length - 2]!
    const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    let moved: LinkRoute | null = null
    follow(
      e,
      (ev) => {
        const p = ev.altKey
          ? flowPoint(ev)
          : snapToNeighbours(flowPoint(ev), [neighbour, center], ALIGN_PX / flow.getZoom())
        setDraft((moved = { ...base, [which]: nearestAnchor(r, p) }))
      },
      () => moved && commit(moved)
    )
  }
  const detach = (which: 'from' | 'to'): void => commit({ ...base, [which]: undefined })

  /** Drags the badges along the link; a mere click selects the link. */
  const dragLabel = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !editable) return
    const line = pathPoints(path)
    const start = flowPoint(e)
    // Keeps the badges where they were grabbed.
    const grab = { x: label.x - start.x, y: label.y - start.y }
    let moved: LinkRoute | null = null
    follow(
      e,
      (ev) => {
        const p = flowPoint(ev)
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * flow.getZoom() < 3) return
        setDraft((moved = { ...base, label: fractionAlong(line, { x: p.x + grab.x, y: p.y + grab.y }) }))
      },
      () => moved && commit(moved)
    )
  }

  const handleMenu = (e: React.MouseEvent, label: string, run: () => void): void => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e, [{ label, run }])
  }
  const at = (p: Point) => ({ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` })

  return (
    <>
      {/* Selection halo, under the link. */}
      {props.selected && <path className="edge-halo" d={path} stroke={color} />}
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        interactionWidth={0}
        style={{
          stroke: color,
          strokeWidth: props.selected ? 3 : 2,
          strokeDasharray: c.remote.enabled ? '6 4' : undefined
        }}
      />
      {/* Hit area of the line, naming the link on hover. */}
      <path className="react-flow__edge-interaction" d={path} fill="none" strokeOpacity={0} strokeWidth={16}>
        <title>{link.name}</title>
      </path>
      {/* Selection: dashes flowing along the link's direction. */}
      {props.selected && <path className="edge-flow" d={path} />}
      {/* Selected link: drag its line to bend it there. */}
      {props.selected && editable && (
        <path
          className="route-grab nodrag nopan"
          d={path}
          onPointerDown={grabLine}
          onClick={(e) => e.detail === 2 && addBend(e)}
        >
          <title>{link.name}</title>
        </path>
      )}
      {/* Attachment dots where an end left its port's side. */}
      {ends.moved[0] && (
        <circle className="attach" cx={ends.sourceX} cy={ends.sourceY} r={3.5} fill={color} />
      )}
      {ends.moved[1] && (
        <circle className="attach" cx={ends.targetX} cy={ends.targetY} r={3.5} fill={color} />
      )}
      <EdgeLabelRenderer>
        {props.selected &&
          editable &&
          (['from', 'to'] as const).map((which) => (
            <div
              key={which}
              className={`route-handle end nodrag nopan ${base[which] ? 'set' : ''}`}
              style={at(which === 'from' ? s : t)}
              title={
                base[which]
                  ? 'Drag along the module to move the attachment; double-click to attach at the port'
                  : 'Drag along the module to attach the link there'
              }
              onPointerDown={(e) => dragEnd(e, which)}
              onClick={(e) => e.detail === 2 && base[which] && detach(which)}
              onContextMenu={(e) =>
                base[which] ? handleMenu(e, 'Attach at the port', () => detach(which)) : e.preventDefault()
              }
            />
          ))}
        {props.selected &&
          editable &&
          base.points.map((pt, i) => (
            <div
              key={i}
              className="route-handle bend nodrag nopan"
              style={at(pt)}
              title="Drag to move the bend; double-click to remove it (Alt: no snapping)"
              onPointerDown={(e) => e.button === 0 && dragBend(e, base.points, i)}
              onClick={(e) => e.detail === 2 && removeBend(i)}
              onContextMenu={(e) => handleMenu(e, 'Remove bend', () => removeBend(i))}
            />
          ))}
        <div
          className={`edge-label nodrag nopan ${props.selected ? 'selected' : ''} ${edgeBadges ? '' : 'compact'} ${editable ? 'movable' : ''}`}
          style={{ ...at(label), zIndex: Z.link }}
          onPointerDown={dragLabel}
          onClick={(e) => {
            if (e.detail === 2 && editable && base.label !== undefined)
              return commit({ ...base, label: undefined })
            select({ kind: 'link', id: link.id })
            revealInspector()
          }}
          title={
            editable
              ? `${link.name}\nDrag along the link to move; double-click to put back in the middle`
              : link.name
          }
        >
          {edgeBadges ? (
            <>
              <span className="badge dir">
                <Icon name={c.direction === 'bidirectional' ? 'arrow-left-right' : 'arrow-right'} />
              </span>
              {c.ack.required && (
                <span className="badge ack">ACK{c.ack.timeoutMs ? ` ${c.ack.timeoutMs}ms` : ''}</span>
              )}
              {c.performance.class !== 'normal' && (
                <span className="badge perf" style={{ borderColor: color, background: color }}>
                  {c.performance.class}
                </span>
              )}
              {c.remote.enabled && (
                <span className="badge remote">
                  <Icon name="globe" /> {c.remote.transport || 'remote'}
                </span>
              )}
            </>
          ) : (
            <span className="edge-dot" style={{ background: color }} />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
