// Module tree of the Explorer: modules by parent, filtering, hiding in the focused view, drag to re-parent.
import { absolutePosition, belowContent, LAYOUT_PAD, modulePaths, subtreeIds } from '@/model/project'
import type { Id, Module, Project } from '@/model/types'
import { activeDoc } from '@/store/documents'
import { getProject, reparentModule, setHidden } from '@/store/project'
import { quickPick } from '@/store/ui'
import { storedViewFor } from '@/actions'

/** Data type of a module dragged in the tree. */
export const MODULE_DRAG = 'application/x-module'

/** Modules by parent (null: top level), in project order. */
export function childrenByParent(modules: Module[]): Map<Id | null, Module[]> {
  const map = new Map<Id | null, Module[]>()
  for (const m of modules) map.set(m.parentId, [...(map.get(m.parentId) ?? []), m])
  return map
}

/** Modules passing `test`, with their ancestors. */
export function matching(children: Map<Id | null, Module[]>, test: (m: Module) => boolean): Set<Id> {
  const shown = new Set<Id>()
  const visit = (m: Module): boolean => {
    const inside = (children.get(m.id) ?? []).map(visit).some(Boolean)
    const match = inside || test(m)
    if (match) shown.add(m.id)
    return match
  }
  for (const m of children.get(null) ?? []) visit(m)
  return shown
}

/** Hide or show a module in the focused view (stored first: see storedViewFor). */
export function toggleHidden(id: Id, hidden: boolean): void {
  setHidden(storedViewFor(activeDoc().activeViewId), [id], !hidden)
}

function canDrop(p: Project, dragged: Id, target: Id | null): boolean {
  return dragged !== target && !(target && subtreeIds(p, dragged).has(target))
}

/** Move a dragged module into `parentId` (null: top level), below the existing content. */
export function dropModule(id: Id, parentId: Id | null): void {
  const p = getProject()
  if (!id || !canDrop(p, id, parentId)) return
  const pos = parentId ? { x: LAYOUT_PAD, y: belowContent(p, parentId, id) } : absolutePosition(p, id)
  reparentModule(id, parentId, pos.x, pos.y)
}

/** Pick the module to move a module into (or the top level): drag and drop without a pointer. */
export function pickNewParent(id: Id): void {
  const p = getProject()
  const m = p.modules.find((x) => x.id === id)
  if (!m) return
  const paths = modulePaths(p)
  const targets = p.modules.filter((x) => x.id !== m.parentId && canDrop(p, id, x.id))
  quickPick(`Move ${paths.get(id) ?? m.name} to`, [
    ...(m.parentId ? [{ key: '', label: 'Top level', kind: '', run: () => dropModule(id, null) }] : []),
    ...targets.map((x) => ({
      key: x.id,
      label: paths.get(x.id) ?? x.name,
      kind: 'M',
      run: () => dropModule(id, x.id)
    }))
  ])
}
