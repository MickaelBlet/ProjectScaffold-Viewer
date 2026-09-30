import { produce } from 'immer'
import { useStore } from 'zustand'
import {
  belowContent,
  childModules,
  defaultConstraints,
  defaultSize,
  globalTypeNames,
  findImported,
  findPort,
  growAncestors,
  LAYOUT_PAD,
  linkOrigin,
  linkRoles,
  minSize,
  newId,
  nextModuleColor,
  pruneViews,
  subtreeIds,
  typeUsages,
  uniqueName
} from '@/model/project'
import {
  addDependency,
  dependencyOf,
  detachDependency,
  followInterfaceRenames,
  placeModule,
  refreshDependencies,
  removeDependency,
  removePlaced,
  type DependencyResult
} from '@/model/dependencies'
import { snapChanges } from '@/model/grid'
import { binarySnapshot, settleBinaries } from '@/model/binaries'
import type {
  Endpoint,
  Id,
  ImportedModule,
  LinkRoute,
  PortRole,
  Project,
  Rect,
  Side,
  TypeDef
} from '@/model/types'
import { activeDoc, useDoc } from './documents'
import type { ProjectState } from './projectStore'
import { useSettings } from './settings'

// The functions below act on the active document; each document keeps its own undo history.

/** Select from the active document's project. */
export function useProjectStore<T>(selector: (s: ProjectState) => T): T {
  const store = useDoc((d) => d.store)
  return useStore(store, selector)
}

const projectStore = () => activeDoc().store
export const history = () => projectStore().temporal.getState()
export const getProject = (): Project => projectStore().getState().project

export function update(fn: (draft: Project) => void): void {
  projectStore().setState((s) => {
    const project = produce(s.project, (d) => {
      fn(d)
      // Placed ports reference interfaces by name.
      followInterfaceRenames(s.project, d)
    })
    // Whatever an edit moves or resizes lands on the grid.
    const { snapToGrid, gridSize } = useSettings.getState()
    return { project: snapToGrid ? snapChanges(s.project, project, gridSize) : project }
  })
}

export function replaceProject(project: Project): void {
  projectStore().setState({ project })
  history().clear()
}

export function undo(): void {
  history().undo()
}

export function redo(): void {
  history().redo()
}

// Modules

export function addModule(parentId: Id | null, x: number, y: number): Id {
  const id = newId()
  update((d) => {
    const name = uniqueName(
      'Module',
      childModules(d, parentId).map((m) => m.name)
    )
    d.modules.push({
      id,
      name,
      description: '',
      parentId,
      color: nextModuleColor(d),
      metadata: {},
      attributes: [],
      methods: [],
      ports: [],
      layout: { x, y, ...defaultSize({ ports: [] }, d.orientation) }
    })
    growAncestors(d, id)
  })
  return id
}

/** Add a child module below the parent's ports and existing children. */
export function addSubmodule(parentId: Id): Id {
  return addModule(parentId, LAYOUT_PAD, belowContent(getProject(), parentId))
}

/** Delete modules (with their content), imported modules and notes in one undo step. */
export function deleteItems(ids: Id[]): void {
  update((d) => {
    removePlaced(d, new Set(ids))
    const gone = new Set<Id>()
    for (const id of ids)
      if (d.modules.some((m) => m.id === id)) for (const s of subtreeIds(d, id)) gone.add(s)
    d.modules = d.modules.filter((m) => !gone.has(m.id))
    for (const m of d.modules)
      if (m.bases?.some((b) => gone.has(b))) {
        m.bases = m.bases.filter((b) => !gone.has(b))
        if (!m.bases.length) delete m.bases
      }
    d.links = d.links.filter((l) => !gone.has(l.from.moduleId) && !gone.has(l.to.moduleId))
    d.notes = d.notes.filter((n) => !ids.includes(n.id))
    pruneViews(d)
  })
}

/** Set several module and note rects in one undo step. */
export function setLayouts(layouts: Map<Id, Partial<Rect>>): void {
  update((d) => {
    shiftBends(d, layouts)
    for (const [id, r] of layouts) {
      const m = d.modules.find((m) => m.id === id)
      if (m) Object.assign(m.layout, r)
      const n = d.notes.find((n) => n.id === id)
      if (n) Object.assign(n.layout, r)
      const im = findImported(d, id)?.module
      if (im) setImportedRect(im, r)
    }
    for (const id of layouts.keys()) growAncestors(d, id)
  })
}

/** Move or resize a placed module of a dependency. */
function setImportedRect(im: ImportedModule, r: Partial<Rect>): void {
  im.position = { x: r.x ?? im.position.x, y: r.y ?? im.position.y }
  if (r.width !== undefined || r.height !== undefined)
    im.size = { width: r.width ?? im.size?.width ?? 0, height: r.height ?? im.size?.height ?? 0 }
}

/** Bend points of the links whose both ends move by the same offset, outside a moving module, move with them. */
function shiftBends(d: Project, layouts: Map<Id, Partial<Rect>>): void {
  const offset = new Map<Id, { x: number; y: number }>()
  for (const [id, r] of layouts) {
    const at = d.modules.find((m) => m.id === id)?.layout ?? findImported(d, id)?.module.position
    if (at) offset.set(id, { x: (r.x ?? at.x) - at.x, y: (r.y ?? at.y) - at.y })
  }
  /** Offset of a module moved with itself or an ancestor. */
  const moved = (id: Id | null): { x: number; y: number } | undefined => {
    for (let cur = id; cur; cur = d.modules.find((m) => m.id === cur)?.parentId ?? null) {
      const o = offset.get(cur)
      if (o) return o
    }
    return undefined
  }
  for (const l of d.links) {
    if (!l.route?.points.length || moved(linkOrigin(d, l))) continue
    const a = moved(l.from.moduleId)
    const b = moved(l.to.moduleId)
    if (!a || !b || a.x !== b.x || a.y !== b.y) continue
    for (const pt of l.route.points) {
      pt.x += a.x
      pt.y += a.y
    }
  }
}

export function setModuleLayout(id: Id, layout: Partial<Rect>): void {
  update((d) => {
    const im = findImported(d, id)?.module
    if (im) return setImportedRect(im, layout)
    const m = d.modules.find((m) => m.id === id)
    if (!m) return
    Object.assign(m.layout, layout)
    growAncestors(d, id)
  })
}

/** Move a module under a new parent, renaming it if the name is taken there. */
export function reparentModule(id: Id, parentId: Id | null, x: number, y: number): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === id)
    if (!m || m.parentId === parentId) return
    if (parentId && subtreeIds(d, id).has(parentId)) return
    const taken = childModules(d, parentId)
      .filter((s) => s.id !== id)
      .map((s) => s.name)
    const before = binarySnapshot(d)
    m.name = uniqueName(m.name, taken)
    m.parentId = parentId
    m.layout.x = x
    m.layout.y = y
    growAncestors(d, id)
    // Parents must precede children for the canvas.
    const moved = subtreeIds(d, id)
    d.modules = [...d.modules.filter((o) => !moved.has(o.id)), ...d.modules.filter((o) => moved.has(o.id))]
    settleBinaries(d, before)
  })
}

// Ports

export function addPort(moduleId: Id, role: PortRole): void {
  update((d) => void pushPort(d, moduleId, role, null))
}

/** New port on a module, which grows to fit it; returns its id (null if the module is gone). */
function pushPort(d: Project, moduleId: Id, role: PortRole, interfaceId: Id | null): Id | null {
  const m = d.modules.find((m) => m.id === moduleId)
  if (!m) return null
  const id = newId()
  const name = uniqueName(
    role,
    m.ports.map((p) => p.name)
  )
  m.ports.push({ id, name, role, interfaceId, description: '' })
  const min = minSize(m, d.orientation)
  m.layout.width = Math.max(m.layout.width, min.width)
  m.layout.height = Math.max(m.layout.height, min.height)
  growAncestors(d, moduleId)
  return id
}

export function deletePort(moduleId: Id, portId: Id): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === moduleId)
    if (!m) return
    m.ports = m.ports.filter((p) => p.id !== portId)
    d.links = d.links.filter((l) => l.from.portId !== portId && l.to.portId !== portId)
  })
}

// Links

export function addLink(from: Endpoint, to: Endpoint): Id {
  const id = newId()
  update((d) => pushLink(d, id, from, to))
  return id
}

/** Link end: a port, or a module that gets a new port for the link (null `portId`). */
export interface LinkEnd {
  moduleId: Id
  portId: Id | null
}

/**
 * Link two ends, adding the missing ports (`out` at `from`, `in` at `to`) and propagating the
 * interface to an untyped end; returns the link id (null if a module is gone).
 */
export function connect(from: LinkEnd, to: LinkEnd): Id | null {
  let id: Id | null = null
  update((d) => {
    const iface = (e: LinkEnd): Id | null =>
      (e.portId && findPort(d, e.moduleId, e.portId)?.interfaceId) || null
    const shared = iface(from) ?? iface(to)
    const [fromRole, toRole] = linkRoles(d, from.moduleId, to.moduleId)
    const fromPort = from.portId ?? pushPort(d, from.moduleId, fromRole, shared)
    const toPort = to.portId ?? pushPort(d, to.moduleId, toRole, shared)
    if (!fromPort || !toPort) return
    const a = findPort(d, from.moduleId, fromPort)
    const b = findPort(d, to.moduleId, toPort)
    if (a && b && !a.interfaceId) a.interfaceId = b.interfaceId
    if (a && b && !b.interfaceId) b.interfaceId = a.interfaceId
    id = newId()
    pushLink(d, id, { moduleId: from.moduleId, portId: fromPort }, { moduleId: to.moduleId, portId: toPort })
  })
  return id
}

function pushLink(d: Project, id: Id, from: Endpoint, to: Endpoint): void {
  const moduleName = (e: Endpoint): string | undefined =>
    d.modules.find((m) => m.id === e.moduleId)?.name ??
    findImported(d, e.moduleId)?.module.path.split('.').pop()
  const a = moduleName(from) ?? 'a'
  const b = moduleName(to) ?? 'b'
  const name = uniqueName(
    `${a}_to_${b}`,
    d.links.map((l) => l.name)
  )
  d.links.push({ id, name, description: '', from, to, constraints: defaultConstraints() })
}

export function deleteLink(id: Id): void {
  update((d) => {
    d.links = d.links.filter((l) => l.id !== id)
  })
}

// Dependencies

/**
 * Place a module of another project (saved as `file`) on the canvas, depending on that project.
 * `self`: this project's file name. Returns the placed module id (null if not found).
 */
export function placeModuleFrom(
  source: Project,
  file: string,
  moduleId: Id,
  position: { x: number; y: number },
  self: string | null
): { id: Id | null; result: DependencyResult } {
  let placed!: { id: Id | null; result: DependencyResult }
  update((d) => void (placed = placeModule(d, source, file, moduleId, position, self)))
  return placed
}

/**
 * Depend on `source` (saved as `file`). `self`: this project's file name. Types and interfaces
 * defined differently here are not taken: they are listed in the conflicts.
 */
export function addDependencyFrom(source: Project, file: string, self: string | null): DependencyResult {
  let result!: DependencyResult
  update((d) => void (result = addDependency(d, source, file, self)))
  return result
}

/** Read dependencies again from their projects (by dependency id). */
export function refreshDependenciesFrom(sources: Map<Id, Project>, self: string | null): DependencyResult {
  let result: DependencyResult = { conflicts: [], detached: [], renamed: [], missing: [] }
  update((d) => void (result = refreshDependencies(d, sources, self)))
  return result
}

/** Rename a dependency, and its mentions in the others' `uses`. */
export function renameDependency(id: Id, name: string): void {
  update((d) => {
    const dep = d.dependencies.find((x) => x.id === id)
    if (!dep) return
    for (const x of d.dependencies) x.uses = x.uses.map((u) => (u === dep.name ? name : u))
    dep.name = name
  })
}

/** Stop depending on a project; returns what prevents it (then nothing changes). */
export function removeDependencyById(id: Id): string[] {
  let blockers: string[] = []
  produce(getProject(), (d) => void (blockers = removeDependency(d, id)))
  if (!blockers.length) update((d) => void removeDependency(d, id))
  return blockers
}

/** Make a dependency's types and interfaces this project's own; returns what prevents it. */
export function detachDependencyById(id: Id): string[] {
  let blockers: string[] = []
  produce(getProject(), (d) => void (blockers = detachDependency(d, id)))
  if (!blockers.length) update((d) => void detachDependency(d, id))
  return blockers
}

// Types & interfaces

export function addType(kind: TypeDef['kind']): Id {
  const id = newId()
  update((d) => {
    const base = {
      id,
      description: '',
      name: uniqueName(kind[0]!.toUpperCase() + kind.slice(1), globalTypeNames(d))
    }
    if (kind === 'struct') d.types.push({ ...base, kind, fields: [] })
    else if (kind === 'enum') d.types.push({ ...base, kind, underlying: 'uint8', values: [] })
    else if (kind === 'alias') d.types.push({ ...base, kind, type: { kind: 'primitive', name: 'uint32' } })
    else d.types.push({ ...base, kind })
  })
  return id
}

/** Returns the usages that prevent deletion, or an empty list once deleted. */
export function deleteType(id: Id): string[] {
  const dep = dependencyOf(getProject(), id)
  if (dep) return [`dependency ${dep.name}, which defines it`]
  const usages = typeUsages(getProject(), id)
  if (usages.length) return usages
  update((d) => {
    d.types = d.types.filter((t) => t.id !== id)
  })
  return []
}

export function addInterface(): Id {
  const id = newId()
  update((d) => {
    d.interfaces.push({
      id,
      name: uniqueName('Interface', globalTypeNames(d)),
      description: '',
      messages: []
    })
  })
  return id
}

/** Returns why the interface cannot be deleted, or an empty list once deleted. */
export function deleteInterface(id: Id): string[] {
  const dep = dependencyOf(getProject(), id)
  if (dep) return [`dependency ${dep.name}, which defines it`]
  update((d) => {
    d.interfaces = d.interfaces.filter((i) => i.id !== id)
    for (const m of d.modules) for (const p of m.ports) if (p.interfaceId === id) p.interfaceId = null
  })
  return []
}

// Views

export function addView(name: string, rootModuleId: Id | null): Id {
  const id = newId()
  update((d) => {
    d.views.push({
      id,
      name: uniqueName(
        name,
        d.views.map((v) => v.name)
      ),
      rootModuleId,
      hidden: []
    })
  })
  return id
}

export function renameView(id: Id, name: string): void {
  update((d) => {
    const v = d.views.find((v) => v.id === id)
    if (v) v.name = name
  })
}

export function deleteView(id: Id): void {
  update((d) => {
    d.views = d.views.filter((v) => v.id !== id)
  })
}

/** Show or hide modules in a stored view. */
export function setHidden(viewId: Id, ids: Id[], hidden: boolean): void {
  update((d) => {
    const v = d.views.find((v) => v.id === viewId)
    if (!v) return
    const set = new Set(v.hidden)
    for (const id of ids) {
      if (hidden) set.add(id)
      else set.delete(id)
    }
    v.hidden = [...set]
  })
}

// Notes

export function addNote(kind: 'note' | 'frame', x: number, y: number): Id {
  const id = newId()
  update((d) => {
    d.notes.push({
      id,
      kind,
      text: kind === 'note' ? 'Note' : 'Group',
      layout: kind === 'note' ? { x, y, width: 180, height: 100 } : { x, y, width: 420, height: 280 }
    })
  })
  return id
}

export function updateNote(id: Id, fn: (n: Project['notes'][number]) => void): void {
  update((d) => {
    const n = d.notes.find((n) => n.id === id)
    if (n) fn(n)
  })
}

/** Lock or unlock the position and size of modules and notes. */
export function setLocked(ids: Id[], locked: boolean): void {
  update((d) => {
    for (const e of [...d.modules, ...d.notes])
      if (ids.includes(e.id)) {
        if (locked) e.locked = true
        else delete e.locked
      }
  })
}

export function setModuleColor(ids: Id[], color: string | undefined): void {
  update((d) => {
    for (const m of d.modules)
      if (ids.includes(m.id)) {
        if (color) m.color = color
        else delete m.color
      }
  })
}

export function reverseLink(id: Id): void {
  update((d) => {
    const l = d.links.find((l) => l.id === id)
    if (!l) return
    ;[l.from, l.to] = [l.to, l.from]
    if (l.route) {
      const { from, to } = l.route
      l.route = { ...clean({ from: to, to: from }), points: l.route.points.reverse() }
    }
  })
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Set or clear (undefined: the default) where a port's name is drawn around its handle. */
export function setPortLabel(moduleId: Id, portId: Id, label: Side | undefined): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === moduleId) ?? findImported(d, moduleId)?.module
    const pt = m?.ports.find((pt) => pt.id === portId)
    if (!pt) return
    if (label) pt.label = label
    else delete pt.label
  })
}

/** Set or clear (undefined, or nothing left) the hand-set shape of a link. */
export function setLinkRoute(id: Id, route: LinkRoute | undefined): void {
  update((d) => {
    const l = d.links.find((l) => l.id === id)
    if (!l) return
    if (route && (route.points.length || route.from || route.to)) l.route = clean(route)
    else delete l.route
  })
}
