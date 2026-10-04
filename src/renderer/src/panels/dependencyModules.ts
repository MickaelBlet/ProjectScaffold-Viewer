// Modules of the dependencies of the active document, read from their files (open in a tab, or next
// to this file when the host can read it), for the Explorer to list the ones not placed on the canvas.
import { useEffect, useState } from 'react'
import { modulePath } from '@/model/project'
import type { Dependency, Id, Project } from '@/model/types'
import { useDocs } from '@/store/documents'
import { importSource, openSource } from '@/actions'

/** A module of a dependency, in its own project. */
export interface DependencyModule {
  id: Id
  /** Qualified path, as `ImportedModule.path`. */
  path: string
  ports: number
}

const modulesOf = (p: Project): DependencyModule[] =>
  p.modules.map((m) => ({ id: m.id, path: modulePath(p, m.id), ports: m.ports.length }))

/** Modules of each dependency by id; dependencies whose file cannot be read are left out. */
export function useDependencyModules(dependencies: Dependency[]): Map<Id, DependencyModule[]> {
  // Opening or closing a tab can make a dependency readable.
  const openFiles = useDocs((s) => s.docs.map((d) => d.filePath ?? '').join('\n'))
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
  }, [dependencies, openFiles])
  return modules
}
