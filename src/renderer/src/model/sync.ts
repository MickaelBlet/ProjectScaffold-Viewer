// Keeping projects in sync: renames of modules, ports, types, interfaces and constants made in one project are
// carried to the projects depending on it (see dependencies.ts).
import type { Id, Project } from './types'

/** Renames between two states of a project (entities keep their id when renamed). */
export interface Renames {
  /** Old module path → new path. */
  modules: Map<string, string>
  /** New module path → old port name → new name. */
  ports: Map<string, Map<string, string>>
  /** Old interface name → new name. */
  interfaces: Map<string, string>
  /** Old type name → new name (own types: dependents follow them). */
  types: Map<string, string>
  /** Old constant name → new name (own constants). */
  consts: Map<string, string>
  /** Types of modules, renamed or in a renamed or moved module: old `Path.Name` → new one. */
  moduleTypes: Map<string, string>
}

/** Last component of a file path: dependencies name files relative to the project, tabs by their name. */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export const sameFile = (a: string, b: string): boolean => baseName(a) === baseName(b)

const hasFolder = (path: string): boolean => /[\\/]/.test(path)

/**
 * Whether the dependency `file` of the project saved as `from` is the file at `path`: by full path
 * when the paths have folders, else by name (browser, unsaved project, dependency on another drive).
 */
export function isDependencyFile(from: string | null, file: string, path: string): boolean {
  if (!from || !hasFolder(from) || !hasFolder(file) || !hasFolder(path)) return sameFile(file, path)
  // Windows paths ignore case.
  const key = (p: string): string =>
    /^[A-Za-z]:/.test(p) ? normalizeFile(p).toLowerCase() : normalizeFile(p)
  return key(resolveRelative(from, file)) === key(path)
}

/**
 * `file` relative to the folder of the project file `from`, for a dependency. The name alone when
 * `from` is unknown (unsaved project, browser) or on another drive.
 */
export function relativeFile(from: string | null, file: string): string {
  if (!from) return baseName(file)
  const dir = from.split(/[\\/]/).slice(0, -1)
  const parts = file.split(/[\\/]/)
  let common = 0
  while (common < dir.length && common < parts.length - 1 && dir[common] === parts[common]) common++
  if (!common) return baseName(file)
  return [...dir.slice(common).map(() => '..'), ...parts.slice(common)].join('/')
}

/** `file` with `.` and `dir/..` steps removed, `/` separated. */
export function normalizeFile(file: string): string {
  const out: string[] = []
  for (const part of file.split(/[\\/]/)) {
    if (part === '.' || (part === '' && out.length)) continue
    if (part === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * `nested`, relative to the folder of `file`, made relative to the folder `file` is relative to:
 * the file of a dependency of a dependency.
 */
export function resolveRelative(file: string, nested: string): string {
  if (/^([\\/]|[A-Za-z]:)/.test(nested)) return normalizeFile(nested)
  const dir = file.split(/[\\/]/).slice(0, -1)
  return normalizeFile([...dir, nested].join('/'))
}

const byId = <T extends { id: Id }>(items: readonly T[]): Map<Id, T> => new Map(items.map((x) => [x.id, x]))

/** Module paths by id, in one pass. */
function paths(p: Project): Map<Id, string> {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const out = new Map<Id, string>()
  const path = (id: Id): string => {
    const known = out.get(id)
    if (known !== undefined) return known
    const m = byId.get(id)
    if (!m) return ''
    const parent = m.parentId ? path(m.parentId) : ''
    const result = parent ? `${parent}.${m.name}` : m.name
    out.set(id, result)
    return result
  }
  for (const m of p.modules) path(m.id)
  return out
}

/** Renames from `prev` to `next`; null when there are none. */
export function diffRenames(prev: Project, next: Project): Renames | null {
  if (
    prev.modules === next.modules &&
    prev.interfaces === next.interfaces &&
    prev.types === next.types &&
    prev.consts === next.consts
  )
    return null
  const r: Renames = {
    modules: new Map(),
    ports: new Map(),
    interfaces: new Map(),
    types: new Map(),
    consts: new Map(),
    moduleTypes: new Map()
  }
  const modulesChanged = prev.modules !== next.modules
  const before = modulesChanged || prev.types !== next.types ? paths(prev) : new Map<Id, string>()
  const after = modulesChanged ? paths(next) : before
  if (modulesChanged) {
    const prevModules = byId(prev.modules)
    for (const m of next.modules) {
      const old = prevModules.get(m.id)
      if (!old) continue
      const from = before.get(m.id)!
      const to = after.get(m.id)!
      if (from !== to) r.modules.set(from, to)
      if (old.ports === m.ports) continue
      const names = new Map<string, string>()
      for (const pt of m.ports) {
        const was = old.ports.find((x) => x.id === pt.id)
        if (was && was.name !== pt.name) names.set(was.name, pt.name)
      }
      if (names.size) r.ports.set(to, names)
    }
  }
  if (prev.interfaces !== next.interfaces) {
    const prevInterfaces = byId(prev.interfaces)
    for (const i of next.interfaces) {
      const was = prevInterfaces.get(i.id)
      if (was && was.name !== i.name && !i.dependency) r.interfaces.set(was.name, i.name)
    }
  }
  if (prev.types !== next.types || modulesChanged) {
    const prevTypes = byId(prev.types)
    for (const t of next.types) {
      const was = prevTypes.get(t.id)
      if (was && was.name !== t.name && !t.dependency && !t.module && !was.module)
        r.types.set(was.name, t.name)
      if (!t.module || !was?.module) continue
      const from = `${before.get(was.module)}.${was.name}`
      const to = `${after.get(t.module)}.${t.name}`
      if (from !== to) r.moduleTypes.set(from, to)
    }
  }
  if (prev.consts !== next.consts) {
    const prevConsts = byId(prev.consts)
    for (const c of next.consts) {
      const was = prevConsts.get(c.id)
      if (was && was.name !== c.name && !c.dependency) r.consts.set(was.name, c.name)
    }
  }
  return r.modules.size ||
    r.ports.size ||
    r.interfaces.size ||
    r.types.size ||
    r.consts.size ||
    r.moduleTypes.size
    ? r
    : null
}
