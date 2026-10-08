// The entity of the project that a place in its file text describes, for following the caret.
import { modulePaths, noteAtPath } from '@/model/project'
import { toFile } from '@/model/serialize'
import type { FileModule } from '@/model/schema'
import type { Id, Project } from '@/model/types'
import type { ProblemTarget } from '@/model/validate'
import type { Path } from './completion'

/** An entity to navigate to, or a note. */
export type SourceTarget = ProblemTarget | { kind: 'note'; id: Id }

/**
 * Entity at a data path of the file. List items are found by the names written in the text
 * (`names`, see `structureAt`), else by their position in the project.
 */
export function targetAt(p: Project, path: Path, names: (string | undefined)[]): SourceTarget | null {
  const file = toFile(p, { editor: false })
  const index = (k: number): number | null => (typeof path[k] === 'number' ? path[k] : null)
  /** Name of the list item at `path[k]`: as written, else the project's at that position. */
  const itemName = (k: number, list: readonly { name: string }[] | undefined): string | undefined => {
    const i = index(k)
    return i === null ? undefined : (names[k] ?? list?.[i]?.name)
  }
  const byName = <T extends { id: Id; name: string }>(list: T[], name: string | undefined) =>
    name === undefined ? undefined : list.find((e) => e.name === name)
  const paths = modulePaths(p)
  // Placed modules of dependencies too ('Dependency/Module').
  const moduleAt = (modulePath: string | undefined): Id | undefined =>
    modulePath === undefined ? undefined : [...paths].find(([, path]) => path === modulePath)?.[0]

  switch (path[0]) {
    case 'project':
    case 'schemaVersion':
      return { kind: 'project' }
    case 'types': {
      const t = byName(p.types, itemName(1, file.types))
      return t ? { kind: 'type', id: t.id } : null
    }
    case 'interfaces': {
      const i = byName(p.interfaces, itemName(1, file.interfaces))
      return i ? { kind: 'interface', id: i.id } : null
    }
    case 'links': {
      const l = byName(p.links, itemName(1, file.links))
      return l ? { kind: 'link', id: l.id } : null
    }
    case 'modules': {
      // Nested modules: modules.i.modules.j...
      const parts: string[] = []
      let list: FileModule[] | undefined = file.modules
      for (let k = 0; path[k] === 'modules' && index(k + 1) !== null; k += 2) {
        const name = itemName(k + 1, list)
        if (name === undefined) break
        parts.push(name)
        list = (list?.find((m) => m.name === name) ?? list?.[index(k + 1)!])?.modules
      }
      const id = moduleAt(parts.join('.') || undefined)
      return id ? { kind: 'module', id } : null
    }
    case 'dependencies': {
      const dep = byName(p.dependencies, itemName(1, file.dependencies))
      const fileDep = file.dependencies?.find((x) => x.name === dep?.name)
      const j = index(3)
      if (!dep) return null
      // The dependency itself, or one of its fields.
      if (!fileDep || j === null) return { kind: 'dependency', id: dep.id }
      if (path[2] === 'types') {
        const t = byName(p.types, itemName(3, fileDep.types))
        return t ? { kind: 'type', id: t.id } : null
      }
      if (path[2] === 'interfaces') {
        const i = byName(p.interfaces, itemName(3, fileDep.interfaces))
        return i ? { kind: 'interface', id: i.id } : null
      }
      if (path[2] !== 'modules') return null
      const modulePath = names[3] ?? fileDep.modules?.[j]?.module
      const m = dep.modules.find((m) => m.path === modulePath)
      return m ? { kind: 'module', id: m.id } : null
    }
    case 'editor': {
      // Editor data keyed by module path or link name, notes, and the same in the views.
      const note = noteAtPath(p, path)
      if (note) return { kind: 'note', id: note.id }
      const key = (k: number): string | undefined => (typeof path[k] === 'string' ? path[k] : undefined)
      const moduleTarget = (modulePath: string | undefined): SourceTarget | null => {
        const id = moduleAt(modulePath)
        return id ? { kind: 'module', id } : null
      }
      const linkTarget = (name: string | undefined): SourceTarget | null => {
        const l = byName(p.links, name)
        return l ? { kind: 'link', id: l.id } : null
      }
      if (path[1] === 'layout' || path[1] === 'style') return moduleTarget(key(2))
      if (path[1] === 'links') return linkTarget(key(2))
      if (path[1] !== 'views') return null
      const view = p.views[index(2) ?? -1]
      if (!view) return null
      if (path[3] === 'layout' || path[3] === 'labels' || path[3] === 'outside') return moduleTarget(key(4))
      if (path[3] === 'links') return linkTarget(key(4))
      if (path[3] === 'hidden') {
        const id = view.hidden[index(4) ?? -1]
        return id ? { kind: 'module', id } : null
      }
      // The view itself: its root.
      return view.rootModuleId ? { kind: 'module', id: view.rootModuleId } : null
    }
    default:
      return null
  }
}
