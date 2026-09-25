import { produce } from 'immer'
import { useStore } from 'zustand'
import {
  childModules,
  defaultConstraints,
  defaultSize,
  globalTypeNames,
  growAncestors,
  LAYOUT_PAD,
  contentTop,
  minSize,
  newId,
  pruneViews,
  subtreeIds,
  typeUsages,
  uniqueName
} from '@/model/project'
import type { Endpoint, Id, Project, Rect, TypeDef } from '@/model/types'
import { activeDoc, useDoc } from './documents'

export { growAncestors }
import type { ProjectState } from './projectStore'

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
  projectStore().setState((s) => ({ project: produce(s.project, fn) }))
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

const PAD = LAYOUT_PAD

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
      metadata: {},
      ports: [],
      layout: { x, y, ...defaultSize({ ports: [] }, d.orientation) }
    })
    growAncestors(d, id)
  })
  return id
}

/** Add a child module below the parent's ports and existing children. */
export function addSubmodule(parentId: Id): Id {
  const p = getProject()
  const parent = p.modules.find((m) => m.id === parentId)
  const top = (parent ? contentTop(parent, p.orientation) : 0) + PAD
  const bottom = Math.max(top, ...childModules(p, parentId).map((c) => c.layout.y + c.layout.height + PAD))
  return addModule(parentId, PAD, bottom)
}

export function deleteModule(id: Id): void {
  update((d) => {
    const ids = subtreeIds(d, id)
    d.modules = d.modules.filter((m) => !ids.has(m.id))
    d.links = d.links.filter((l) => !ids.has(l.from.moduleId) && !ids.has(l.to.moduleId))
    pruneViews(d)
  })
}

/** Delete modules (with their content) and notes in one undo step. */
export function deleteItems(ids: Id[]): void {
  update((d) => {
    const gone = new Set<Id>()
    for (const id of ids)
      if (d.modules.some((m) => m.id === id)) for (const s of subtreeIds(d, id)) gone.add(s)
    d.modules = d.modules.filter((m) => !gone.has(m.id))
    d.links = d.links.filter((l) => !gone.has(l.from.moduleId) && !gone.has(l.to.moduleId))
    d.notes = d.notes.filter((n) => !ids.includes(n.id))
    pruneViews(d)
  })
}

/** Set several module and note rects in one undo step. */
export function setLayouts(layouts: Map<Id, Partial<Rect>>): void {
  update((d) => {
    for (const [id, r] of layouts) {
      const m = d.modules.find((m) => m.id === id)
      if (m) Object.assign(m.layout, r)
      const n = d.notes.find((n) => n.id === id)
      if (n) Object.assign(n.layout, r)
    }
    for (const id of layouts.keys()) growAncestors(d, id)
  })
}

export function setModuleLayout(id: Id, layout: Partial<Rect>): void {
  update((d) => {
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
    m.name = uniqueName(m.name, taken)
    m.parentId = parentId
    m.layout.x = x
    m.layout.y = y
    growAncestors(d, id)
    // Parents must precede children for the canvas.
    const moved = subtreeIds(d, id)
    d.modules = [...d.modules.filter((o) => !moved.has(o.id)), ...d.modules.filter((o) => moved.has(o.id))]
  })
}

// Ports

export function addPort(moduleId: Id, role: 'in' | 'out'): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === moduleId)
    if (!m) return
    const name = uniqueName(
      role,
      m.ports.map((p) => p.name)
    )
    m.ports.push({ id: newId(), name, role, interfaceId: null, description: '' })
    const min = minSize(m, d.orientation)
    m.layout.width = Math.max(m.layout.width, min.width)
    m.layout.height = Math.max(m.layout.height, min.height)
    growAncestors(d, moduleId)
  })
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
  update((d) => {
    const a = d.modules.find((m) => m.id === from.moduleId)?.name ?? 'a'
    const b = d.modules.find((m) => m.id === to.moduleId)?.name ?? 'b'
    const name = uniqueName(
      `${a}_to_${b}`,
      d.links.map((l) => l.name)
    )
    d.links.push({ id, name, description: '', from, to, constraints: defaultConstraints() })
  })
  return id
}

export function deleteLink(id: Id): void {
  update((d) => {
    d.links = d.links.filter((l) => l.id !== id)
  })
}

// Types & interfaces

export function addType(kind: TypeDef['kind']): Id {
  const id = newId()
  update((d) => {
    const base = {
      id,
      description: '',
      name: uniqueName(kind === 'struct' ? 'Struct' : kind === 'enum' ? 'Enum' : 'Alias', globalTypeNames(d))
    }
    if (kind === 'struct') d.types.push({ ...base, kind, fields: [] })
    else if (kind === 'enum') d.types.push({ ...base, kind, underlying: 'uint8', values: [] })
    else d.types.push({ ...base, kind, type: { kind: 'primitive', name: 'uint32' } })
  })
  return id
}

/** Returns the usages that prevent deletion, or an empty list once deleted. */
export function deleteType(id: Id): string[] {
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

export function deleteInterface(id: Id): void {
  update((d) => {
    d.interfaces = d.interfaces.filter((i) => i.id !== id)
    for (const m of d.modules) for (const p of m.ports) if (p.interfaceId === id) p.interfaceId = null
  })
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
  })
}
