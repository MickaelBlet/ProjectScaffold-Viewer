// Association edges of a view: from a module to each module its attributes reference (see
// AssociationEdge), as UML compositions (owned), aggregations (shared) or plain associations.
import type { Edge } from '@xyflow/react'
import { multiplicity } from '@/model/constraints'
import { parseDependencyModuleRef } from '@/model/project'
import { walkTypeRef } from '@/model/typeExpr'
import type { Id, Ownership, Project } from '@/model/types'
import { MODULE_HANDLE, Z } from './constants'

/** Data of an association edge, from a module (source) to a module an attribute references. */
export type AssociationEdgeData = {
  ownership?: Ownership
  /** Attribute name and multiplicity, at the referenced module. */
  label: string
}

/** Id prefix of the association edges. */
export const ASSOCIATION = 'association:'

/** Association edges between visible modules, one per attribute and module it references. */
export function associationEdges(p: Project, visible: Set<Id>): Edge<AssociationEdgeData>[] {
  const modules = new Set(p.modules.map((m) => m.id))
  /** The node of a referenced module: its own, or the placed module of a dependency. */
  const nodeOf = (id: Id): Id | undefined => {
    if (modules.has(id)) return id
    const of = parseDependencyModuleRef(id)
    return (
      of && p.dependencies.find((d) => d.id === of.dependency)?.modules.find((m) => m.path === of.path)?.id
    )
  }
  return p.modules.flatMap((m) =>
    visible.has(m.id)
      ? m.attributes.flatMap((a) => {
          const targets: Id[] = []
          walkTypeRef(a.type, (n) => {
            const target = n.kind === 'ref' ? nodeOf(n.id) : undefined
            if (target && target !== m.id && visible.has(target) && !targets.includes(target))
              targets.push(target)
          })
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
              ...(a.ownership && { ownership: a.ownership }),
              label: `${a.name} [${multiplicity(a.type)}]`
            }
          }))
        })
      : []
  )
}
