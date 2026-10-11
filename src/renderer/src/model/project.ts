// Pure helpers over the in-memory project.
import { isReservedTypeName, mapTypeRef, printTypeExpr, walkTypeRef } from './typeExpr'
import {
  GLOBAL_VIEW,
  type Access,
  type Attribute,
  type Orientation,
  type Id,
  type Dependency,
  type ImportedModule,
  type Interface,
  type LinkConstraints,
  type Method,
  type Module,
  type Note,
  type Port,
  type PortRole,
  type Qualifier,
  type Project,
  type Rect,
  type Scoped,
  type StoredAccess,
  type TypeDef,
  type TypeRef,
  type View,
  TRANSPORTS
} from './types'

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function newId(): Id {
  return crypto.randomUUID()
}

export function emptyProject(): Project {
  return {
    name: 'Untitled',
    description: '',
    metadata: {},
    transports: [],
    binaries: [],
    types: [],
    interfaces: [],
    consts: [],
    modules: [],
    links: [],
    dependencies: [],
    views: [],
    notes: [],
    orientation: 'horizontal'
  }
}

/** Some message of the interface answers the caller: returns a value or has out parameters. */
export function repliesToCaller(iface: Interface): boolean {
  return iface.messages.some((m) => m.returns || m.params.some((prm) => prm.direction !== 'in'))
}

/** Constraints of a new link, bidirectional when its interface answers the caller. */
export function defaultConstraints(iface?: Interface): LinkConstraints {
  return {
    direction: iface && repliesToCaller(iface) ? 'bidirectional' : 'unidirectional',
    ack: { required: false },
    performance: { class: 'normal' },
    remote: { enabled: false }
  }
}

export const MODULE_WIDTH = 200
export const MODULE_HEADER = 36
export const PORT_ROW = 24

/** Port rows of a module node: `in` ports on the left, `out` ports on the right. */
export function portRows(m: { ports: { role: string }[] }): number {
  const ins = m.ports.filter((p) => p.role === 'in').length
  return Math.max(ins, m.ports.length - ins)
}

export function leafHeight(portCount: number): number {
  return MODULE_HEADER + Math.max(1, portCount) * PORT_ROW + 12
}

export const LAYOUT_PAD = 20

// Vertical orientation: a band of `in` ports above the header, a band of `out` ports at the bottom.
export const PORT_BAND = 24
/** Width taken by one port along a band. */
const PORT_COL = 90

/** Height of one line in a module's attribute or method compartment. */
export const ATTR_ROW = 18

type WithCompartments = {
  attributes?: readonly unknown[]
  methods?: readonly unknown[]
  constructors?: readonly unknown[]
  destructor?: unknown
}
type WithPorts = { ports: { role: string }[] } & WithCompartments

/** Height of one compartment of `n` lines: none when empty. */
const compartmentHeight = (n = 0): number => (n ? n * ATTR_ROW + 8 : 0)

/** Height of a module's attribute and method compartments, below its header. */
export function compartmentsHeight(m: WithCompartments): number {
  // Constructors and the destructor head the methods.
  const methods = (m.methods?.length ?? 0) + (m.constructors?.length ?? 0) + (m.destructor ? 1 : 0)
  return compartmentHeight(m.attributes?.length) + compartmentHeight(methods)
}

/**
 * Top of the area holding a module's content (submodules): below the header, the top band and
 * the attributes and methods of `m`.
 */
export function contentTop(o: Orientation, m: WithCompartments = {}): number {
  return (o === 'vertical' ? PORT_BAND + MODULE_HEADER : MODULE_HEADER) + compartmentsHeight(m)
}

/** Space kept below a module's content. */
export function contentBottom(o: Orientation): number {
  return o === 'vertical' ? PORT_BAND + LAYOUT_PAD : LAYOUT_PAD
}

/** Smallest size showing a module's header, attributes, methods and ports. */
export function minSize(m: WithPorts, o: Orientation): { width: number; height: number } {
  const attrs = compartmentsHeight(m)
  if (o === 'horizontal') return { width: 140, height: leafHeight(portRows(m)) + attrs }
  const ins = m.ports.filter((p) => p.role === 'in').length
  return {
    width: Math.max(140, Math.max(ins, m.ports.length - ins) * PORT_COL + 20),
    height: 2 * PORT_BAND + MODULE_HEADER + 8 + attrs
  }
}

/** Size of a new or reset module (no content). */
export function defaultSize(m: WithPorts, o: Orientation): { width: number; height: number } {
  const min = minSize(m, o)
  return { width: Math.max(MODULE_WIDTH, min.width), height: min.height }
}

/** Keep `id` inside its parent's content area (below header and ports), growing ancestors as needed. */
export function growAncestors(d: Project, id: Id): void {
  let child = d.modules.find((m) => m.id === id)
  while (child?.parentId) {
    const parentId: Id = child.parentId
    const parent = d.modules.find((m) => m.id === parentId)
    if (!parent) return
    child.layout.x = Math.max(child.layout.x, LAYOUT_PAD / 2)
    child.layout.y = Math.max(child.layout.y, contentTop(d.orientation, parent))
    parent.layout.width = Math.max(parent.layout.width, child.layout.x + child.layout.width + LAYOUT_PAD)
    parent.layout.height = Math.max(
      parent.layout.height,
      child.layout.y + child.layout.height + contentBottom(d.orientation)
    )
    child = parent
  }
}

const byIdCache = new WeakMap<readonly { id: Id }[], ReadonlyMap<Id, { id: Id }>>()
const parentsCache = new WeakMap<readonly Module[], ReadonlySet<Id>>()

/** `items` by id, built once per array: for arrays never changed in place (store states, not drafts). */
export function indexById<T extends { id: Id }>(items: readonly T[]): ReadonlyMap<Id, T> {
  let index = byIdCache.get(items)
  if (!index) byIdCache.set(items, (index = new Map(items.map((x) => [x.id, x]))))
  return index as ReadonlyMap<Id, T>
}

/** Ids of the modules holding others, built once per array (as `indexById`). */
export function parentIds(modules: readonly Module[]): ReadonlySet<Id> {
  let parents = parentsCache.get(modules)
  if (!parents) parentsCache.set(modules, (parents = new Set(modules.flatMap((m) => m.parentId ?? []))))
  return parents
}

export function childModules(p: Project, parentId: Id | null): Module[] {
  return p.modules.filter((m) => m.parentId === parentId)
}

/** Parent-relative top of the free space below a module's submodules (`exceptId` left out). */
export function belowContent(p: Project, parentId: Id, exceptId?: Id): number {
  return Math.max(
    contentTop(
      p.orientation,
      p.modules.find((m) => m.id === parentId)
    ) + LAYOUT_PAD,
    ...childModules(p, parentId)
      .filter((c) => c.id !== exceptId)
      .map((c) => c.layout.y + c.layout.height + LAYOUT_PAD)
  )
}

/** Ids of `id` and all its descendants. */
export function subtreeIds(p: Project, id: Id): Set<Id> {
  const ids = new Set<Id>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const m of p.modules) {
      if (m.parentId && ids.has(m.parentId) && !ids.has(m.id)) {
        ids.add(m.id)
        grew = true
      }
    }
  }
  return ids
}

export function modulePath(p: Project, id: Id): string {
  const imported = findImported(p, id)
  if (imported) return `${imported.dep.name}/${imported.module.path}`
  const parts: string[] = []
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    parts.unshift(cur.name)
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return parts.join('.')
}

const findImportedIn = (p: Pick<Project, 'dependencies'>, id: Id): ImportedModule | undefined =>
  findImported(p, id)?.module

/** `modulePath` of every module and imported module, computed at once. */
export function modulePaths(p: Pick<Project, 'modules' | 'dependencies'>): Map<Id, string> {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const paths = new Map<Id, string>()
  const path = (m: Module): string => {
    let known = paths.get(m.id)
    if (known === undefined) {
      const parent = m.parentId ? byId.get(m.parentId) : undefined
      known = parent ? `${path(parent)}.${m.name}` : m.name
      paths.set(m.id, known)
    }
    return known
  }
  for (const m of p.modules) path(m)
  for (const dep of p.dependencies) for (const m of dep.modules) paths.set(m.id, `${dep.name}/${m.path}`)
  return paths
}

/** Text of a link end, `Module.Path:port`, from `modulePaths`. */
export function endpointLabel(
  p: Pick<Project, 'modules' | 'dependencies'>,
  paths: Map<Id, string>,
  e: { moduleId: Id; portId: Id }
): string {
  const ports = p.modules.find((m) => m.id === e.moduleId)?.ports ?? findImportedIn(p, e.moduleId)?.ports
  return `${paths.get(e.moduleId) ?? ''}:${ports?.find((pt) => pt.id === e.portId)?.name ?? '?'}`
}

/** Absolute canvas position of a module (layouts are parent-relative). */
export function absolutePosition(p: Project, id: Id): { x: number; y: number } {
  const imported = findImported(p, id)
  if (imported) {
    let { x, y } = imported.module.position
    for (let up = importedParent(imported.dep, imported.module); up; up = importedParent(imported.dep, up)) {
      x += up.position.x
      y += up.position.y
    }
    return { x, y }
  }
  let x = 0
  let y = 0
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    x += cur.layout.x
    y += cur.layout.y
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return { x, y }
}

/**
 * Roles of the ports at both ends of a link from module `from` to module `to`: `out` → `in`
 * between modules side by side; through a container's port to its content, `in` → `in` into it
 * and `out` → `out` out of it (delegation).
 */
export function linkRoles(p: Project, from: Id, to: Id): [PortRole, PortRole] {
  if (subtreeIds(p, from).has(to)) return ['in', 'in']
  if (subtreeIds(p, to).has(from)) return ['out', 'out']
  return ['out', 'in']
}

/**
 * Two link ends in link order (from, to), matching the roles of their ports (null: a new port,
 * any role), or null when neither order fits.
 */
export function orderLinkEnds<T extends { moduleId: Id; role: PortRole | null }>(
  p: Project,
  a: T,
  b: T
): [T, T] | null {
  for (const [x, y] of [
    [a, b],
    [b, a]
  ] as const) {
    const [rx, ry] = linkRoles(p, x.moduleId, y.moduleId)
    if ((x.role ?? rx) === rx && (y.role ?? ry) === ry) return [x, y]
  }
  return null
}

/**
 * Innermost module holding both ends of a link (an end itself when the other is inside it), or
 * null at the top level: bend points are relative to it so that they follow it.
 */
export function linkOrigin(p: Project, l: { from: { moduleId: Id }; to: { moduleId: Id } }): Id | null {
  const chain = (id: Id): Id[] => {
    const ids: Id[] = []
    let m = p.modules.find((x) => x.id === id)
    while (m) {
      ids.push(m.id)
      const parentId: Id | null = m.parentId
      m = parentId ? p.modules.find((x) => x.id === parentId) : undefined
    }
    return ids
  }
  const theirs = new Set(chain(l.to.moduleId))
  return chain(l.from.moduleId).find((id) => theirs.has(id)) ?? null
}

/**
 * A port of a module or of an imported module. An imported port is a copy whose interface is this
 * project's interface of the same name (null when there is none): changing it has no effect.
 */
export function findPort(
  p: Pick<Project, 'modules' | 'dependencies' | 'interfaces'>,
  moduleId: Id,
  portId: Id
): Port | undefined {
  const port = p.modules.find((m) => m.id === moduleId)?.ports.find((pt) => pt.id === portId)
  if (port) return port
  const imported = findImported(p, moduleId)?.module.ports.find((pt) => pt.id === portId)
  if (!imported) return undefined
  const { interface: iface, ...rest } = imported
  return { ...rest, interfaceId: p.interfaces.find((i) => i.name === iface)?.id ?? null }
}

// Imported modules: modules of dependencies placed on the canvas.

export const IMPORTED_PREFIX = 'imported:'

export const isImportedId = (id: Id): boolean => id.startsWith(IMPORTED_PREFIX)

export function findImported(
  p: Pick<Project, 'dependencies'>,
  id: Id
): { dep: Dependency; module: ImportedModule } | undefined {
  if (!isImportedId(id)) return undefined
  for (const dep of p.dependencies) {
    const module = dep.modules.find((m) => m.id === id)
    if (module) return { dep, module }
  }
  return undefined
}

export const allImported = (p: Project): ImportedModule[] => p.dependencies.flatMap((d) => d.modules)

/** Path of the module holding the module at `path` (`A` for `A.B`); null for a top-level one. */
export function parentPath(path: string): string | null {
  const i = path.lastIndexOf('.')
  return i < 0 ? null : path.slice(0, i)
}

/**
 * Placed module of `dep` holding `m`: a placed module comes with its content, each drawn inside its
 * parent (position relative to it). Undefined for a placed top-level module.
 */
export function importedParent(dep: Dependency, m: ImportedModule): ImportedModule | undefined {
  const parent = parentPath(m.path)
  return parent === null ? undefined : dep.modules.find((x) => x.path === parent)
}

/**
 * Keep the placed module `id` (content of another one) inside its parent's content area, growing
 * its placed ancestors as needed (see growAncestors).
 */
export function growImportedAncestors(d: Project, id: Id): void {
  const found = findImported(d, id)
  if (!found) return
  const { dep } = found
  let child = found.module
  for (let parent = importedParent(dep, child); parent; parent = importedParent(dep, child)) {
    const size = importedSize(child, d.orientation)
    child.position = {
      x: Math.max(child.position.x, LAYOUT_PAD / 2),
      y: Math.max(child.position.y, contentTop(d.orientation))
    }
    const own = importedSize(parent, d.orientation)
    const width = Math.max(own.width, child.position.x + size.width + LAYOUT_PAD)
    const height = Math.max(own.height, child.position.y + size.height + contentBottom(d.orientation))
    if (width !== parent.size?.width || height !== parent.size?.height) parent.size = { width, height }
    child = parent
  }
}

/** Placed modules of dependencies not inside another one: those arranged and framed. */
export const importedRoots = (p: Project): ImportedModule[] =>
  p.dependencies.flatMap((d) => d.modules.filter((m) => !importedParent(d, m)))

/** Top-level modules, notes and imported modules lying fully inside a frame, at their saved size. */
export function frameContents(
  p: Project,
  frameId: Id
): { id: Id; kind: 'module' | 'note' | 'imported'; name: string }[] {
  const f = p.notes.find((n) => n.id === frameId)?.layout
  if (!f) return []
  const within = (r: Rect): boolean =>
    r.x >= f.x && r.y >= f.y && r.x + r.width <= f.x + f.width && r.y + r.height <= f.y + f.height
  return [
    ...p.modules
      .filter((m) => !m.parentId && within(m.layout))
      .map((m) => ({ id: m.id, kind: 'module' as const, name: m.name })),
    ...p.notes
      .filter((n) => n.id !== frameId && within(n.layout))
      .map((n) => ({ id: n.id, kind: 'note' as const, name: n.text.split('\n')[0] || `(${n.kind})` })),
    ...importedRoots(p)
      .filter((m) => within({ ...m.position, ...importedSize(m, p.orientation) }))
      .map((m) => ({ id: m.id, kind: 'imported' as const, name: m.path }))
  ]
}

/** Size of an imported module on the canvas: set by hand (at least its minimum), else from its ports. */
export function importedSize(m: ImportedModule, o: Orientation): { width: number; height: number } {
  if (!m.size) return defaultSize(m, o)
  const min = minSize(m, o)
  return { width: Math.max(min.width, m.size.width), height: Math.max(min.height, m.size.height) }
}

export const PALETTE = [
  '#e0513b',
  '#d98b00',
  '#d6c21f',
  '#2e9e5b',
  '#2e9e8f',
  '#3b8fd1',
  '#3b6fe0',
  '#8a4fd1',
  '#d14f9e',
  '#7a8496'
]

/** The least used palette hue (grey excluded), so each new module stands out from the others. */
export function nextModuleColor(p: Project): string {
  const hues = PALETTE.slice(0, -1)
  const count = new Map(hues.map((c) => [c, 0]))
  for (const m of p.modules) if (m.color && count.has(m.color)) count.set(m.color, count.get(m.color)! + 1)
  return hues.reduce((best, c) => (count.get(c)! < count.get(best)! ? c : best))
}

/** Set a qualifier of an attribute, method or parameter, or leave it out. */
export function setQualifier(e: { [K in Qualifier]?: boolean }, q: Qualifier, on: boolean): void {
  if (on) e[q] = true
  else delete e[q]
}

/** Set a qualifier of an attribute, keeping the others consistent: `mutable` excludes `static` and `const`. */
export function setAttributeQualifier(a: Attribute, q: Qualifier, on: boolean): void {
  setQualifier(a, q, on)
  if (!on) return
  if (q === 'mutable') for (const k of ['static', 'const'] as const) setQualifier(a, k, false)
  else if (q === 'static' || q === 'const') setQualifier(a, 'mutable', false)
}

/** Set the access level of a type, attribute or method; public is left out. */
export function setAccess(e: { access?: StoredAccess }, access: Access): void {
  if (access === 'public') delete e.access
  else e.access = access
}

/** UML mark of an access level: `+` public, `#` protected, `-` private. */
export const ACCESS_MARKS: Record<Access, string> = { public: '+', protected: '#', private: '-' }

/** Qualifiers that make a method virtual. */
const VIRTUAL_QUALIFIERS = ['pure', 'override', 'final'] as const

/**
 * Set a qualifier of a method, keeping the others consistent: `pure`, `override` and `final` imply
 * `virtual`, which excludes `static`; `pure` excludes `final`.
 */
export function setMethodQualifier(m: Method, q: Qualifier, on: boolean): void {
  setQualifier(m, q, on)
  if (!on) {
    if (q === 'virtual') for (const k of VIRTUAL_QUALIFIERS) setQualifier(m, k, false)
    return
  }
  if (q === 'static') for (const k of ['virtual', ...VIRTUAL_QUALIFIERS] as const) setQualifier(m, k, false)
  else if (q === 'virtual' || (VIRTUAL_QUALIFIERS as readonly Qualifier[]).includes(q)) {
    m.virtual = true
    setQualifier(m, 'static', false)
    if (q === 'pure') setQualifier(m, 'final', false)
    if (q === 'final') setQualifier(m, 'pure', false)
  }
}

/** Qualifiers of a method as drawn around its name and parameters: `virtual f(…) const override = 0`. */
export function methodQualifierText(m: Method): { before: string; after: string } {
  const before = [m.nodiscard && 'nodiscard', m.static ? 'static' : m.virtual && 'virtual']
  const after = [
    m.const && 'const',
    m.noexcept && 'noexcept',
    m.override && 'override',
    m.final && 'final',
    m.threadSafe && 'threadSafe'
  ]
  return {
    before: before
      .filter(Boolean)
      .map((k) => `${k} `)
      .join(''),
    after: `${after
      .filter(Boolean)
      .map((k) => ` ${k}`)
      .join('')}${m.pure ? ' = 0' : ''}`
  }
}

/**
 * A base of a module: one of this project, or a placed module of a dependency (whose own bases are
 * not known here).
 */
export type BaseModule = Module | ImportedModule

/** Module of this project, or placed module of a dependency, a module may derive from. */
export function baseModule(p: Pick<Project, 'modules' | 'dependencies'>, id: Id): BaseModule | undefined {
  return isImportedId(id) ? findImported(p, id)?.module : p.modules.find((m) => m.id === id)
}

/** Methods of a base (as last read for a placed module of a dependency). */
export const baseMethods = (b: BaseModule): Method[] => b.methods ?? []

/** Bases of a module, direct and indirect, nearest first; a base met twice (or a cycle) is listed once. */
export function ancestorModules(p: Project, id: Id): BaseModule[] {
  const seen = new Set<Id>([id])
  const out: BaseModule[] = []
  let level = [id]
  while (level.length) {
    const next: Id[] = []
    for (const cur of level)
      for (const b of p.modules.find((m) => m.id === cur)?.bases ?? []) {
        const base = baseModule(p, b)
        if (!base || seen.has(b)) continue
        seen.add(b)
        out.push(base)
        next.push(b)
      }
    level = next
  }
  return out
}

/** Whether making `baseId` a base of `id` keeps the inheritance acyclic. */
export function canDerive(p: Project, id: Id, baseId: Id): boolean {
  return baseId !== id && !ancestorModules(p, baseId).some((m) => m.id === id)
}

/** A type reference as text naming user types by id: equal for the same type. */
export const typeKey = (t: TypeRef): string =>
  printTypeExpr(mapTypeRef(t, (r) => ({ kind: 'ref', name: r.id })))

/** Parameters (direction, const, type), return type and const of a method, to compare overrides. */
export function methodSignature(m: Method): string {
  const type = typeKey
  const params = m.params.map((prm) => `${prm.direction} ${prm.const ? 'const ' : ''}${type(prm.type)}`)
  return `(${params.join(', ')})${m.returns ? type(m.returns) : ''}${m.const ? ' const' : ''}`
}

/** Parameter types (with directions) and const of a method: overloads of a name differ by it. */
export function overloadKey(m: Pick<Method, 'params' | 'const'>): string {
  const type = typeKey
  const params = m.params.map(
    (prm) => `${prm.direction === 'in' ? '' : `${prm.direction} `}${type(prm.type)}`
  )
  return `(${params.join(', ')})${m.const ? ' const' : ''}`
}

/** A method by name and overload key: `f(int32) const`. */
export const overloadName = (m: Method): string => `${m.name}${overloadKey(m)}`

/** The method of `methods` `m` overrides or redefines: same name and overload key. */
export const sameOverload = (methods: readonly Method[], m: Method): Method | undefined =>
  methods.find((x) => x.name === m.name && overloadKey(x) === overloadKey(m))

/**
 * Pure methods a module inherits and does not implement: those of its bases not defined (by name
 * and overload key) in itself or in a base nearer to it on the way.
 */
export function unimplementedMethods(p: Project, id: Id): { base: BaseModule; method: Method }[] {
  const out = new Map<string, { base: BaseModule; method: Method }>()
  /** Walks the bases of `cur`; `defined` holds the names defined on the way from the module. */
  const walk = (cur: BaseModule, defined: Set<string>, stack: Set<Id>): void => {
    for (const b of 'bases' in cur ? (cur.bases ?? []) : []) {
      const base = baseModule(p, b)
      if (!base || stack.has(b)) continue
      const methods = baseMethods(base)
      for (const x of methods) {
        const key = overloadName(x)
        if (x.pure && !defined.has(key) && !out.has(key)) out.set(key, { base, method: x })
      }
      const names = new Set([...defined, ...methods.filter((x) => !x.pure).map(overloadName)])
      walk(base, names, new Set([...stack, b]))
    }
  }
  const mod = p.modules.find((m) => m.id === id)
  if (mod) walk(mod, new Set(mod.methods.map(overloadName)), new Set([id]))
  return [...out.values()]
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) if (!set.has(`${base}${i}`)) return `${base}${i}`
}

/**
 * Names that must be unique together: user types, interfaces and constants share one namespace
 * (types of modules have their module's).
 */
export function globalTypeNames(p: Project, exceptId?: Id): string[] {
  return [...p.types.filter((t) => !isModuleType(t)), ...p.interfaces, ...p.consts]
    .filter((e) => e.id !== exceptId)
    .map((e) => e.name)
}

// Types of modules

/** Whether a type belongs to a module, of this project or of a dependency. */
export const isModuleType = (t: Scoped): boolean => !!t.module || !!t.modulePath

/** Types of a module of this project. */
export const moduleTypes = (p: Pick<Project, 'types'>, moduleId: Id): TypeDef[] =>
  p.types.filter((t) => t.module === moduleId)

/**
 * Names of the types as the file writes them, by id: `Name` for the project's and dependencies'
 * types, `Core.Sensor.Mode` for a type of module `Core.Sensor`, `Dep/Core.Sensor.Mode` for a type of a
 * module of dependency `Dep`.
 */
export function typeNames(p: Pick<Project, 'types' | 'modules' | 'dependencies'>): Map<Id, string> {
  const paths = modulePaths(p)
  const deps = new Map(p.dependencies.map((x) => [x.id, x.name]))
  return new Map(p.types.map((t) => [t.id, qualifiedTypeName(t, paths, deps)]))
}

function qualifiedTypeName(
  t: Scoped & { name: string; dependency?: Id },
  paths: ReadonlyMap<Id, string>,
  deps: ReadonlyMap<Id, string>
): string {
  if (t.module) return `${paths.get(t.module) ?? '?'}.${t.name}`
  if (t.modulePath) return `${deps.get(t.dependency ?? '') ?? '?'}/${t.modulePath}.${t.name}`
  return t.name
}

/** Name of a type as the file writes it (see `typeNames`). */
export function typeQualifiedName(p: Project, t: TypeDef): string {
  if (!isModuleType(t)) return t.name
  return qualifiedTypeName(t, modulePaths(p), new Map(p.dependencies.map((x) => [x.id, x.name])))
}

// Modules used as types: a reference to an instance of the module (a pointer or a reference for
// generators), with no value. A module of this project is referenced by its id, a module of a
// dependency by an id made of the dependency's and the module's path (`dependencyModuleRef`),
// placed here or not. The file writes their path: `Core.Sensor`, `Dep/Core.Sensor`.

const DEPENDENCY_MODULE_PREFIX = 'depmodule:'

/** Id standing for the module at `path` of dependency `dependency` in type references. */
export const dependencyModuleRef = (dependency: Id, path: string): Id =>
  `${DEPENDENCY_MODULE_PREFIX}${dependency}|${path}`

/** Dependency and module path of an id made by `dependencyModuleRef`. */
export function parseDependencyModuleRef(id: Id): { dependency: Id; path: string } | undefined {
  if (!id.startsWith(DEPENDENCY_MODULE_PREFIX)) return undefined
  const bar = id.lastIndexOf('|')
  return { dependency: id.slice(DEPENDENCY_MODULE_PREFIX.length, bar), path: id.slice(bar + 1) }
}

/** Whether a type reference names a module (of this project or of a dependency) rather than a type. */
export function isModuleRef(p: Pick<Project, 'modules'>, id: Id): boolean {
  return !!parseDependencyModuleRef(id) || p.modules.some((m) => m.id === id)
}

// Missing references: to a type, module or interface deleted while in use (or never defined in
// the file). They keep the name the file writes, and validation reports them until fixed.

const MISSING_PREFIX = 'missing:'

/** Id of a reference to a type, module or interface named `name` that the project does not have. */
export const missingRef = (name: string): Id => `${MISSING_PREFIX}${name}`

/** Name kept by an id made by `missingRef`. */
export const missingName = (id: Id): string | undefined =>
  id.startsWith(MISSING_PREFIX) ? id.slice(MISSING_PREFIX.length) : undefined

/**
 * Make the references to the types, modules and interfaces `nameOf` names (by id) missing ones:
 * type references, raised exceptions and port interfaces.
 */
export function orphanRefs(d: Project, nameOf: (id: Id) => string | undefined): void {
  const orphan = (id: Id): Id => {
    const name = nameOf(id)
    return name === undefined ? id : missingRef(name)
  }
  for (const { ref } of allTypeRefs(d))
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref') n.id = orphan(n.id)
    })
  const messages = [...d.interfaces.flatMap((i) => i.messages), ...d.modules.flatMap((m) => m.methods)]
  for (const m of messages) if (m.raises) m.raises = m.raises.map(orphan)
  for (const m of d.modules)
    for (const pt of m.ports) if (pt.interfaceId) pt.interfaceId = orphan(pt.interfaceId)
}

/** Whether the project has missing references (see `missingRef`). */
export function hasMissingRefs(p: Project): boolean {
  const missing = (id: Id | null | undefined): boolean => !!id && missingName(id) !== undefined
  if (p.modules.some((m) => m.ports.some((pt) => missing(pt.interfaceId)))) return true
  const messages = [...p.interfaces.flatMap((i) => i.messages), ...p.modules.flatMap((m) => m.methods)]
  if (messages.some((m) => m.raises?.some(missing))) return true
  for (const { ref } of allTypeRefs(p)) {
    let found = false
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && missing(n.id)) found = true
    })
    if (found) return true
  }
  return false
}

/** Point the missing references naming what the project has (again) at it: created or renamed since. */
export function resolveMissingRefs(d: Project): void {
  const resolve = refResolver(d)
  const interfaces = new Map(d.interfaces.map((i) => [i.name, i.id]))
  const found = (id: Id, lookup: (name: string) => Id | undefined): Id => {
    const name = missingName(id)
    return (name !== undefined && lookup(name)) || id
  }
  for (const { ref } of allTypeRefs(d))
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref') n.id = found(n.id, resolve)
    })
  for (const m of [...d.interfaces.flatMap((i) => i.messages), ...d.modules.flatMap((m) => m.methods)])
    m.raises?.forEach((id, i) => {
      m.raises![i] = found(id, resolve)
    })
  for (const m of d.modules)
    for (const pt of m.ports)
      if (pt.interfaceId) pt.interfaceId = found(pt.interfaceId, (n) => interfaces.get(n))
}

/**
 * Names type references write, by id: those of the types (see `typeNames`), the paths of the
 * modules, `Dep/Core.Sensor` for a module of a dependency, the name kept by a missing reference.
 * Undefined for a deleted one.
 */
export function refNamer(
  p: Pick<Project, 'types' | 'modules' | 'dependencies'>
): (id: Id) => string | undefined {
  const types = typeNames(p)
  const paths = modulePaths({ modules: p.modules, dependencies: [] })
  const deps = new Map(p.dependencies.map((x) => [x.id, x.name]))
  return (id) => {
    const name = types.get(id) ?? paths.get(id)
    if (name !== undefined) return name
    const ref = parseDependencyModuleRef(id)
    const dep = ref && deps.get(ref.dependency)
    return dep === undefined ? missingName(id) : `${dep}/${ref!.path}`
  }
}

/**
 * Id a name of a type reference stands for (`refNamer` reversed): a type first, else a module of
 * this project, else a module of an existing dependency (`Dep/Core.Sensor`, known here or not).
 */
export function refResolver(
  p: Pick<Project, 'types' | 'modules' | 'dependencies'>
): (name: string) => Id | undefined {
  const types = new Map([...typeNames(p)].map(([id, n]) => [n, id]))
  const modules = new Map(
    [...modulePaths({ modules: p.modules, dependencies: [] })].map(([id, n]) => [n, id])
  )
  const deps = new Map(p.dependencies.map((x) => [x.name, x.id]))
  return (name) => {
    const id = types.get(name) ?? modules.get(name)
    if (id !== undefined) return id
    const slash = name.indexOf('/')
    const dep = slash > 0 ? deps.get(name.slice(0, slash)) : undefined
    return dep === undefined ? undefined : dependencyModuleRef(dep, name.slice(slash + 1))
  }
}

/**
 * Modules of dependencies known here, as type references name them: those placed on the canvas,
 * those owning types and those already referenced.
 */
export function dependencyModuleRefs(p: Project): { id: Id; name: string }[] {
  const ids = new Set<Id>()
  for (const dep of p.dependencies) for (const m of dep.modules) ids.add(dependencyModuleRef(dep.id, m.path))
  for (const t of p.types)
    if (t.dependency && t.modulePath) ids.add(dependencyModuleRef(t.dependency, t.modulePath))
  for (const { ref } of allTypeRefs(p))
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && parseDependencyModuleRef(n.id)) ids.add(n.id)
    })
  const nameOf = refNamer(p)
  return [...ids].flatMap((id) => {
    const name = nameOf(id)
    return name === undefined ? [] : [{ id, name }]
  })
}

/**
 * Whether modules (`contextModuleId`; null: a type, interface or constant of the project) may use
 * a type: the project's, dependencies' and public ones of modules anywhere, the others of modules
 * in modules only, as their access allows (protected: the module and those deriving from it;
 * private: the module).
 */
export function canUseType(p: Project, contextModuleId: Id | null, t: TypeDef): boolean {
  if (!isModuleType(t) || !t.access) return true
  if (!contextModuleId || !t.module) return false
  if (t.module === contextModuleId) return true
  return t.access === 'protected' && ancestorModules(p, contextModuleId).some((m) => m.id === t.module)
}

/** Module whose scope a reference held by `owner` is in: null outside modules. */
export function refContext(p: Project, owner: UsageOwner): Id | null {
  if (owner.kind === 'module') return owner.id
  if (owner.kind === 'type') return p.types.find((t) => t.id === owner.id)?.module ?? null
  return null
}

export interface TypeScope {
  /** Name of a type written in this scope: its own name when it finds it, else its qualified name. */
  nameOf: (id: Id) => string | undefined
  /** Type a name written in this scope stands for. */
  idOf: (name: string) => Id | undefined
  /** Types this scope may use, with the name to write. */
  usable: { type: TypeDef; name: string }[]
  /** Modules usable as types (this project's, and those of dependencies known here), by path. */
  modules: { id: Id; name: string }[]
}

/**
 * Names of the types in a module (C++-like lookup: its own types, then those of its bases it may
 * use, then the project's and dependencies'; others by qualified name), or outside modules (null).
 * Modules are named by their path.
 */
export function typeScope(p: Project, contextModuleId: Id | null): TypeScope {
  const qualified = typeNames(p)
  const byQualified = new Map([...qualified].map(([id, n]) => [n, id]))
  const ownModules = [...modulePaths({ modules: p.modules, dependencies: [] })].map(([id, name]) => ({
    id,
    name
  }))
  const modules = [...ownModules, ...dependencyModuleRefs(p)].filter((m) => !byQualified.has(m.name))
  const moduleByName = new Map(modules.map((m) => [m.name, m.id]))
  const moduleName = new Map(modules.map((m) => [m.id, m.name]))
  const byId = new Map(p.types.map((t) => [t.id, t]))
  const local = new Map<string, Id>()
  if (contextModuleId)
    for (const m of [contextModuleId, ...ancestorModules(p, contextModuleId).map((a) => a.id)]) {
      // A placed module of a dependency: the types of that module (public ones).
      const placed = findImported(p, m)
      const owns = (t: TypeDef): boolean =>
        placed ? t.dependency === placed.dep.id && t.modulePath === placed.module.path : t.module === m
      for (const t of p.types)
        if (owns(t) && !local.has(t.name) && canUseType(p, contextModuleId, t)) local.set(t.name, t.id)
    }
  for (const t of p.types) if (!isModuleType(t) && !local.has(t.name)) local.set(t.name, t.id)
  const nameOf = (id: Id): string | undefined => {
    const t = byId.get(id)
    if (!t) return moduleName.get(id)
    return local.get(t.name) === id ? t.name : qualified.get(id)
  }
  return {
    nameOf,
    idOf: (name) => local.get(name) ?? byQualified.get(name) ?? moduleByName.get(name),
    usable: p.types
      .filter((t) => canUseType(p, contextModuleId, t))
      .map((t) => ({ type: t, name: nameOf(t.id)! })),
    modules
  }
}

export type NameTarget =
  | { kind: 'type'; id?: Id; module?: Id }
  | { kind: 'interface' | 'const'; id?: Id }
  | { kind: 'module'; id?: Id; parentId: Id | null }
  | { kind: 'port'; id?: Id; moduleId: Id }
  | { kind: 'other' }

/**
 * Check a name for an entity. Names referenced from other entities in the file
 * (types, interfaces, modules, ports) must be unique in their scope, so that
 * the file can always be reloaded.
 */
export function nameError(p: Project, target: NameTarget, name: string): string | null {
  if (!IDENTIFIER_RE.test(name))
    return 'Must be an identifier: letters, digits, _ (not starting with a digit)'
  switch (target.kind) {
    case 'type':
    case 'interface':
    case 'const':
      if (isReservedTypeName(name)) return `'${name}' is a reserved type name`
      if (target.kind === 'type' && target.module)
        return moduleTypeNameError(p, target.module, name, target.id)
      if (globalTypeNames(p, target.id).includes(name))
        return `A type, interface or constant named '${name}' already exists`
      // Type references name top-level modules as types.
      if (childModules(p, null).some((m) => m.name === name)) return `A module named '${name}' already exists`
      return null
    case 'module':
      if (childModules(p, target.parentId).some((m) => m.id !== target.id && m.name === name))
        return `A sibling module named '${name}' already exists`
      if (!target.parentId && globalTypeNames(p).includes(name))
        return `A type, interface or constant named '${name}' already exists`
      return null
    case 'port': {
      const mod = p.modules.find((m) => m.id === target.moduleId)
      if (mod?.ports.some((pt) => pt.id !== target.id && pt.name === name))
        return `This module already has a port named '${name}'`
      return null
    }
    default:
      return null
  }
}

/** Check the name of a type of a module: unique among its types, members and submodules. */
function moduleTypeNameError(p: Project, moduleId: Id, name: string, exceptId?: Id): string | null {
  const mod = p.modules.find((m) => m.id === moduleId)
  if (moduleTypes(p, moduleId).some((t) => t.id !== exceptId && t.name === name))
    return `This module already has a type named '${name}'`
  if (mod && memberNames(p, mod).includes(name))
    return `This module already has an attribute, method, port or submodule named '${name}'`
  return null
}

/** Names of a module's attributes, methods, ports and submodules: its types take none of them. */
export function memberNames(p: Project, m: Module): string[] {
  return [
    ...m.attributes.map((a) => a.name),
    ...m.methods.map((x) => x.name),
    ...m.ports.map((pt) => pt.name),
    ...childModules(p, m.id).map((c) => c.name)
  ]
}

/** Check the name of a custom transport (`except`: its index when renamed). */
export function transportError(p: Project, name: string, except?: number): string | null {
  if (!name.trim()) return 'Must not be empty'
  if ((TRANSPORTS as readonly string[]).includes(name)) return 'Built-in transport'
  if (p.transports.some((t, i) => i !== except && t === name)) return 'Name already used'
  return null
}

/** Check the name of a binary (`except`: its id when renamed). */
export function binaryError(p: Project, name: string, except?: Id): string | null {
  if (!IDENTIFIER_RE.test(name)) return 'Must be an identifier'
  if (p.binaries.some((b) => b.id !== except && b.name === name)) return 'Name already used'
  return null
}

export interface UsageOwner {
  kind: 'type' | 'interface' | 'const' | 'module'
  id: Id
}

/**
 * Every type reference in the project, with a label of where it is used, the entity holding it and,
 * in modules, the access of the member or type holding it.
 */
export function* allTypeRefs(
  p: Project
): Generator<{ ref: TypeRef; where: string; owner: UsageOwner; raised?: boolean; access?: Access }> {
  const names = typeNames(p)
  for (const t of p.types) {
    const owner = { kind: 'type', id: t.id } as const
    const name = names.get(t.id)!
    const access = isModuleType(t) ? (t.access ?? 'public') : undefined
    if (t.kind === 'struct' || t.kind === 'exception')
      for (const f of t.fields) yield { ref: f.type, where: `${name}.${f.name}`, owner, access }
    if (t.kind === 'alias') yield { ref: t.type, where: name, owner, access }
    if (t.kind === 'union') {
      yield { ref: t.discriminator, where: `${name} discriminator`, owner, access }
      for (const c of t.cases) yield { ref: c.type, where: `${name}.${c.name}`, owner, access }
    }
  }
  for (const c of p.consts) yield { ref: c.type, where: c.name, owner: { kind: 'const', id: c.id } }
  for (const i of p.interfaces) {
    const owner = { kind: 'interface', id: i.id } as const
    for (const m of i.messages) {
      for (const prm of m.params) yield { ref: prm.type, where: `${i.name}.${m.name}(${prm.name})`, owner }
      if (m.returns) yield { ref: m.returns, where: `${i.name}.${m.name} returns`, owner }
      for (const id of m.raises ?? [])
        yield { ref: { kind: 'ref', id }, where: `${i.name}.${m.name} raises`, owner, raised: true }
    }
  }
  for (const m of p.modules) {
    const owner = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    for (const a of m.attributes)
      yield { ref: a.type, where: `${path}.${a.name}`, owner, access: a.access ?? 'public' }
    for (const x of m.methods) {
      const access = x.access ?? 'public'
      for (const prm of x.params)
        yield { ref: prm.type, where: `${path}.${x.name}(${prm.name})`, owner, access }
      if (x.returns) yield { ref: x.returns, where: `${path}.${x.name} returns`, owner, access }
      for (const id of x.raises ?? [])
        yield { ref: { kind: 'ref', id }, where: `${path}.${x.name} raises`, owner, raised: true, access }
    }
  }
}

/** Places using a type, with the entity holding each reference. */
export function typeUsageTargets(p: Project, typeId: Id): { where: string; owner: UsageOwner }[] {
  const out: { where: string; owner: UsageOwner }[] = []
  for (const { ref, where, owner } of allTypeRefs(p)) {
    let used = false
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && n.id === typeId) used = true
    })
    if (used) out.push({ where, owner })
  }
  return out
}

export function typeUsages(p: Project, typeId: Id): string[] {
  return typeUsageTargets(p, typeId).map((u) => u.where)
}

// Views

function globalView(): View {
  return { id: GLOBAL_VIEW, name: 'Project', rootModuleId: null, hidden: [] }
}

const ISOLATED = 'isolate:'
const NO_HIDDEN: Id[] = Object.freeze([]) as unknown as Id[]

/** Id of the temporary view showing a module with its content (not stored in the project). */
export function isolatedViewId(moduleId: Id): Id {
  return ISOLATED + moduleId
}

/** Module shown by a temporary view id, else null. */
export function isolatedModuleId(viewId: Id): Id | null {
  return viewId.startsWith(ISOLATED) ? viewId.slice(ISOLATED.length) : null
}

/**
 * The view with this id (a temporary view resolved from its module, or placed module of a
 * dependency); the global view for an unknown id.
 */
export function findView(p: Pick<Project, 'views' | 'modules' | 'dependencies'>, viewId: Id): View {
  const stored = p.views.find((v) => v.id === viewId)
  if (stored) return stored
  const moduleId = isolatedModuleId(viewId)
  const m = moduleId ? p.modules.find((m) => m.id === moduleId) : undefined
  if (m) return { id: viewId, name: m.name, rootModuleId: m.id, hidden: NO_HIDDEN, temporary: true }
  const im = moduleId ? findImported(p, moduleId)?.module : undefined
  if (im)
    return {
      id: viewId,
      name: im.path.split('.').pop()!,
      rootModuleId: im.id,
      hidden: NO_HIDDEN,
      temporary: true
    }
  return globalView()
}

/** Whether a temporary view can be stored in the project: not the view of a placed module of a dependency. */
export const canKeepView = (view: View): boolean =>
  !!view.temporary && !(view.rootModuleId && isImportedId(view.rootModuleId))

/** Whether the view can be shown: the global view, a stored view, or a temporary view of a module. */
export function viewExists(p: Pick<Project, 'views' | 'modules' | 'dependencies'>, viewId: Id): boolean {
  return viewId === GLOBAL_VIEW || findView(p, viewId).id === viewId
}

/** Notes drawn in a view: a drill-down view's own, else those of the whole project. */
export function viewNotes(p: Project, view: View): Note[] {
  return p.notes.filter((n) => (view.rootModuleId ? n.viewId === view.id : !n.viewId))
}

/** Place of a note in the project file: `editor.notes[i]`, or `editor.views[j].notes[i]` for a drill-down view's. */
export function notePath(p: Project, id: Id): (string | number)[] | null {
  const n = p.notes.find((n) => n.id === id)
  if (!n) return null
  const i = p.notes.filter((x) => x.viewId === n.viewId).indexOf(n)
  if (!n.viewId) return ['editor', 'notes', i]
  const j = p.views.findIndex((v) => v.id === n.viewId)
  return j < 0 ? null : ['editor', 'views', j, 'notes', i]
}

/** The note at a place of the project file (see notePath). */
export function noteAtPath(p: Project, path: readonly (string | number)[]): Note | undefined {
  const [, section, a, , b] = path
  if (section === 'notes' && typeof a === 'number') return p.notes.filter((n) => !n.viewId)[a]
  if (section !== 'views' || typeof a !== 'number' || path[3] !== 'notes' || typeof b !== 'number')
    return undefined
  const view = p.views[a]
  return view && p.notes.filter((n) => n.viewId === view.id)[b]
}

/** Ids of a placed module of a dependency and of the placed modules inside it. */
export function importedSubtreeIds(p: Pick<Project, 'dependencies'>, id: Id): Set<Id> {
  const found = findImported(p, id)
  if (!found) return new Set()
  const prefix = `${found.module.path}.`
  return new Set([id, ...found.dep.modules.filter((m) => m.path.startsWith(prefix)).map((m) => m.id)])
}

/** Ids of the modules a view rooted at `rootId` is about: the module (local or placed) and its content. */
export function viewScopeIds(p: Project, rootId: Id): Set<Id> {
  return isImportedId(rootId) ? importedSubtreeIds(p, rootId) : subtreeIds(p, rootId)
}

/** Ids of the modules drawn in a view: the root's subtree (or everything) minus hidden subtrees. */
export function visibleModuleIds(p: Project, view: View): Set<Id> {
  // Placed modules of dependencies are drawn in the global view and in their own.
  const scope = view.rootModuleId
    ? viewScopeIds(p, view.rootModuleId)
    : new Set([...p.modules, ...allImported(p)].map((m) => m.id))
  for (const h of view.hidden)
    if (h !== view.rootModuleId) for (const id of subtreeIds(p, h)) scope.delete(id)
  return scope
}

/**
 * Drop view references to deleted modules, ports and links; views rooted in a deleted module go
 * away, with their notes.
 */
export function pruneViews(p: Project): void {
  const ids = new Set(p.modules.map((m) => m.id))
  const placed = p.dependencies.flatMap((x) => x.modules)
  // Placed modules of dependencies can be outside a view, hidden in it, with port name sides.
  const anyIds = new Set([...ids, ...placed.map((m) => m.id)])
  const portIds = new Set([...p.modules, ...placed].flatMap((m) => m.ports.map((pt) => pt.id)))
  const linkIds = new Set(p.links.map((l) => l.id))
  p.views = p.views.filter((v) => !v.rootModuleId || ids.has(v.rootModuleId))
  const viewIds = new Set(p.views.map((v) => v.id))
  if (p.notes.some((n) => n.viewId && !viewIds.has(n.viewId)))
    p.notes = p.notes.filter((n) => !n.viewId || viewIds.has(n.viewId))
  for (const v of p.views) {
    v.hidden = v.hidden.filter((h) => anyIds.has(h))
    for (const [key, kept] of [
      ['layouts', ids],
      ['standIns', anyIds],
      ['portLabels', portIds],
      ['routes', linkIds]
    ] as const) {
      const own = v[key]
      if (!own) continue
      for (const id of Object.keys(own)) if (!kept.has(id)) delete own[id]
      if (!Object.keys(own).length) delete v[key]
    }
  }
}

/** Bounding box of rects. */
export function boundsOf(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** Absolute rect of a module. */
export function absoluteRect(p: Project, id: Id): Rect {
  const imported = findImported(p, id)
  if (imported) return { ...absolutePosition(p, id), ...importedSize(imported.module, p.orientation) }
  const m = p.modules.find((m) => m.id === id)
  const { x, y } = absolutePosition(p, id)
  return { x, y, width: m?.layout.width ?? 0, height: m?.layout.height ?? 0 }
}
