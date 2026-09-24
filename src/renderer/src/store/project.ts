import { produce } from 'immer'
import { create } from 'zustand'
import { temporal } from 'zundo'
import {
  childModules,
  defaultConstraints,
  defaultLayout,
  emptyProject,
  globalTypeNames,
  leafHeight,
  newId,
  portRows,
  subtreeIds,
  typeUsages,
  uniqueName
} from '@/model/project'
import type { Endpoint, Id, Project, Rect, TypeDef } from '@/model/types'

interface ProjectState {
  project: Project
}

// Consecutive edits closer than this are merged into one undo step (typing, dragging).
const MERGE_MS = 400

export const useProjectStore = create<ProjectState>()(
  temporal(() => ({ project: emptyProject() }), {
    partialize: (s) => ({ project: s.project }),
    equality: (a, b) => a.project === b.project,
    handleSet: (handleSet) => {
      let last = 0
      return (...args) => {
        const now = Date.now()
        // Typed as setState, but zundo passes its internal 4-argument handler.
        if (now - last > MERGE_MS) (handleSet as (...a: typeof args) => void)(...args)
        last = now
      }
    }
  })
)

export const history = () => useProjectStore.temporal.getState()
export const getProject = (): Project => useProjectStore.getState().project

export function update(fn: (draft: Project) => void): void {
  useProjectStore.setState((s) => ({ project: produce(s.project, fn) }))
}

export function replaceProject(project: Project): void {
  useProjectStore.setState({ project })
  history().clear()
}

export function undo(): void {
  history().undo()
}

export function redo(): void {
  history().redo()
}

// Modules

const PAD = 20

/** Keep `id` inside its parent's content area (below header and ports), growing ancestors as needed. */
function growAncestors(d: Project, id: Id): void {
  let child = d.modules.find((m) => m.id === id)
  while (child?.parentId) {
    const parent = d.modules.find((m) => m.id === child!.parentId)
    if (!parent) return
    child.layout.x = Math.max(child.layout.x, PAD / 2)
    child.layout.y = Math.max(child.layout.y, leafHeight(portRows(parent)))
    parent.layout.width = Math.max(parent.layout.width, child.layout.x + child.layout.width + PAD)
    parent.layout.height = Math.max(parent.layout.height, child.layout.y + child.layout.height + PAD)
    child = parent
  }
}

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
      layout: defaultLayout(x, y)
    })
    growAncestors(d, id)
  })
  return id
}

/** Add a child module below the parent's ports and existing children. */
export function addSubmodule(parentId: Id): Id {
  const p = getProject()
  const parent = p.modules.find((m) => m.id === parentId)
  const top = leafHeight(parent ? portRows(parent) : 0) + PAD
  const bottom = Math.max(top, ...childModules(p, parentId).map((c) => c.layout.y + c.layout.height + PAD))
  return addModule(parentId, PAD, bottom)
}

export function deleteModule(id: Id): void {
  update((d) => {
    const ids = subtreeIds(d, id)
    d.modules = d.modules.filter((m) => !ids.has(m.id))
    d.links = d.links.filter((l) => !ids.has(l.from.moduleId) && !ids.has(l.to.moduleId))
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
    m.layout.height = Math.max(m.layout.height, leafHeight(portRows(m)))
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
