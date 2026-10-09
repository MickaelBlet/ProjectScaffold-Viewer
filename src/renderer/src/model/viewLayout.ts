// Own layout of drill-down views (module rects, link shapes, port name sides, places of the
// modules outside them): drawing a view, and folding a layout edit made in it back.
import { produce } from 'immer'
import {
  absoluteRect,
  defaultSize,
  findImported,
  growAncestors,
  indexById,
  isolatedModuleId,
  importedSize,
  minSize,
  subtreeIds,
  uniqueName,
  visibleModuleIds
} from './project'
import type { Id, ImportedModule, Link, LinkRoute, Module, Project, Rect, Side, View } from './types'

const drawnCache = new WeakMap<Project, Map<Id, { view: View; drawn: Project }>>()

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** `ports` with the name sides `labelOf` gives: `ports` itself when they are the same. */
function withLabels<T extends { id: Id; label?: Side }>(
  ports: T[],
  labelOf: (pt: T) => Side | undefined
): T[] {
  let changed = false
  const out = ports.map((pt) => {
    const label = labelOf(pt)
    if (label === pt.label) return pt
    changed = true
    const copy = { ...pt, label }
    if (!label) delete copy.label
    return copy
  })
  return changed ? out : ports
}

/** `l` with `route`: `l` itself when it has it already. */
function withRoute(l: Link, route: LinkRoute | undefined): Link {
  if (route === l.route) return l
  const out = { ...l, route }
  if (!route) delete out.route
  return out
}

/** Whether `a` and `b` have the same fields but `key`. */
function sameBut<T extends object>(key: keyof T, a: T, b: T): boolean {
  const keys = (Object.keys(b) as (keyof T)[]).filter((k) => k !== key)
  return keys.length === Object.keys(a).filter((k) => k !== key).length && keys.every((k) => a[k] === b[k])
}

/**
 * `before` with the fields of `m` other than its rect and port name sides: `before` itself when
 * they are the same.
 */
function withLayoutOf(before: Module, m: Module): Module {
  const was = indexById(before.ports)
  const ports = m.ports.map((pt) => {
    const b = was.get(pt.id)
    return b && sameBut('label', b, pt) ? b : withLabels([pt], () => b?.label)[0]!
  })
  const samePorts = ports.length === before.ports.length && ports.every((pt, i) => pt === before.ports[i])
  const keys = Object.keys(m) as (keyof Module)[]
  const same =
    samePorts &&
    keys.length === Object.keys(before).length &&
    keys.every((k) => k === 'layout' || k === 'ports' || m[k] === before[k])
  return same ? before : { ...m, layout: before.layout, ports: samePorts ? before.ports : ports }
}

/** Modules outside a drill-down view drawn in it (see inView), by drawn project. */
const outsideRegistry = new WeakMap<Project, ReadonlySet<Id>>()
const NONE: ReadonlySet<Id> = new Set()

/** Modules (and placed modules of dependencies) a drawn drill-down view shows outside its root. */
export function outsideOf(p: Project): ReadonlySet<Id> {
  return outsideRegistry.get(p) ?? NONE
}

/** Modules a view draws: its visible modules and the modules outside it linked to them. */
export function shownModuleIds(drawn: Project, view: View): Set<Id> {
  return new Set([...visibleModuleIds(drawn, view), ...outsideOf(drawn)])
}

/** Free space between the root of a drill-down view and the modules outside it. */
const OUTSIDE_GAP = 80
/** Space between two modules outside a drill-down view. */
const OUTSIDE_SPACING = 20

interface Outside {
  id: Id
  /** Its ports linked to the view. */
  ports: Set<Id>
  /** Only sends to the view: drawn on its in side. */
  sender: boolean
  /** Modules of the view it is linked to. */
  partners: Id[]
}

/** Modules outside a view linked to its visible modules. */
function outsideModules(p: Project, visible: Set<Id>): Outside[] {
  const out = new Map<Id, Outside>()
  const add = (moduleId: Id, portId: Id, sender: boolean, partner: Id): void => {
    if (!p.modules.some((m) => m.id === moduleId) && !findImported(p, moduleId)) return
    const o = out.get(moduleId) ?? { id: moduleId, ports: new Set(), sender: true, partners: [] }
    o.ports.add(portId)
    o.sender &&= sender
    o.partners.push(partner)
    out.set(moduleId, o)
  }
  for (const l of p.links) {
    const fromIn = visible.has(l.from.moduleId)
    const toIn = visible.has(l.to.moduleId)
    if (fromIn && !toIn) add(l.to.moduleId, l.to.portId, false, l.from.moduleId)
    if (!fromIn && toIn) add(l.from.moduleId, l.from.portId, true, l.to.moduleId)
  }
  return [...out.values()]
}

/**
 * Default rects of the modules outside a drill-down view: senders lined up on its in side (left,
 * or above), receivers on its out side, in the order of the modules they link to.
 */
function outsidePlaces(
  p: Project,
  root: Rect,
  outside: { o: Outside; size: { width: number; height: number } }[]
): Map<Id, Rect> {
  const vertical = p.orientation === 'vertical'
  const center = (id: Id): number => {
    const r = absoluteRect(p, id)
    return vertical ? r.x + r.width / 2 : r.y + r.height / 2
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  const sorted = [...outside].sort((a, b) => mean(a.o.partners.map(center)) - mean(b.o.partners.map(center)))
  const out = new Map<Id, Rect>()
  let before = vertical ? root.x : root.y
  let after = before
  for (const { o, size } of sorted) {
    const { width, height } = size
    const along = o.sender ? before : after
    if (o.sender) before += (vertical ? width : height) + OUTSIDE_SPACING
    else after += (vertical ? width : height) + OUTSIDE_SPACING
    const at = vertical
      ? { x: along, y: o.sender ? root.y - height - OUTSIDE_GAP : root.y + root.height + OUTSIDE_GAP }
      : { x: o.sender ? root.x - width - OUTSIDE_GAP : root.x + root.width + OUTSIDE_GAP, y: along }
    out.set(o.id, { ...at, width, height })
  }
  return out
}

type Place = NonNullable<View['standIns']>[Id]

/** A stored place of a module outside a view, its size at least `min`. */
const placeOf = (own: Place, min: { width: number; height: number }): Rect => ({
  x: own.x,
  y: own.y,
  width: Math.max(min.width, own.width ?? min.width),
  height: Math.max(min.height, own.height ?? min.height)
})

/**
 * The project as a view draws it. A drill-down view draws its root at the top level (drawn
 * coordinates are those of the canvas), its modules at its own rects (else at their layout),
 * and only its own link shapes and port name sides. The modules outside it linked to its
 * content are drawn too, at the top level and compact (their linked ports, no compartments), at
 * their place in the view or lined up along the root (see outsideOf).
 */
export function inView(p: Project, view: View): Project {
  if (!view.rootModuleId) return p
  let byView = drawnCache.get(p)
  if (!byView) drawnCache.set(p, (byView = new Map<Id, { view: View; drawn: Project }>()))
  // By id: temporary views are built anew on each lookup.
  const cached = byView.get(view.id)
  if (cached && (cached.view === view || view.temporary)) return cached.drawn
  const rootId = view.rootModuleId
  const inside = subtreeIds(p, rootId)
  const rects = view.layouts ?? {}
  const labels = view.portLabels ?? {}
  const routes = view.routes ?? {}
  const modules = p.modules.map((m) => {
    const r = inside.has(m.id) ? rects[m.id] : undefined
    const ports = withLabels(m.ports, (pt) => labels[pt.id])
    const top = m.id === rootId && m.parentId
    if (!r && ports === m.ports && !top) return m
    return { ...m, ...(r && { layout: r }), ports, ...(top && { parentId: null }) }
  })
  const links = p.links.map((l) => withRoute(l, routes[l.id]))
  const drawn: Project = { ...p, modules, links }
  // Modules outside, linked to the content.
  const outside = outsideModules(drawn, visibleModuleIds(drawn, view)).filter(
    (o) => !view.hidden.includes(o.id)
  )
  const compact = new Map<Id, Module | ImportedModule>()
  for (const o of outside) {
    const m = drawn.modules.find((x) => x.id === o.id)
    if (m)
      compact.set(o.id, {
        ...m,
        parentId: null,
        attributes: [],
        methods: [],
        ports: m.ports.filter((pt) => o.ports.has(pt.id))
      })
    const im = findImported(drawn, o.id)?.module
    if (im)
      compact.set(o.id, {
        ...im,
        ports: withLabels(
          im.ports.filter((pt) => o.ports.has(pt.id)),
          (pt) => labels[pt.id]
        )
      })
  }
  const sizes = outside.map((o) => ({ o, size: defaultSize(compact.get(o.id)!, p.orientation) }))
  const root = drawn.modules.find((m) => m.id === rootId)!
  const places = outsidePlaces(
    drawn,
    root.layout,
    sizes.filter(({ o }) => !view.standIns?.[o.id])
  )
  for (const { o } of sizes) {
    const own = view.standIns?.[o.id]
    const r = own ? placeOf(own, minSize(compact.get(o.id)!, p.orientation)) : places.get(o.id)!
    const c = compact.get(o.id)!
    if ('layout' in c) c.layout = r
    else {
      c.position = { x: r.x, y: r.y }
      c.size = { width: r.width, height: r.height }
    }
  }
  drawn.modules = modules.map((m) => (compact.get(m.id) as Module | undefined) ?? m)
  if (outside.some((o) => findImported(drawn, o.id)))
    drawn.dependencies = drawn.dependencies.map((dep) =>
      dep.modules.some((im) => compact.has(im.id))
        ? {
            ...dep,
            modules: dep.modules.map((im) => (compact.get(im.id) as ImportedModule | undefined) ?? im)
          }
        : dep
    )
  outsideRegistry.set(drawn, new Set(outside.map((o) => o.id)))
  byView.set(view.id, { view, drawn })
  return drawn
}

/** Whether a view has a layout of its own to reset: module rects, link shapes, port name sides or stand-in places. */
export function hasOwnLayout(view: View): boolean {
  return !!(view.layouts || view.routes || view.portLabels || view.standIns)
}

/** Store a temporary view of the module `rootId` under `viewId`, unless stored already. */
export function storeView(d: Project, viewId: Id, rootId: Id): View | undefined {
  const stored = d.views.find((v) => v.id === viewId)
  if (stored) return stored
  const root = d.modules.find((m) => m.id === rootId)
  if (!root) return undefined
  const name = uniqueName(
    root.name,
    d.views.map((v) => v.name)
  )
  d.views.push({ id: viewId, name, rootModuleId: rootId, hidden: [] })
  return d.views[d.views.length - 1]
}

const orUndefined = <T>(o: Record<Id, T>): Record<Id, T> | undefined =>
  Object.keys(o).length ? o : undefined

/**
 * Fold an edit of `base` (`inView(prev, view)`), giving `next`, back into the project: the rects,
 * link shapes and port name sides the edit gives become the view's own, the project keeps its
 * own. New modules, and modules moved to another parent, take their rect in the view as their
 * layout. A temporary view gets stored (also when it has notes).
 */
export function foldLayouts(prev: Project, base: Project, next: Project, viewId: Id): Project {
  const stored = next.views.find((v) => v.id === viewId)
  const rootId = stored ? stored.rootModuleId : isolatedModuleId(viewId)
  if (!rootId || !next.modules.some((m) => m.id === rootId)) return next
  const was = indexById(prev.modules)
  const drawn = indexById(base.modules)
  const inside = subtreeIds(next, rootId)
  const own: Record<Id, Rect> = { ...stored?.layouts }
  const ownLabels: Record<Id, Side> = { ...stored?.portLabels }
  const ownRoutes: Record<Id, LinkRoute> = { ...stored?.routes }
  const ownPlaces: Record<Id, Place> = { ...stored?.standIns }
  const outside = outsideOf(base)
  /** Port name sides set in the view are its own. */
  const keepLabels = (
    ports: { id: Id; label?: Side }[],
    shownPorts: { id: Id; label?: Side }[] | undefined
  ) => {
    const drawnPorts = indexById(shownPorts ?? [])
    for (const pt of ports) {
      if (shownPorts && pt.label === drawnPorts.get(pt.id)?.label) continue
      if (pt.label) ownLabels[pt.id] = pt.label
      else delete ownLabels[pt.id]
    }
  }
  const placed: Id[] = []
  const modules = next.modules.map((edited) => {
    const before = was.get(edited.id)
    const shown = drawn.get(edited.id)
    if (before && shown === edited) return before
    keepLabels(edited.ports, shown?.ports)
    // Modules outside: their rect is their place in the view, the module stays as it is.
    if (before && outside.has(edited.id)) {
      if (!shown || !sameRect(edited.layout, shown.layout)) ownPlaces[edited.id] = { ...edited.layout }
      return before
    }
    // The root, drawn at the top level, keeps its parent.
    const m =
      before && shown && shown.parentId !== before.parentId && edited.parentId === shown.parentId
        ? { ...edited, parentId: before.parentId }
        : edited
    if (!before || before.parentId !== m.parentId) {
      delete own[m.id]
      placed.push(m.id)
      const ports = before ? withLayoutOf(before, m).ports : withLabels(m.ports, () => undefined)
      return ports === m.ports ? m : { ...m, ports }
    }
    if (inside.has(m.id)) {
      if (sameRect(m.layout, before.layout)) delete own[m.id]
      else own[m.id] = m.layout
    }
    return withLayoutOf(before, m)
  })
  // Link shapes set in the view are its own; the project keeps its own.
  const prevLinks = indexById(prev.links)
  const drawnLinks = indexById(base.links)
  const links = next.links.map((l) => {
    const shown = drawnLinks.get(l.id)
    if (shown === l) return prevLinks.get(l.id) ?? l
    if (!shown || l.route !== shown.route) {
      if (l.route) ownRoutes[l.id] = l.route
      else delete ownRoutes[l.id]
    }
    const before = prevLinks.get(l.id)
    return before && sameBut('route', before, l) ? before : withRoute(l, before?.route)
  })
  // Placed modules of dependencies outside: the same, on their position and size.
  const dependencies =
    next.dependencies === base.dependencies
      ? prev.dependencies
      : next.dependencies.map((dep) => {
          const prevDep = prev.dependencies.find((x) => x.id === dep.id)
          if (!prevDep) return dep
          const outsideMoved = dep.modules.map((im) => {
            const before = prevDep.modules.find((x) => x.id === im.id)
            if (!before || !outside.has(im.id)) return im
            const shown = findImported(base, im.id)?.module
            if (shown === im) return before
            keepLabels(im.ports, shown?.ports)
            const r = { ...im.position, ...importedSize(im, next.orientation) }
            const was = shown && { ...shown.position, ...importedSize(shown, next.orientation) }
            if (!was || !sameRect(r, was)) ownPlaces[im.id] = r
            return before
          })
          return outsideMoved.every((im, i) => im === prevDep.modules[i]) &&
            outsideMoved.length === prevDep.modules.length
            ? prevDep
            : { ...dep, modules: outsideMoved }
        })
  const layouts = orUndefined(own)
  const portLabels = orUndefined(ownLabels)
  const routes = orUndefined(ownRoutes)
  const standIns = orUndefined(ownPlaces)
  const notes = next.notes.some((n) => n.viewId === viewId)
  const folded = produce(next, (d) => {
    d.modules = modules
    d.links = links
    d.dependencies = dependencies
    const view =
      layouts || portLabels || routes || standIns || notes
        ? storeView(d, viewId, rootId)
        : d.views.find((v) => v.id === viewId)
    if (!view) return
    for (const [key, value] of [
      ['layouts', layouts],
      ['portLabels', portLabels],
      ['routes', routes],
      ['standIns', standIns]
    ] as const) {
      if (value) Object.assign(view, { [key]: value })
      else delete view[key]
    }
  })
  // Their parents grow to hold the modules placed from the view.
  return placed.length ? produce(folded, (d) => placed.forEach((id) => growAncestors(d, id))) : folded
}
