// Problems of a project file located on the lines of its text, for editors listing them there.
import { findImported, modulePath } from './project'
import type { FileProject } from './schema'
import { LoadError, lineOfPath, loadText, parseText, type Format } from './serialize'
import type { Project } from './types'
import { validate, type ProblemTarget, type Severity } from './validate'

export interface LocatedProblem {
  severity: Severity
  message: string
  /** From 1. */
  line: number
}

type DataPath = (string | number)[]

/** Data path of an entity in the file data read from the text; list items are found by name. */
export function targetPath(data: unknown, p: Project, target: ProblemTarget): DataPath {
  const file = data as Partial<FileProject>
  const named = (key: string, items: { name: string }[] | undefined, name: string | undefined): DataPath => {
    const i = items?.findIndex((e) => e.name === name) ?? -1
    return i < 0 ? [key] : [key, i]
  }
  switch (target.kind) {
    case 'project':
      return ['project']
    case 'type':
    case 'interface': {
      const key = target.kind === 'type' ? 'types' : 'interfaces'
      const e = [...p.types, ...p.interfaces].find((x) => x.id === target.id)
      const dep = e?.dependency && p.dependencies.find((x) => x.id === e.dependency)
      if (!dep) return named(key, file[key], e?.name)
      // A dependency's: dependencies.i.types.j
      const path = named('dependencies', file.dependencies, dep.name)
      const i = path[1] as number | undefined
      return i === undefined ? path : [...path, ...named(key, file.dependencies![i]![key], e.name)]
    }
    case 'link':
      return named('links', file.links, p.links.find((l) => l.id === target.id)?.name)
    case 'module': {
      const imported = findImported(p, target.id)
      if (imported) {
        const path = named('dependencies', file.dependencies, imported.dep.name)
        const i = path[1] as number | undefined
        const j =
          i === undefined
            ? -1
            : (file.dependencies![i]!.modules ?? []).findIndex((m) => m.module === imported.module.path)
        return j < 0 ? path : [...path, 'modules', j]
      }
      // Nested modules: modules.i.modules.j...
      const path: DataPath = []
      let items = file.modules
      for (const name of modulePath(p, target.id).split('.')) {
        const i = items?.findIndex((m) => m.name === name) ?? -1
        if (i < 0) break
        path.push('modules', i)
        items = items![i]!.modules
      }
      return path.length ? path : ['modules']
    }
  }
}

/** Load errors when the text cannot be read, else the validation problems. */
export function locateProblems(text: string, format: Format): LocatedProblem[] {
  let project: Project
  try {
    project = loadText(text, format)
  } catch (e) {
    const issues = e instanceof LoadError ? e.issues : [{ message: String(e), line: undefined }]
    return issues.map((i) => ({ severity: 'error', message: i.message, line: i.line ?? 1 }))
  }
  const data = parseText(text, format)
  return validate(project).map((pb) => ({
    severity: pb.severity,
    message: pb.message,
    line: lineOfPath(text, targetPath(data, project, pb.target)) ?? 1
  }))
}
