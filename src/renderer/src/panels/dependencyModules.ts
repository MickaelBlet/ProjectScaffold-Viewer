// Modules of the dependencies of the active document, read from their files (open in a tab, or next
// to this file when the host can read it; IDL files also as edited in a tab or picked this session),
// for the Explorer to list the ones not placed on the canvas.
import { useEffect, useState } from 'react'
import { childModules, modulePath } from '@/model/project'
import type { Dependency, Id, Project } from '@/model/types'
import { useDocs } from '@/store/documents'
import { useTextFiles } from '@/store/textFiles'
import { importSource, openSource } from '@/actions'

/** A module of a dependency, in its own project. */
export interface DependencyModule {
  id: Id
  /** Qualified path, as `ImportedModule.path`. */
  path: string
  ports: number
}

/** Modules of a project as a tree: each followed by its content, in project order. */
function modulesOf(p: Project): DependencyModule[] {
  const out: DependencyModule[] = []
  const visit = (parentId: Id | null): void => {
    for (const m of childModules(p, parentId)) {
      out.push({ id: m.id, path: modulePath(p, m.id), ports: m.ports.length })
      visit(m.id)
    }
  }
  visit(null)
  return out
}

/**
 * Modules of a dependency whose file cannot be read, from what this project keeps of it: the paths of
 * its placed modules and of the modules holding its types and constants, with the modules above them,
 * as a tree in the order they come; ports are not known.
 */
export function modulesOfPaths(paths: Iterable<string>): DependencyModule[] {
  const children = new Map<string | null, string[]>()
  const add = (path: string): void => {
    if (children.has(path)) return
    children.set(path, [])
    const dot = path.lastIndexOf('.')
    const parent = dot < 0 ? null : path.slice(0, dot)
    if (parent !== null) add(parent)
    const siblings = children.get(parent) ?? []
    children.set(parent, siblings)
    siblings.push(path)
  }
  for (const path of paths) if (path) add(path)
  const out: DependencyModule[] = []
  const visit = (parent: string | null): void => {
    for (const path of children.get(parent) ?? []) {
      out.push({ id: path, path, ports: 0 })
      visit(path)
    }
  }
  visit(null)
  return out
}

/** Modules of each dependency by id; dependencies whose file cannot be read are left out. */
export function useDependencyModules(dependencies: Dependency[]): Map<Id, DependencyModule[]> {
  // Opening or closing a tab can make a dependency readable.
  const openFiles = useDocs((s) => s.docs.map((d) => d.filePath ?? '').join('\n'))
  // So does opening or saving an IDL file in a text tab.
  const idlTexts = useTextFiles((s) =>
    Object.values(s.files)
      .filter((f) => f.source === 'file' && f.saved !== null)
      .map((f) => `${f.path}\u0000${f.saved}`)
      .join('\u0000')
  )
  const [modules, setModules] = useState<Map<Id, DependencyModule[]>>(new Map())
  useEffect(() => {
    let run = 0
    const load = (): void => {
      const n = ++run
      void Promise.all(dependencies.map(async (dep) => [dep.id, await importSource(dep.file)] as const)).then(
        (read) => {
          if (n !== run) return
          const next = new Map<Id, DependencyModule[]>()
          for (const [id, p] of read) if (p) next.set(id, modulesOf(p))
          setModules(next)
        }
      )
    }
    load()
    // Edits of a dependency open in a tab show at once.
    const stops = dependencies.flatMap((dep) => {
      const store = openSource(dep.file)?.store
      return store
        ? [
            store.subscribe((s, prev) => {
              if (s.project.modules !== prev.project.modules) load()
            })
          ]
        : []
    })
    return () => {
      run = -1
      stops.forEach((stop) => stop())
    }
  }, [dependencies, openFiles, idlTexts])
  return modules
}
