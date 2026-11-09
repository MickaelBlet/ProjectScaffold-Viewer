// Full-text search over every value of the project, as its file writes it.
import { modulePaths, typeNames } from './project'
import { toFile } from './serialize'
import { printTypeExpr } from './typeExpr'
import type { FileTypeRef } from './schema'
import type { ProblemTarget } from './validate'
import type { Id, Project, TypeDef } from './types'

export interface SearchHit {
  target: ProblemTarget
  /** Entity the hit belongs to, e.g. `Core.Sensor` or `Pose.position`. */
  label: string
  /** Where the text matched: name, description, metadata key... */
  field: string
  text: string
  /** Ids of the items holding the text, outermost first: an attribute, then its parameter... */
  members?: Id[]
}

/** Where values are being read: the entity, the label of the item and the ids of the items. */
interface Ctx {
  target: ProblemTarget
  label: string
  members: Id[]
}

/** Text at a line (from 1) of a file: `length` characters from `column` (from 0). */
export interface TextSpot {
  line: number
  column: number
  length: number
}

/** Hits of a query: every value containing it, or the types under a scope (`Core.`, `Dep/`). */
export function searchProject(p: Project, query: string, index?: SearchHit[]): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  if (q.endsWith('.') || q.endsWith('/')) return scopeTypes(p, q)
  return (index ?? searchIndex(p)).filter((h) => h.text.toLowerCase().includes(q))
}

const REF_KINDS = new Set(['primitive', 'ref', 'array', 'vector', 'list', 'set', 'optional', 'map'])
/** Keys holding definitions (not references) of types. */
const TYPE_LISTS = new Set(['types', 'typeParams'])
/** Free maps: their keys are data too. */
const FREE_MAPS = new Set(['metadata', 'options'])
const SKIPPED = new Set(['schemaVersion', 'color'])
const SINGULAR: Record<string, string> = {
  params: 'parameter',
  typeParams: 'type parameter',
  values: 'value',
  cases: 'case',
  flags: 'flag',
  modules: 'module',
  states: 'state',
  transitions: 'transition'
}
const singular = (key: string): string => SINGULAR[key] ?? key.replace(/ies$/, 'y').replace(/s$/, '')
/** Label of an item named `name` in the list `key` of the entity labelled `label`. */
const itemLabel = (label: string, key: string, name: string): string =>
  key === 'ports'
    ? `${label}:${name}`
    : key === 'params'
      ? `${label}(${name})`
      : key === 'modules'
        ? `${label}/${name}`
        : `${label}.${name}`

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isTypeRef = (v: Record<string, unknown>): boolean =>
  typeof v.kind === 'string' && REF_KINDS.has(v.kind) && !('description' in v)

/** Every value (text or number) of the project, with the entity it belongs to. */
export function searchIndex(p: Project): SearchHit[] {
  const file = toFile(p, { editor: false }) as unknown as Record<string, unknown>
  const hits: SearchHit[] = []
  const add = (c: Ctx, field: string, text: string): void => {
    if (text)
      hits.push({
        target: c.target,
        label: c.label,
        field,
        text,
        ...(c.members.length && { members: c.members })
      })
  }
  // Same item of the project (`src`, ids as in memory) as `v` of the file, if it has the name.
  const idOf = (src: unknown, name: string): Id | undefined =>
    isRecord(src) && (src.name === name || src.path === name) && typeof src.id === 'string'
      ? src.id
      : undefined

  // Values of an entity below `keys` (the path from the entity or from its last named item); `src`
  // is the same value in memory, giving the ids of the named items (`members`).
  const walk = (c: Ctx, keys: string[], v: unknown, src: unknown, skip?: Set<string>): void => {
    const field = keys.join(' ')
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint')
      return add(c, field, String(v))
    if (Array.isArray(v)) {
      const key = keys[keys.length - 1] ?? ''
      v.forEach((item: unknown, i) => {
        const from: unknown = Array.isArray(src) ? src[i] : undefined
        const nameKey =
          !isRecord(item) || TYPE_LISTS.has(key) ? undefined : 'name' in item ? 'name' : 'module'
        const name = nameKey && isRecord(item) ? item[nameKey] : undefined
        if (typeof name !== 'string') return walk(c, keys, item, from)
        // A named item (attribute, port...): its name has the item's kind as field.
        const one = singular(key)
        const id = idOf(from, name)
        const at = {
          target: c.target,
          label: itemLabel(c.label, key, name),
          members: id ? [...c.members, id] : c.members
        }
        add(at, one, name)
        walk(at, [one], item, from, new Set([nameKey!]))
      })
      return
    }
    if (!isRecord(v)) return
    if (isTypeRef(v) && !TYPE_LISTS.has(keys[keys.length - 1] ?? ''))
      return add(c, field, printTypeExpr(v as unknown as FileTypeRef))
    for (const [k, x] of Object.entries(v)) {
      if (SKIPPED.has(k) || skip?.has(k)) continue
      const sub: unknown = isRecord(src) ? src[k] : undefined
      if (FREE_MAPS.has(k) && isRecord(x))
        for (const [mk, mv] of Object.entries(x)) {
          add(c, `${k} key`, mk)
          walk(c, [...keys, k, mk], mv, undefined)
        }
      else walk(c, [...keys, k], x, sub)
    }
  }

  /** An entity (`src` in memory): its name with the field `kind`, the rest of its values. */
  const entity = (
    target: ProblemTarget,
    label: string,
    kind: string,
    v: unknown,
    src: unknown,
    skip?: Set<string>
  ): void => {
    if (!isRecord(v)) return
    const c = { target, label, members: [] }
    if (typeof v.name === 'string') add(c, kind, v.name)
    walk(c, [], v, src, new Set(['name', ...(skip ?? [])]))
  }

  const ownType = new Map(p.types.filter((t) => !t.dependency && !t.module).map((t) => [t.name, t.id]))
  const typeName = typeNames(p)
  const typeByName = new Map([...typeName].map(([id, name]) => [name, id]))
  const types = new Map(p.types.map((t) => [t.id, t]))
  const typeEntity = (id: Id | undefined, label: string, v: unknown, fallback: ProblemTarget): void => {
    const t = id === undefined ? undefined : types.get(id)
    entity(t ? { kind: 'type', id: t.id } : fallback, label, t?.kind ?? 'type', v, t)
  }
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])
  const nameOf = (v: Record<string, unknown>): string => (typeof v.name === 'string' ? v.name : '')

  const project = { kind: 'project' } as const
  const root = { target: project, label: 'Project', members: [] }
  entity(project, 'Project', 'name', file.project, p)
  walk(root, ['transports'], file.transports, undefined)
  walk(root, ['remoteDefaults'], file.remoteDefaults, undefined)
  for (const b of list(file.binaries)) entity(project, nameOf(b), 'binary', b, undefined)

  // Modules, with their types; paths as `modulePaths` writes them.
  const moduleByPath = new Map([...modulePaths(p)].map(([id, path]) => [path, id]))
  const modules = (items: unknown, parent: string): void => {
    for (const m of list(items)) {
      const path = parent ? `${parent}.${nameOf(m)}` : nameOf(m)
      const id = moduleByPath.get(path)
      if (id === undefined) continue
      const src = p.modules.find((x) => x.id === id)
      entity({ kind: 'module', id }, path, 'module', m, src, new Set(['modules', 'types', 'typeParams']))
      for (const t of [...list(m.typeParams), ...list(m.types)]) {
        const name = `${path}.${nameOf(t)}`
        typeEntity(typeByName.get(name), name, t, { kind: 'module', id })
      }
      modules(m.modules, path)
    }
  }

  const owned = (
    v: Record<string, unknown>,
    dep: { id: Id; name: string } | undefined,
    fallback: ProblemTarget
  ): void => {
    const inDep = <T extends { dependency?: Id; name: string; id: Id }>(
      xs: T[],
      name: string
    ): T | undefined =>
      xs.find(
        (x) =>
          x.dependency === dep?.id &&
          x.name === name &&
          !(x as { module?: Id }).module &&
          !(x as { modulePath?: string }).modulePath
      )
    const label = (name: string): string => (dep ? `${dep.name}/${name}` : name)
    for (const t of list(v.types)) {
      const id = dep ? inDep(p.types, nameOf(t))?.id : ownType.get(nameOf(t))
      typeEntity(id, dep ? label(nameOf(t)) : (typeName.get(id ?? '') ?? nameOf(t)), t, fallback)
    }
    for (const i of list(v.interfaces)) {
      const found = inDep(p.interfaces, nameOf(i))
      entity(found ? { kind: 'interface', id: found.id } : fallback, label(nameOf(i)), 'interface', i, found)
    }
    for (const c of list(v.constants)) {
      const found = inDep(p.consts, nameOf(c))
      entity(found ? { kind: 'const', id: found.id } : fallback, label(nameOf(c)), 'constant', c, found)
    }
  }

  owned(file, undefined, project)
  modules(file.modules, '')
  list(file.links).forEach((l, i) => {
    const link = p.links[i]
    if (link) entity({ kind: 'link', id: link.id }, nameOf(l), 'link', l, link)
  })
  list(file.dependencies).forEach((d, i) => {
    const dep = p.dependencies[i]
    if (!dep) return
    const target = { kind: 'dependency', id: dep.id } as const
    entity(
      target,
      dep.name,
      'dependency',
      d,
      dep,
      new Set(['types', 'interfaces', 'constants', 'moduleTypes'])
    )
    owned(d, dep, target)
    for (const g of list(d.moduleTypes))
      for (const t of list(g.types)) {
        const name = `${dep.name}/${String(g.module)}.${nameOf(t)}`
        typeEntity(typeByName.get(name), name, t, target)
      }
  })
  return hits
}

/**
 * Types under a module or dependency, for a query ending with `.` or `/`: `Core.` lists the types
 * of Core and of its inner modules, `Common/` every type of the dependency Common.
 */
function scopeTypes(p: Project, q: string): SearchHit[] {
  const names = typeNames(p)
  const deps = new Map(p.dependencies.map((d) => [d.id, d.name]))
  const scoped = (t: TypeDef): string =>
    t.dependency && !t.module && !t.modulePath
      ? `${deps.get(t.dependency) ?? '?'}/${t.name}`
      : names.get(t.id)!
  return p.types
    .map((t) => ({ t, label: scoped(t) }))
    .filter(({ label }) => label.toLowerCase().startsWith(q))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ t, label }) => ({ target: { kind: 'type', id: t.id }, label, field: t.kind, text: t.name }))
}
