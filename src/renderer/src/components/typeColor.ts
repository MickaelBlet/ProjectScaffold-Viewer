import { parseDependencyModuleRef } from '@/model/project'
import type { Id, Project, TypeRef } from '@/model/types'

/** Classes coloring an entry after a kind (the colors of the Explorer's badges); none without one. */
export function kindClass(kind: string | undefined): string {
  return kind ? `typed of-${kind}` : ''
}

/**
 * Kind a type reference is colored after: `builtin` for a primitive, `container` for a container but
 * optional (that of its item), else what `kindOf` gives the referenced id (a user type's kind, `mod` for a
 * module; none for a deleted type).
 */
export function typeColorKind(t: TypeRef, kindOf: (id: Id) => string | undefined): string | undefined {
  if (t.kind === 'primitive') return 'builtin'
  if (t.kind === 'optional') return typeColorKind(t.of, kindOf)
  if (t.kind !== 'ref') return 'container'
  return kindOf(t.id)
}

/** Classes coloring an entry after the kind of what type reference `t` names. */
export function typeColorClass(t: TypeRef, kindOf: (id: Id) => string | undefined): string {
  return kindClass(typeColorKind(t, kindOf))
}

/** Kinds of what ids name in project `p`: a type's kind, `mod` for a module (of a dependency too). */
export function refKinds(
  p: Pick<Project, 'types' | 'modules' | 'dependencies'>
): (id: Id) => string | undefined {
  const types = new Map(p.types.map((t) => [t.id, t.kind]))
  const modules = new Set(p.modules.map((m) => m.id))
  return (id) => {
    const kind = types.get(id)
    if (kind) return kind
    if (modules.has(id)) return 'mod'
    const of = parseDependencyModuleRef(id)
    return of && p.dependencies.some((x) => x.id === of.dependency) ? 'mod' : undefined
  }
}
