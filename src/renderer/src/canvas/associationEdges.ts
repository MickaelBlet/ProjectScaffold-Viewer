// Association edges of a view: from a module to each module its attributes reference (see
// AssociationEdge), as UML compositions (owned), aggregations (shared) or plain associations.
import type { Edge } from '@xyflow/react'
import { multiplicity } from '@/model/constraints'
import { attributeTargets } from '@/model/project'
import type { Id, Ownership, Project } from '@/model/types'
import { MODULE_HANDLE, Z } from './constants'

/** Data of an association edge, from a module (source) to a module an attribute references. */
export type AssociationEdgeData = {
  attributeId: Id
  ownership?: Ownership
  /** Sideways offset apart from the other association lines between the same modules. */
  spread: number
  /** Goes from the module with the greater id, against the order `spread` is given in. */
  flip: boolean
  /** Attribute name and multiplicity, at the referenced module. */
  label: string
}

/** Id prefix of the association edges. */
export const ASSOCIATION = 'association:'

/** Distance between association lines drawn between the same modules. */
const SPREAD = 22

/** Association edges between visible modules, one per attribute and module it references. */
export function associationEdges(p: Project, visible: Set<Id>): Edge<AssociationEdgeData>[] {
  const edges = p.modules.flatMap((m) =>
    visible.has(m.id)
      ? m.attributes.flatMap((a) => {
          const targets = attributeTargets(p, a).filter((t) => t !== m.id && visible.has(t))
          return targets.map((target): Edge<AssociationEdgeData> => ({
            id: `${ASSOCIATION}${m.id}>${a.id}>${target}`,
            type: 'association',
            source: m.id,
            sourceHandle: MODULE_HANDLE,
            target,
            targetHandle: MODULE_HANDLE,
            selectable: false,
            focusable: false,
            zIndex: Z.link,
            data: {
              attributeId: a.id,
              ...(a.ownership && { ownership: a.ownership }),
              spread: 0,
              flip: m.id > target,
              label: `${a.name} [${multiplicity(a.type)}]`
            }
          }))
        })
      : []
  )
  // Lines between the same modules, either way, side by side.
  const pairs = new Map<string, Edge<AssociationEdgeData>[]>()
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}>${e.target}` : `${e.target}>${e.source}`
    const list = pairs.get(key)
    if (list) list.push(e)
    else pairs.set(key, [e])
  }
  for (const list of pairs.values())
    if (list.length > 1)
      for (const [i, e] of list.entries()) e.data!.spread = (i - (list.length - 1) / 2) * SPREAD
  return edges
}
