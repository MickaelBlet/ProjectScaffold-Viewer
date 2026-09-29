// Inheritance edges of a view: from a module to each of its bases (see InheritEdge).
import type { Edge } from '@xyflow/react'
import { contentTop } from '@/model/project'
import type { Id, Module, Project } from '@/model/types'
import { MODULE_HANDLE, Z } from './constants'

/** Data of an inheritance edge, from a module (source) to one of its bases (target). */
export type InheritEdgeData = {
  /** The base is an interface: drawn dashed, as a UML realization. */
  realization: boolean
  /** One module holds the other: top of its content, where the edge stops below its header. */
  inset?: number
}

/** Id prefix of the inheritance edges, from a module to one of its bases. */
export const INHERIT = 'inherit:'

/** Inheritance edges between visible modules. */
export function inheritEdges(p: Project, visible: Set<Id>): Edge<InheritEdgeData>[] {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  /** Whether `outer` holds `inner`, directly or not. */
  const holds = (outer: Module, inner: Module): boolean => {
    for (let cur = inner.parentId; cur; cur = byId.get(cur)?.parentId ?? null)
      if (cur === outer.id) return true
    return false
  }
  return p.modules.flatMap((m) =>
    visible.has(m.id)
      ? (m.bases ?? []).flatMap((b) => {
          const base = byId.get(b)
          if (!base || b === m.id || !visible.has(b)) return []
          const outer = holds(base, m) ? base : holds(m, base) ? m : null
          const data: InheritEdgeData = {
            realization: base.kind === 'interface',
            ...(outer && { inset: contentTop(p.orientation, outer) })
          }
          return [
            {
              id: `${INHERIT}${m.id}>${b}`,
              type: 'inherit',
              source: m.id,
              sourceHandle: MODULE_HANDLE,
              target: b,
              targetHandle: MODULE_HANDLE,
              selectable: false,
              focusable: false,
              zIndex: Z.link,
              data
            }
          ]
        })
      : []
  )
}
