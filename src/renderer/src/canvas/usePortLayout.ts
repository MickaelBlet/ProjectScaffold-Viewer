import { useEffect } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import type { Id, LinkAnchor, Orientation, PortRole } from '@/model/types'
import type { PortNodeData } from './flowGraph'
import { defaultSide, portsOn, type PortPlacement } from './portSides'

const SIDES = ['top', 'bottom', 'left', 'right'] as const

/**
 * Where the ports of a module node are drawn: floating (see portSides.ts), else on the
 * orientation's default edges; ports at a hand-set link attachment (see portAnchors) are out of
 * their edge's rows. Keeps React Flow's handles in step when ports change edge, order or attachment.
 */
export function usePortLayout<P extends { id: Id; role: PortRole }>(
  nodeId: Id,
  ports: P[],
  data: PortNodeData,
  orientation: Orientation
): {
  /** Placement given by the floating ports (not the orientation's defaults). */
  floating: boolean
  anchors: Record<Id, LinkAnchor>
  top: P[]
  bottom: P[]
  left: P[]
  right: P[]
} {
  const updateInternals = useUpdateNodeInternals()
  const placements: Record<Id, PortPlacement> =
    data.sides ??
    Object.fromEntries(ports.map((p) => [p.id, { side: defaultSide(p.role, orientation), order: null }]))
  const { anchors } = data
  const free = ports.filter((p) => !anchors[p.id])
  const [top, bottom, left, right] = SIDES.map((side) => portsOn(free, placements, side)) as [
    P[],
    P[],
    P[],
    P[]
  ]
  const portsKey = [
    ...[top, bottom, left, right].map((list) => list.map((p) => `${p.id}:${p.role}`).join(',')),
    ...Object.entries(anchors).map(([p, a]) => `${p}:${a.side}:${a.at}`)
  ].join('|')
  useEffect(() => updateInternals(nodeId), [nodeId, portsKey, updateInternals])
  return { floating: !!data.sides, anchors, top, bottom, left, right }
}
