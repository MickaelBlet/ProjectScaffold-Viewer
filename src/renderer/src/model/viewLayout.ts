// Own module rects of drill-down views: drawing a view, and folding a layout edit made in it back.
import { produce } from 'immer'
import { growAncestors, indexById, isolatedModuleId, subtreeIds, uniqueName } from './project'
import type { Id, Module, Project, Rect, View } from './types'

const drawnCache = new WeakMap<Project, WeakMap<View, Project>>()

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** `before` with the fields of `m` other than its rect: `before` itself when they are the same. */
function withLayoutOf(before: Module, m: Module): Module {
  const keys = Object.keys(m) as (keyof Module)[]
  const same =
    keys.length === Object.keys(before).length && keys.every((k) => k === 'layout' || m[k] === before[k])
  return same ? before : { ...m, layout: before.layout }
}

/** The project as a view draws it: the modules of a drill-down view at the view's own rects. */
export function inView(p: Project, view: View): Project {
  const own = view.rootModuleId ? view.layouts : undefined
  if (!own || !Object.keys(own).length) return p
  let byView = drawnCache.get(p)
  if (!byView) drawnCache.set(p, (byView = new WeakMap()))
  let drawn = byView.get(view)
  if (!drawn) {
    const inside = subtreeIds(p, view.rootModuleId!)
    const modules = p.modules.map((m) => {
      const r = inside.has(m.id) ? own[m.id] : undefined
      return r ? { ...m, layout: r } : m
    })
    byView.set(view, (drawn = { ...p, modules }))
  }
  return drawn
}

/**
 * Fold an edit of `base` (`inView(prev, view)`), giving `next`, back into the project: the rects the
 * edit gives the modules of a drill-down view become the view's own, the modules keep their layout,
 * other modules and the links' bends stay as they were. New modules, and modules moved to another
 * parent, take their rect in the view as their layout. A temporary view gets stored.
 */
export function foldLayouts(prev: Project, base: Project, next: Project, viewId: Id): Project {
  const stored = next.views.find((v) => v.id === viewId)
  const rootId = stored ? stored.rootModuleId : isolatedModuleId(viewId)
  if (!rootId || !next.modules.some((m) => m.id === rootId)) return next
  const was = indexById(prev.modules)
  const drawn = indexById(base.modules)
  const inside = subtreeIds(next, rootId)
  const own: Record<Id, Rect> = { ...stored?.layouts }
  const placed: Id[] = []
  const modules = next.modules.map((m) => {
    const before = was.get(m.id)
    if (before && drawn.get(m.id) === m) return before
    if (!before || before.parentId !== m.parentId) {
      delete own[m.id]
      placed.push(m.id)
      return m
    }
    if (inside.has(m.id)) {
      if (sameRect(m.layout, before.layout)) delete own[m.id]
      else own[m.id] = m.layout
    }
    return withLayoutOf(before, m)
  })
  const routes = new Map(prev.links.map((l) => [l.id, l.route]))
  const layouts = Object.keys(own).length ? own : undefined
  const folded = produce(next, (d) => {
    d.modules = modules
    for (const l of d.links) {
      if (!routes.has(l.id)) continue
      const route = routes.get(l.id)
      if (route) l.route = route
      else delete l.route
    }
    const view = d.views.find((v) => v.id === viewId)
    if (view) {
      if (layouts) view.layouts = layouts
      else delete view.layouts
    } else if (layouts) {
      const root = d.modules.find((m) => m.id === rootId)!
      const name = uniqueName(
        root.name,
        d.views.map((v) => v.name)
      )
      d.views.push({ id: viewId, name, rootModuleId: rootId, hidden: [], layouts })
    }
  })
  // Their parents grow to hold the modules placed from the view.
  return placed.length ? produce(folded, (d) => placed.forEach((id) => growAncestors(d, id))) : folded
}
