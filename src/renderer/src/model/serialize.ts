// In-memory project <-> file format (qualified names), YAML/JSON text.
import YAML, { LineCounter, YAMLParseError, isMap, isScalar, isSeq, type Node as YamlNode } from 'yaml'
import {
  FileProjectSchema,
  SCHEMA_VERSION,
  type FileAttribute,
  type FileConstant,
  type FileConstructor,
  type FileEditor,
  type FileInterface,
  type FileMessage,
  type FileMethod,
  type FileModule,
  type FileModuleTypeDef,
  type FileProject,
  type FileTypeDef
} from './schema'
import { safeIntegers } from './defaults'
import { mapTypeRef, parseTypeExpr, printTypeExpr } from './typeExpr'
import { pair } from './reuse'
import {
  childModules,
  compartmentsHeight,
  dependencyModuleRef,
  findImported,
  isModuleType,
  IMPORTED_PREFIX,
  leafHeight,
  MODULE_WIDTH,
  modulePath,
  missingName,
  missingRef,
  modulePaths,
  moduleTypes,
  newId,
  portRows,
  refNamer,
  subtreeIds,
  typeNames,
  viewNotes
} from './project'
import {
  ALL_QUALIFIERS,
  type Access,
  type Attribute,
  type Binary,
  type ConstDef,
  type Constraints,
  type Constructor,
  type Destructor,
  type Field,
  type Id,
  type Dependency,
  type ImportedModule,
  type Interface,
  type Link,
  type LinkRoute,
  type Lock,
  type Message,
  type Metadata,
  type Method,
  type Module,
  type Note,
  type Ownership,
  type Param,
  type Qualifier,
  type Project,
  type Rect,
  type Side,
  type StoredAccess,
  type TypeDef,
  type TypeRef,
  type Value,
  type ValueField,
  type View
} from './types'
import type { FileTypeRef } from './schema'

export type Format = 'yaml' | 'json'

/** Where a problem is: its path in the file data, and its line (from 1) once found in the text. */
export interface LoadIssue {
  message: string
  path?: (string | number)[]
  line?: number
}

export class LoadError extends Error {
  readonly issues: LoadIssue[]
  /** Messages, prefixed with their line when known. */
  readonly problems: string[]
  constructor(issues: (string | LoadIssue)[]) {
    const all = issues.map((i) => (typeof i === 'string' ? { message: i } : i))
    const problems = all.map((i) => (i.line ? `Line ${i.line}: ${i.message}` : i.message))
    super(problems.join('\n'))
    this.issues = all
    this.problems = problems
  }
}

type DataPath = (string | number)[]

const opt = (s: string): string | undefined => (s ? s : undefined)
/** Qualifiers of `q` that are set, the others left out. */
const qualifiers = (q: { [K in Qualifier]?: boolean }): { [K in Qualifier]?: true } =>
  Object.fromEntries(ALL_QUALIFIERS.filter((k) => q[k]).map((k) => [k, true]))
/** Access level of `x` when not public. */
const access = (x: { access?: Access }): { access?: StoredAccess } =>
  x.access === 'protected' || x.access === 'private' ? { access: x.access } : {}
const optMeta = (m: Metadata): Metadata | undefined => (Object.keys(m).length ? { ...m } : undefined)
/** Name placements of the ports that have one, by port name. */
const portLabels = (ports: { name: string; label?: Side }[]): Record<string, Side> | undefined => {
  const set = ports.filter((pt) => pt.label)
  return set.length ? Object.fromEntries(set.map((pt) => [pt.name, pt.label!])) : undefined
}

/** File entry of a link shape. */
const routeEntry = (r: LinkRoute) => ({
  points: r.points.length ? r.points.map((pt) => ({ ...pt })) : undefined,
  from: r.from && { ...r.from },
  to: r.to && { ...r.to },
  label: r.label
})

/** Link shapes of a drill-down view, by link name. */
function viewRoutes(p: Project, v: View) {
  if (!v.rootModuleId || !v.routes) return undefined
  const entries = p.links.flatMap((l) =>
    v.routes![l.id] ? [[l.name, routeEntry(v.routes![l.id]!)] as const] : []
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Places and sizes of the stand-ins of a drill-down view, by module path. */
function viewStandIns(p: Project, v: View): View['standIns'] {
  if (!v.rootModuleId || !v.standIns) return undefined
  const own = v.standIns
  const entries = [...modulePaths(p)].flatMap(([id, path]) => {
    const at = own[id]
    return at ? [[path, { ...at }] as const] : []
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Port name sides of a drill-down view, by module path and port name. */
function viewPortLabels(p: Project, v: View): Record<string, Record<string, Side>> | undefined {
  if (!v.rootModuleId || !v.portLabels) return undefined
  const own = v.portLabels
  const entries = [...p.modules, ...p.dependencies.flatMap((x) => x.modules)].flatMap((m) => {
    const labels = portLabels(m.ports.map((pt) => ({ name: pt.name, label: own[pt.id] })))
    return labels ? [[modulePath(p, m.id), labels] as const] : []
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

const noteEntry = (n: Note) => ({
  kind: n.kind,
  text: n.text,
  ...n.layout,
  color: n.color,
  locked: n.locked || undefined
})

/** Own rects of a drill-down view, by module path: those of the modules in its root's subtree. */
function viewLayouts(p: Project, v: View): Record<string, Rect> | undefined {
  if (!v.rootModuleId || !v.layouts) return undefined
  const inside = subtreeIds(p, v.rootModuleId)
  const entries = Object.entries(v.layouts).filter(([id]) => inside.has(id))
  return entries.length
    ? Object.fromEntries(entries.map(([id, r]) => [modulePath(p, id), { ...r }]))
    : undefined
}

/** Drop keys whose value is undefined so the output stays clean. */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function toFile(p: Project, options: { editor: boolean }): FileProject {
  const typeName = new Map<Id, string>([...typeNames(p), ...p.interfaces.map((i) => [i.id, i.name] as const)])
  const refName = refNamer(p)
  const ref = (t: TypeRef): FileTypeRef =>
    mapTypeRef(t, (r) => ({ kind: 'ref', name: refName(r.id) ?? '__deleted__' }))
  const field = (f: Field) => ({ name: f.name, type: ref(f.type), description: opt(f.description) })
  const valueField = (f: ValueField) => ({
    ...field(f),
    default: f.default,
    constraints: f.constraints && Object.keys(f.constraints).length ? { ...f.constraints } : undefined,
    ownership: f.ownership
  })
  const param = (prm: Param) => ({
    ...field(prm),
    direction: prm.direction === 'in' ? undefined : prm.direction
  })
  const raises = (m: Message) =>
    m.raises?.length ? m.raises.map((id) => typeName.get(id) ?? missingName(id) ?? '__deleted__') : undefined
  const message = (m: Message) => ({
    name: m.name,
    description: opt(m.description),
    params: m.params.map(param),
    returns: m.returns ? ref(m.returns) : null,
    raises: raises(m)
  })
  /** An attribute; `locks`: those of its module, which `guardedBy` names. */
  const attribute = (a: Attribute, locks: readonly Lock[] = []) => {
    const { name, ...rest } = valueField(a)
    return {
      name,
      ...access(a),
      ...qualifiers(a),
      ...rest,
      accessors: a.accessors,
      guardedBy: a.guardedBy ? locks.find((l) => l.id === a.guardedBy)?.name : undefined
    }
  }
  const methodParams = (m: Pick<Method, 'params'>) =>
    m.params.map((prm) => ({ ...param(prm), ...qualifiers(prm), default: prm.default }))
  const method = (m: Method) => ({
    name: m.name,
    description: opt(m.description),
    ...access(m),
    ...qualifiers(m),
    params: methodParams(m),
    returns: m.returns ? ref(m.returns) : null,
    raises: raises(m),
    pre: m.pre?.length ? [...m.pre] : undefined,
    post: m.post?.length ? [...m.post] : undefined
  })
  const constructor = (c: Constructor) => ({
    description: opt(c.description),
    ...access(c),
    explicit: c.explicit || undefined,
    defaulted: c.defaulted || undefined,
    deleted: c.deleted || undefined,
    params: methodParams(c)
  })
  const destructor = (d: Destructor) => ({ ...access(d), virtual: d.virtual })

  const typeDef = (t: TypeDef): FileTypeDef => {
    switch (t.kind) {
      case 'struct':
        return {
          kind: 'struct',
          name: t.name,
          description: opt(t.description),
          fields: t.fields.map(valueField)
        }
      case 'enum':
        return {
          kind: 'enum',
          name: t.name,
          description: opt(t.description),
          underlying: t.underlying,
          values: t.values.map((v) => ({ name: v.name, value: v.value }))
        }
      case 'exception':
        return {
          kind: 'exception',
          name: t.name,
          description: opt(t.description),
          fields: t.fields.map(valueField)
        }
      case 'bitmask':
        return {
          kind: 'bitmask',
          name: t.name,
          description: opt(t.description),
          underlying: t.underlying,
          flags: t.flags.map((v) => ({ name: v.name, bit: v.bit }))
        }
      case 'union':
        return {
          kind: 'union',
          name: t.name,
          description: opt(t.description),
          discriminator: ref(t.discriminator),
          cases: t.cases.map((c) => ({
            ...field(c),
            ...(c.labels.length ? { labels: c.labels as (number | string | boolean)[] } : {}),
            ...(c.isDefault ? { default: true } : {})
          }))
        }
      case 'alias':
        return { kind: 'alias', name: t.name, description: opt(t.description), type: ref(t.type) }
      case 'primitive':
        return { kind: 'primitive', name: t.name, description: opt(t.description) }
    }
  }
  /** A type of a module, with its access. */
  const moduleTypeDef = (t: TypeDef): FileModuleTypeDef => {
    const { kind, name, ...rest } = typeDef(t)
    return { kind, name, ...access(t), ...rest } as FileModuleTypeDef
  }
  const iface = (i: Interface) => ({
    name: i.name,
    description: opt(i.description),
    messages: i.messages.map(message)
  })
  const constant = (c: ConstDef) => ({
    name: c.name,
    description: opt(c.description),
    type: ref(c.type),
    value: c.value
  })
  const owned = (dependency: Id | undefined) => {
    const consts = p.consts.filter((c) => c.dependency === dependency)
    return {
      types: p.types.filter((t) => t.dependency === dependency && !isModuleType(t)).map(typeDef),
      interfaces: p.interfaces.filter((i) => i.dependency === dependency).map(iface),
      constants: consts.length ? consts.map(constant) : undefined
    }
  }

  /** Types of the modules of a dependency, by module path in the order of the types. */
  const dependencyModuleTypes = (dependency: Id) => {
    const byModule = new Map<string, FileModuleTypeDef[]>()
    for (const t of p.types)
      if (t.dependency === dependency && t.modulePath) {
        const list = byModule.get(t.modulePath) ?? []
        if (!list.length) byModule.set(t.modulePath, list)
        list.push(moduleTypeDef(t))
      }
    return byModule.size ? [...byModule].map(([module, types]) => ({ module, types })) : undefined
  }

  const binaryName = new Map(p.binaries.map((b) => [b.id, b.name]))
  const moduleTree = (parentId: Id | null): FileModule[] =>
    childModules(p, parentId).map((m) => {
      const children = moduleTree(m.id)
      const all = moduleTypes(p, m.id)
      const params = all.filter((t) => t.kind === 'primitive' && t.typeParam)
      const types = all.filter((t) => !params.includes(t))
      const baseName = (b: Id): string => {
        const args = m.baseArgs?.[b]
        return `${modulePath(p, b)}${args?.length ? `<${args.map((a) => printTypeExpr(ref(a))).join(', ')}>` : ''}`
      }
      return {
        name: m.name,
        description: opt(m.description),
        kind: m.kind,
        typeParams: params.length
          ? params.map((t) => {
              const tp = (t.kind === 'primitive' && t.typeParam) || {}
              return {
                name: t.name,
                description: opt(t.description),
                constraint: tp.constraint,
                derivesFrom: tp.derivesFrom && modulePath(p, tp.derivesFrom),
                default: tp.default && ref(tp.default)
              }
            })
          : undefined,
        bases: m.bases?.length ? m.bases.map(baseName) : undefined,
        final: m.final || undefined,
        instantiation: m.instantiation,
        copy: m.copy,
        move: m.move,
        locks: m.locks?.length ? m.locks.map((l) => ({ name: l.name, kind: l.kind })) : undefined,
        invariants: m.invariants?.length ? [...m.invariants] : undefined,
        metadata: optMeta(m.metadata),
        color: m.color,
        binary: m.binaryId ? binaryName.get(m.binaryId) : undefined,
        types: types.length ? types.map(moduleTypeDef) : undefined,
        attributes: m.attributes.length ? m.attributes.map((a) => attribute(a, m.locks)) : undefined,
        constructors: m.constructors?.length ? m.constructors.map(constructor) : undefined,
        destructor: m.destructor && destructor(m.destructor),
        methods: m.methods.length ? m.methods.map(method) : undefined,
        ports: m.ports.map((pt) => ({
          name: pt.name,
          role: pt.role,
          interface: pt.interfaceId
            ? (typeName.get(pt.interfaceId) ?? missingName(pt.interfaceId) ?? null)
            : null,
          description: opt(pt.description)
        })),
        modules: children.length ? children : undefined
      }
    })

  const endpoint = (e: { moduleId: Id; portId: Id }) => {
    const imported = findImported(p, e.moduleId)
    if (imported)
      return {
        project: imported.dep.name,
        module: imported.module.path,
        port: imported.module.ports.find((pt) => pt.id === e.portId)?.name ?? ''
      }
    return {
      module: modulePath(p, e.moduleId),
      port: p.modules.find((m) => m.id === e.moduleId)?.ports.find((pt) => pt.id === e.portId)?.name ?? ''
    }
  }

  const file: FileProject = {
    schemaVersion: SCHEMA_VERSION,
    project: { name: p.name, description: opt(p.description), metadata: optMeta(p.metadata) },
    transports: p.transports.length ? [...p.transports] : undefined,
    remoteDefaults:
      p.remoteDefaults && Object.keys(p.remoteDefaults).length ? clean(p.remoteDefaults) : undefined,
    binaries: p.binaries.length
      ? p.binaries.map((b) => ({ name: b.name, description: opt(b.description), color: b.color }))
      : undefined,
    ...owned(undefined),
    modules: moduleTree(null),
    links: p.links.map((l) => ({
      name: l.name,
      description: opt(l.description),
      from: endpoint(l.from),
      to: endpoint(l.to),
      constraints: l.constraints
    })),
    dependencies: p.dependencies.length
      ? p.dependencies.map((x) => ({
          name: x.name,
          file: x.file,
          uses: x.uses.length ? [...x.uses] : undefined,
          indirect: x.indirect || undefined,
          shared: x.shared.length ? [...x.shared] : undefined,
          ...owned(x.id),
          moduleTypes: dependencyModuleTypes(x.id),
          modules: x.modules.length
            ? x.modules.map((m) => ({
                module: m.path,
                final: m.final || undefined,
                attributes: m.attributes?.length ? m.attributes.map((a) => attribute(a)) : undefined,
                methods: m.methods?.length ? m.methods.map(method) : undefined,
                ports: m.ports.map((pt) => ({
                  name: pt.name,
                  role: pt.role,
                  interface: pt.interface,
                  description: opt(pt.description)
                }))
              }))
            : undefined
        }))
      : undefined
  }
  if (options.editor) {
    const editor: FileEditor = {
      layout: Object.fromEntries(p.modules.map((m) => [modulePath(p, m.id), { ...m.layout }]))
    }
    if (p.views.length)
      editor.views = p.views.map((v) => ({
        name: v.name,
        root: v.rootModuleId ? modulePath(p, v.rootModuleId) : undefined,
        hidden: v.hidden.length ? v.hidden.map((h) => modulePath(p, h)) : undefined,
        layout: viewLayouts(p, v),
        links: viewRoutes(p, v),
        labels: viewPortLabels(p, v),
        outside: viewStandIns(p, v),
        notes: v.rootModuleId && viewNotes(p, v).length ? viewNotes(p, v).map(noteEntry) : undefined
      }))
    const styled = p.modules.filter((m) => m.locked || portLabels(m.ports))
    if (styled.length)
      editor.style = Object.fromEntries(
        styled.map((m) => [
          modulePath(p, m.id),
          { locked: m.locked || undefined, labels: portLabels(m.ports) }
        ])
      )
    if (p.dependencies.some((x) => x.modules.length))
      editor.dependencies = Object.fromEntries(
        p.dependencies
          .filter((x) => x.modules.length)
          .map((x) => [
            x.name,
            Object.fromEntries(
              x.modules.map((m) => [
                m.path,
                { ...m.position, ...m.size, locked: m.locked || undefined, labels: portLabels(m.ports) }
              ])
            )
          ])
      )
    if (p.orientation !== 'horizontal') editor.orientation = p.orientation
    const routed = p.links.filter((l) => l.route)
    if (routed.length) editor.links = Object.fromEntries(routed.map((l) => [l.name, routeEntry(l.route!)]))
    const notes = p.notes.filter((n) => !n.viewId)
    if (notes.length) editor.notes = notes.map(noteEntry)
    file.editor = editor
  }
  return clean(file)
}

/**
 * Project of a file. With `prev`, a previous state of the project, its entities keep their ids and
 * their editor data when the file has none for them (added to the text or renamed in it).
 */
export function fromFile(data: unknown, prev?: Project): Project {
  const parsed = FileProjectSchema.safeParse(data)
  if (!parsed.success) {
    throw new LoadError(
      parsed.error.issues.map((i) => ({
        message: `${i.path.join('.') || '<root>'}: ${i.message}`,
        path: i.path.filter((k) => typeof k !== 'symbol')
      }))
    )
  }
  const f = parsed.data
  const problems: LoadIssue[] = []
  const report = (message: string, path: DataPath): void => void problems.push({ message, path })

  // Ids derived from names are stable across loads, so that open editors survive a page reload.
  // Next to kept ids they could clash: new entities then get a fresh one.
  const idOf = (was: { id: Id } | undefined, derived: () => Id): Id => was?.id ?? (prev ? newId() : derived())
  /** Previous entity of each named one of `list`. */
  const named = <T extends { name: string }>(
    before: readonly T[] | undefined,
    list: readonly { name: string }[]
  ): (T | undefined)[] =>
    pair(
      before ?? [],
      (e) => e.name,
      list.map((e) => e.name)
    )

  const fileBinaries = f.binaries ?? []
  const prevBinaries = named(prev?.binaries, fileBinaries)
  const binaryIds = new Map<string, Id>()
  const binaries: Binary[] = fileBinaries.map((b, i) => {
    if (binaryIds.has(b.name)) report(`Duplicate binary '${b.name}'`, ['binaries', i, 'name'])
    const id = idOf(prevBinaries[i], () => `binary:${b.name}`)
    binaryIds.set(b.name, id)
    return { id, name: b.name, description: b.description ?? '', ...(b.color ? { color: b.color } : {}) }
  })

  // Types and interfaces share one namespace.
  const typeIds = new Map<string, Id>()
  const declare = (
    name: string,
    what: 'type' | 'interface',
    was: { id: Id } | undefined,
    at: DataPath
  ): Id => {
    if (typeIds.has(name)) report(`Duplicate ${what} name '${name}'`, at)
    const id = idOf(was, () => `${what}:${name}`)
    typeIds.set(name, id)
    return id
  }
  // Dependencies: their types and interfaces follow the project's own ones, in the same namespace.
  const fileDependencies = f.dependencies ?? []
  const prevDependencies = named(prev?.dependencies, fileDependencies)
  const dependencyNames = new Set<string>()
  const dependencyIds = fileDependencies.map((x, i) => {
    if (dependencyNames.has(x.name)) report(`Duplicate dependency '${x.name}'`, ['dependencies', i, 'name'])
    dependencyNames.add(x.name)
    return idOf(prevDependencies[i], () => `dependency:${x.name}`)
  })
  fileDependencies.forEach((x, i) =>
    (x.uses ?? []).forEach((u, j) => {
      if (!dependencyNames.has(u))
        report(`Dependency '${x.name}' uses unknown dependency '${u}'`, ['dependencies', i, 'uses', j])
    })
  )
  /** Entries of the file with their owner dependency and their path in the file data. */
  interface Entry<T> {
    e: T
    at: DataPath
    dependency?: Id
  }
  /** A type, with its name as the file writes it (`key`) and the path of the module owning it. */
  interface TypeEntry extends Entry<FileTypeDef | FileModuleTypeDef> {
    key: string
    /** Path of the module of this project owning it. */
    module?: string
    /** Path of the module of its dependency owning it. */
    modulePath?: string
    /** A type parameter of its module, as written in the file. */
    param?: NonNullable<FileModule['typeParams']>[number]
  }
  const ownModuleTypes = (list: FileModule[], parentPath: string, at: DataPath): TypeEntry[] =>
    list.flatMap((fm, i) => {
      const path = parentPath ? `${parentPath}.${fm.name}` : fm.name
      return [
        // Type parameters: private types of the module, named `Module.Path.T` in the file.
        ...(fm.typeParams ?? []).map((tp, j): TypeEntry => ({
          e: { kind: 'primitive', name: tp.name, description: tp.description, access: 'private' },
          at: [...at, i, 'typeParams', j],
          key: `${path}.${tp.name}`,
          module: path,
          param: tp
        })),
        ...(fm.types ?? []).map((e, j) => ({
          e,
          at: [...at, i, 'types', j],
          key: `${path}.${e.name}`,
          module: path
        })),
        ...ownModuleTypes(fm.modules ?? [], path, [...at, i, 'modules'])
      ]
    })
  const typeEntries: TypeEntry[] = [
    ...f.types.map((e, i) => ({ e, at: ['types', i], key: e.name })),
    ...ownModuleTypes(f.modules, '', ['modules']),
    ...fileDependencies.flatMap((x, xi) => [
      ...x.types.map((e, i) => ({
        e,
        at: ['dependencies', xi, 'types', i],
        key: e.name,
        dependency: dependencyIds[xi]!
      })),
      ...(x.moduleTypes ?? []).flatMap((g, gi) =>
        g.types.map((e, i) => ({
          e,
          at: ['dependencies', xi, 'moduleTypes', gi, 'types', i],
          key: `${x.name}/${g.module}.${e.name}`,
          dependency: dependencyIds[xi]!,
          modulePath: g.module
        }))
      )
    ])
  ]
  const interfaceEntries: Entry<FileInterface>[] = [
    ...f.interfaces.map((e, i) => ({ e, at: ['interfaces', i] })),
    ...fileDependencies.flatMap((x, xi) =>
      x.interfaces.map((e, i) => ({
        e,
        at: ['dependencies', xi, 'interfaces', i],
        dependency: dependencyIds[xi]!
      }))
    )
  ]
  const owner = (dependency: Id | undefined) => (dependency ? { dependency } : {})

  const prevTypeNames = prev ? typeNames(prev) : new Map<Id, string>()
  const prevTypes = pair(
    prev?.types ?? [],
    (t) => prevTypeNames.get(t.id)!,
    typeEntries.map((x) => x.key)
  )
  const prevInterfaces = named(
    prev?.interfaces,
    interfaceEntries.map((x) => x.e)
  )
  const typeDefIds = typeEntries.map((x, i) => declare(x.key, 'type', prevTypes[i], [...x.at, 'name']))
  const interfaceIds = interfaceEntries.map((x, i) =>
    declare(x.e.name, 'interface', prevInterfaces[i], [...x.at, 'name'])
  )
  const interfaceNames = new Set(interfaceEntries.map((x) => x.e.name))
  // Constants share the namespace too.
  const constEntries: Entry<FileConstant>[] = [
    ...(f.constants ?? []).map((e, i) => ({ e, at: ['constants', i] })),
    ...fileDependencies.flatMap((x, xi) =>
      (x.constants ?? []).map((e, i) => ({
        e,
        at: ['dependencies', xi, 'constants', i],
        dependency: dependencyIds[xi]!
      }))
    )
  ]
  const prevConsts = named(
    prev?.consts,
    constEntries.map((x) => x.e)
  )
  const constNames = new Set<string>()
  const constIds = constEntries.map((x, i) => {
    if (typeIds.has(x.e.name) || constNames.has(x.e.name))
      report(`Duplicate constant name '${x.e.name}'`, [...x.at, 'name'])
    constNames.add(x.e.name)
    return idOf(prevConsts[i], () => `const:${x.e.name}`)
  })

  /** References naming no type: modules, resolved once modules are known. */
  const moduleRefs: { ref: { id: Id }; name: string }[] = []
  const ref = (t: FileTypeRef, where: string, at: DataPath): TypeRef =>
    mapTypeRef(t, (r) => {
      const id = typeIds.get(r.name)
      if (interfaceNames.has(r.name)) report(`${where}: unknown type '${r.name}'`, at)
      if (id) return { kind: 'ref', id }
      const out = { kind: 'ref' as const, id: newId() }
      moduleRefs.push({ ref: out, name: r.name })
      return out
    })
  const field = (
    fl: { name: string; type: FileTypeRef; description?: string },
    where: string,
    was: { id: Id } | undefined,
    at: DataPath
  ): Field => ({
    id: was?.id ?? newId(),
    name: fl.name,
    type: ref(fl.type, `${where}.${fl.name}`, [...at, 'type']),
    description: fl.description ?? ''
  })
  const valueField = (
    fl: {
      name: string
      type: FileTypeRef
      description?: string
      default?: unknown
      constraints?: Constraints
      ownership?: Ownership
    },
    where: string,
    was: { id: Id } | undefined,
    at: DataPath
  ): ValueField => {
    const vf: ValueField = field(fl, where, was, at)
    if (fl.default !== undefined) vf.default = fl.default as Value
    if (fl.constraints && Object.keys(fl.constraints).length) vf.constraints = { ...fl.constraints }
    if (fl.ownership) vf.ownership = fl.ownership
    return vf
  }
  /** Messages of an interface or methods of a module (`owner`), at `at` in the file data. */
  const messages = (
    list: readonly FileMessage[],
    owner: string,
    before: readonly Message[] | undefined,
    at: DataPath
  ): Message[] => {
    const was = named(before, list)
    return list.map((m, j) => {
      const params = named(was[j]?.params, m.params)
      const where = `${owner}.${m.name}`
      return {
        id: was[j]?.id ?? newId(),
        name: m.name,
        description: m.description ?? '',
        params: m.params.map((prm, k) => ({
          ...field(prm, where, params[k], [...at, j, 'params', k]),
          direction: prm.direction ?? 'in'
        })),
        returns: m.returns ? ref(m.returns, `${where} returns`, [...at, j, 'returns']) : null,
        ...(m.raises?.length
          ? {
              raises: m.raises.map((name, k) => {
                // Unknown ones are missing references, reported by validation.
                if (interfaceNames.has(name))
                  report(`${where} raises: unknown exception '${name}'`, [...at, j, 'raises', k])
                return typeIds.get(name) ?? missingRef(name)
              })
            }
          : {})
      }
    })
  }

  const types: TypeDef[] = typeEntries.map(({ e: t, at, dependency, modulePath }, i) => {
    const base = {
      id: typeDefIds[i]!,
      name: t.name,
      description: t.description ?? '',
      ...owner(dependency),
      ...(modulePath && { modulePath }),
      ...('access' in t && access(t))
    }
    const was = prevTypes[i]
    switch (t.kind) {
      case 'struct': {
        const fields = named(was?.kind === 'struct' ? was.fields : [], t.fields)
        return {
          ...base,
          kind: 'struct',
          fields: t.fields.map((fl, j) => valueField(fl, t.name, fields[j], [...at, 'fields', j]))
        }
      }
      case 'enum': {
        const values = named(was?.kind === 'enum' ? was.values : [], t.values)
        return {
          ...base,
          kind: 'enum',
          underlying: t.underlying,
          values: t.values.map((v, j) => ({ id: values[j]?.id ?? newId(), name: v.name, value: v.value }))
        }
      }
      case 'exception': {
        const fields = named(was?.kind === 'exception' ? was.fields : [], t.fields)
        return {
          ...base,
          kind: 'exception',
          fields: t.fields.map((fl, j) => valueField(fl, t.name, fields[j], [...at, 'fields', j]))
        }
      }
      case 'bitmask': {
        const flags = named(was?.kind === 'bitmask' ? was.flags : [], t.flags)
        return {
          ...base,
          kind: 'bitmask',
          underlying: t.underlying,
          flags: t.flags.map((v, j) => ({ id: flags[j]?.id ?? newId(), name: v.name, bit: v.bit }))
        }
      }
      case 'union': {
        const cases = named(was?.kind === 'union' ? was.cases : [], t.cases)
        return {
          ...base,
          kind: 'union',
          discriminator: ref(t.discriminator, `${t.name} discriminator`, [...at, 'discriminator']),
          cases: t.cases.map((c, j) => ({
            ...field(c, t.name, cases[j], [...at, 'cases', j]),
            labels: c.labels ?? [],
            isDefault: c.default ?? false
          }))
        }
      }
      case 'alias':
        return { ...base, kind: 'alias', type: ref(t.type, t.name, [...at, 'type']) }
      case 'primitive':
        return { ...base, kind: 'primitive' }
    }
  })

  const consts: ConstDef[] = constEntries.map(({ e: c, at, dependency }, i) => ({
    id: constIds[i]!,
    name: c.name,
    description: c.description ?? '',
    ...owner(dependency),
    type: ref(c.type, c.name, [...at, 'type']),
    value: c.value
  }))

  const interfaces: Interface[] = interfaceEntries.map(({ e: i, at, dependency }, idx) => ({
    id: interfaceIds[idx]!,
    name: i.name,
    description: i.description ?? '',
    ...owner(dependency),
    messages: messages(i.messages, i.name, prevInterfaces[idx]?.messages, [...at, 'messages'])
  }))

  /** Attributes of a module (`path`) or placed module, at `at` in the file data. */
  /** Attributes of a module (`path`) or placed module, at `at`; `locks`: those of the module. */
  const attributesOf = (
    list: readonly FileAttribute[],
    path: string,
    before: readonly Attribute[] | undefined,
    at: DataPath,
    locks: readonly Lock[] = []
  ): Attribute[] => {
    const was = named(before, list)
    return list.map((a, j) => {
      const lock = a.guardedBy ? locks.find((l) => l.name === a.guardedBy) : undefined
      if (a.guardedBy && !lock)
        report(`${path}.${a.name}: unknown lock '${a.guardedBy}'`, [...at, j, 'guardedBy'])
      return {
        ...valueField(a, path, was[j], [...at, j]),
        ...access(a),
        ...qualifiers(a),
        ...(a.accessors && { accessors: a.accessors }),
        ...(lock && { guardedBy: lock.id })
      }
    })
  }
  /** Constructors of a module (`path`, named `name`), at `at` in the file data: read as methods. */
  const constructorsOf = (
    list: readonly FileConstructor[],
    path: string,
    name: string,
    before: readonly Constructor[] | undefined,
    at: DataPath
  ): Constructor[] => {
    const asMethods = list.map((c): FileMethod => ({
      name,
      description: c.description,
      params: c.params,
      returns: null
    }))
    const was = before?.map((c): Method => ({ ...c, name, returns: null }))
    return methodsOf(asMethods, path, was, at).map((x, j): Constructor => {
      const fc = list[j]!
      return {
        id: x.id,
        description: x.description,
        params: x.params,
        ...access(fc),
        ...(fc.explicit && { explicit: true }),
        ...(fc.defaulted && { defaulted: true }),
        ...(fc.deleted && { deleted: true })
      }
    })
  }
  /** Methods of a module (`path`) or placed module, at `at` in the file data. */
  const methodsOf = (
    list: readonly FileMethod[],
    path: string,
    before: readonly Method[] | undefined,
    at: DataPath
  ): Method[] =>
    messages(list, path, before, at).map((x, j): Method => {
      const fx = list[j]!
      return {
        ...x,
        ...access(fx),
        ...qualifiers(fx),
        ...(fx.pre?.length && { pre: [...fx.pre] }),
        ...(fx.post?.length && { post: [...fx.post] }),
        params: x.params.map((prm, k) => {
          const fp = fx.params[k]!
          return {
            ...prm,
            ...qualifiers(fp),
            ...(fp.default !== undefined && { default: fp.default })
          }
        })
      }
    })

  const layout = f.editor?.layout ?? {}
  const modules: Module[] = []
  const moduleByPath = new Map<string, Module>()
  const prevPaths = prev ? modulePaths(prev) : new Map<Id, string>()
  /** Modules with bases, resolved once all modules are known. */
  const derived: { mod: Module; path: string; bases: string[]; at: DataPath }[] = []

  // Auto layout (modules without editor data): rows of siblings, parents grown to fit children.
  const PAD = 20
  const GAP_X = 80
  const GAP_Y = 60
  const MAX_ROW = 1400

  /** Adds modules and returns the extent (width, height) they occupy inside their parent. */
  const addModules = (
    list: FileModule[],
    parentId: Id | null,
    parentPath: string,
    top: number,
    at: DataPath
  ): { width: number; height: number } => {
    const seen = new Set<string>()
    // A kept module keeps its id: the children of the previous state have the same parent id.
    const before = named(
      prev?.modules.filter((m) => m.parentId === parentId),
      list
    )
    const extent = { width: 0, height: 0 }
    let x = PAD
    let y = top + PAD
    let rowHeight = 0
    for (const [i, fm] of list.entries()) {
      const path = parentPath ? `${parentPath}.${fm.name}` : fm.name
      if (seen.has(fm.name)) report(`Duplicate module '${path}'`, [...at, i, 'name'])
      seen.add(fm.name)
      const was = before[i]
      const renamed = !!was && prevPaths.get(was.id) !== path
      const ports = named(was?.ports, fm.ports)
      const height = leafHeight(portRows(fm)) + compartmentsHeight(fm)
      const portNames = new Set<string>()
      const lockWas = named(was?.locks, fm.locks ?? [])
      const locks = fm.locks?.map((l, k): Lock => ({
        id: lockWas[k]?.id ?? newId(),
        name: l.name,
        kind: l.kind
      }))
      const mod: Module = {
        id: idOf(was, () => `module:${path}`),
        name: fm.name,
        description: fm.description ?? '',
        parentId,
        ...(fm.kind && fm.kind !== 'class' && { kind: fm.kind }),
        ...(fm.final && { final: true }),
        ...(fm.instantiation && { instantiation: fm.instantiation }),
        ...(fm.copy && { copy: fm.copy }),
        ...(fm.move && { move: fm.move }),
        ...(locks?.length && { locks }),
        ...(fm.invariants?.length && { invariants: [...fm.invariants] }),
        ...(fm.constructors && {
          constructors: constructorsOf(fm.constructors, path, fm.name, was?.constructors, [
            ...at,
            i,
            'constructors'
          ])
        }),
        ...(fm.destructor && {
          destructor: {
            ...access(fm.destructor),
            ...(fm.destructor.virtual !== undefined && { virtual: fm.destructor.virtual })
          }
        }),
        metadata: { ...(fm.metadata ?? {}) },
        attributes: attributesOf(fm.attributes ?? [], path, was?.attributes, [...at, i, 'attributes'], locks),
        methods: methodsOf(fm.methods ?? [], path, was?.methods, [...at, i, 'methods']),
        ports: fm.ports.map((pt, j) => {
          if (portNames.has(pt.name))
            report(`Duplicate port '${path}:${pt.name}'`, [...at, i, 'ports', j, 'name'])
          portNames.add(pt.name)
          let interfaceId: Id | null = null
          if (pt.interface) {
            if (typeIds.has(pt.interface) && !interfaceNames.has(pt.interface))
              report(`Port '${path}:${pt.name}': unknown interface '${pt.interface}'`, [
                ...at,
                i,
                'ports',
                j,
                'interface'
              ])
            interfaceId = typeIds.get(pt.interface) ?? missingRef(pt.interface)
          }
          return {
            id: ports[j]?.id ?? newId(),
            name: pt.name,
            role: pt.role,
            interfaceId,
            description: pt.description ?? ''
          }
        }),
        layout: { x: 0, y: 0, width: MODULE_WIDTH, height }
      }
      if (fm.binary) {
        const binaryId = binaryIds.get(fm.binary)
        if (parentId)
          report(`Module '${path}': only top-level modules name their binary`, [...at, i, 'binary'])
        else if (!binaryId) report(`Module '${path}': unknown binary '${fm.binary}'`, [...at, i, 'binary'])
        else mod.binaryId = binaryId
      }
      modules.push(mod)
      moduleByPath.set(path, mod)
      if (fm.bases?.length) derived.push({ mod, path, bases: fm.bases, at: [...at, i, 'bases'] })

      const inner = addModules(fm.modules ?? [], mod.id, path, height, [...at, i, 'modules'])
      const style = f.editor?.style?.[path]
      const color = fm.color ?? style?.color
      if (color) mod.color = color
      if (style ? style.locked : renamed && was.locked) mod.locked = true
      for (const [j, pt] of mod.ports.entries()) {
        const label = style ? style.labels?.[pt.name] : renamed ? ports[j]?.label : undefined
        if (label) pt.label = label
      }
      const saved = layout[path] ?? was?.layout
      if (saved) {
        mod.layout = { ...saved }
      } else {
        const r = mod.layout
        r.width = Math.max(r.width, inner.width + PAD)
        r.height = Math.max(r.height, inner.height + PAD)
        if (x > PAD && x + r.width > MAX_ROW) {
          x = PAD
          y += rowHeight + GAP_Y
          rowHeight = 0
        }
        r.x = x
        r.y = y
        x += r.width + GAP_X
        rowHeight = Math.max(rowHeight, r.height)
      }
      extent.width = Math.max(extent.width, mod.layout.x + mod.layout.width)
      extent.height = Math.max(extent.height, mod.layout.y + mod.layout.height)
    }
    return extent
  }
  addModules(f.modules, null, '', 0, ['modules'])
  // Types of modules: owned by the module at their path.
  typeEntries.forEach((x, i) => {
    const mod = x.module === undefined ? undefined : moduleByPath.get(x.module)
    if (mod) types[i]!.module = mod.id
    const t = types[i]!
    if (!x.param || t.kind !== 'primitive') return
    const tp = x.param
    const derivesFrom = tp.derivesFrom === undefined ? undefined : moduleByPath.get(tp.derivesFrom)?.id
    if (tp.derivesFrom !== undefined && !derivesFrom)
      report(`${x.key}: unknown module '${tp.derivesFrom}'`, [...x.at, 'derivesFrom'])
    t.typeParam = {
      ...(tp.constraint && { constraint: tp.constraint }),
      ...(derivesFrom && { derivesFrom }),
      ...(tp.default && { default: ref(tp.default, x.key, [...x.at, 'default']) })
    }
  })
  // Type arguments of generic bases, read before modules used as types are resolved.
  const baseArgs = derived.map(({ bases, path, at }) =>
    bases.map((b, j) => {
      if (!b.includes('<')) return undefined
      try {
        const parsed = parseTypeExpr(b)
        return parsed.kind === 'ref'
          ? (parsed.args ?? []).map((a) => ref(a, `${path} base`, [...at, j]))
          : undefined
      } catch (e) {
        report(`Module '${path}': base '${b}': ${(e as Error).message}`, [...at, j])
        return undefined
      }
    })
  )
  // Modules used as types: of this project by path, of a dependency `Dep/Core.Sensor`.
  const dependencyByName = new Map(fileDependencies.map((x, i) => [x.name, dependencyIds[i]!]))
  for (const { ref, name } of moduleRefs) {
    const slash = name.indexOf('/')
    const dependency = slash > 0 ? dependencyByName.get(name.slice(0, slash)) : undefined
    const id =
      moduleByPath.get(name)?.id ?? (dependency && dependencyModuleRef(dependency, name.slice(slash + 1)))
    // Unknown ones are missing references, reported by validation.
    ref.id = id ?? missingRef(name)
  }
  // Placed modules of dependencies: on the right of the project's modules when they have no position.
  let importY = PAD
  const importX =
    Math.max(0, ...modules.filter((m) => !m.parentId).map((m) => m.layout.x + m.layout.width)) + GAP_X * 2
  const dependencies: Dependency[] = fileDependencies.map((i, idx) => {
    const paths = new Set<string>()
    const fileModules = i.modules ?? []
    const before = pair(
      prevDependencies[idx]?.modules ?? [],
      (m) => m.path,
      fileModules.map((m) => m.module)
    )
    return {
      id: dependencyIds[idx]!,
      name: i.name,
      file: i.file,
      uses: [...(i.uses ?? [])],
      indirect: i.indirect ?? false,
      shared: [...(i.shared ?? [])],
      modules: fileModules.map((m, j) => {
        const where = `Dependency '${i.name}' module '${m.module}'`
        if (paths.has(m.module))
          report(`${where}: listed more than once`, ['dependencies', idx, 'modules', j, 'module'])
        paths.add(m.module)
        const portNames = new Set<string>()
        const was = before[j]
        const ports = named(was?.ports, m.ports)
        const saved = f.editor?.dependencies?.[i.name]?.[m.module]
        const at = saved ?? was?.position
        const position = at ? { x: at.x, y: at.y } : { x: importX, y: importY }
        if (!at) importY += leafHeight(portRows(m)) + compartmentsHeight(m) + GAP_Y
        const placed = `${i.name}/${m.module}`
        const data: DataPath = ['dependencies', idx, 'modules', j]
        const attributes = attributesOf(m.attributes ?? [], placed, was?.attributes, [...data, 'attributes'])
        const methods = methodsOf(m.methods ?? [], placed, was?.methods, [...data, 'methods'])
        const size = saved
          ? saved.width !== undefined && saved.height !== undefined
            ? { width: saved.width, height: saved.height }
            : undefined
          : was?.size
        return {
          id: idOf(was, () => `${IMPORTED_PREFIX}${i.name}/${m.module}`),
          path: m.module,
          position,
          ...(size && { size }),
          ...((saved ? saved.locked : was?.locked) && { locked: true }),
          ...(m.final && { final: true }),
          ...(attributes.length && { attributes }),
          ...(methods.length && { methods }),
          ports: m.ports.map((pt, k) => {
            if (portNames.has(pt.name))
              report(`${where}: duplicate port '${pt.name}'`, [
                'dependencies',
                idx,
                'modules',
                j,
                'ports',
                k,
                'name'
              ])
            portNames.add(pt.name)
            return {
              id: ports[k]?.id ?? newId(),
              name: pt.name,
              role: pt.role,
              interface: pt.interface,
              description: pt.description ?? '',
              ...(saved?.labels?.[pt.name] ? { label: saved.labels[pt.name] } : {})
            }
          })
        }
      })
    }
  })

  // Bases: modules of this project, or placed modules of dependencies (`Dependency/Module.Path`).
  for (const [k, { mod, path, bases, at }] of derived.entries())
    mod.bases = bases.flatMap((full, j) => {
      const b = full.includes('<') ? full.slice(0, full.indexOf('<')) : full
      const slash = b.indexOf('/')
      const base =
        slash < 0
          ? moduleByPath.get(b)
          : dependencies
              .find((x) => x.name === b.slice(0, slash))
              ?.modules.find((m) => m.path === b.slice(slash + 1))
      if (!base)
        report(
          slash < 0
            ? `Module '${path}': unknown base '${b}'`
            : `Module '${path}': base '${b}' is not a placed module of a dependency`,
          [...at, j]
        )
      const args = baseArgs[k]![j]
      if (base && args) (mod.baseArgs ??= {})[base.id] = args
      return base ? [base.id] : []
    })

  const endpoint = (e: { project?: string; module: string; port: string }, where: string, at: DataPath) => {
    if (e.project !== undefined) {
      const dep = dependencies.find((x) => x.name === e.project)
      const mod = dep?.modules.find((m) => m.path === e.module)
      const port = mod?.ports.find((pt) => pt.name === e.port)
      if (!dep) report(`${where}: unknown dependency '${e.project}'`, [...at, 'project'])
      else if (!mod)
        report(`${where}: module '${e.module}' is not placed from dependency '${e.project}'`, [
          ...at,
          'module'
        ])
      else if (!port) report(`${where}: unknown port '${e.project}/${e.module}:${e.port}'`, [...at, 'port'])
      return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
    }
    const mod = moduleByPath.get(e.module)
    const port = mod?.ports.find((pt) => pt.name === e.port)
    if (!mod) report(`${where}: unknown module '${e.module}'`, [...at, 'module'])
    else if (!port) report(`${where}: unknown port '${e.module}:${e.port}'`, [...at, 'port'])
    return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
  }
  const prevLinks = named(prev?.links, f.links)
  const links: Link[] = f.links.map((l, i) => {
    const was = prevLinks[i]
    const route = f.editor?.links?.[l.name] ?? (was?.name !== l.name ? was?.route : undefined)
    return {
      id: was?.id ?? newId(),
      name: l.name,
      description: l.description ?? '',
      from: endpoint(l.from, `Link '${l.name}' from`, ['links', i, 'from']),
      to: endpoint(l.to, `Link '${l.name}' to`, ['links', i, 'to']),
      constraints: clean(l.constraints),
      ...(route ? { route: clean({ ...route, points: route.points ?? [] }) } : {})
    }
  })

  // Editor data is best effort: dangling module paths are dropped, not reported.
  // Paths of the previous state still find the modules renamed since.
  const moduleIds = new Set(modules.map((m) => m.id))
  const prevIds = new Map([...prevPaths].map(([id, path]) => [path, id]))
  const moduleAt = (path: string): Id | undefined => {
    const id = moduleByPath.get(path)?.id ?? prevIds.get(path)
    return id && moduleIds.has(id) ? id : undefined
  }
  // Placed modules of dependencies too ('Dependency/Module'), for modules outside a view.
  const importedByPath = new Map(
    dependencies.flatMap((x) => x.modules.map((m): [string, ImportedModule] => [`${x.name}/${m.path}`, m]))
  )
  const anyModuleAt = (path: string): Id | undefined => moduleAt(path) ?? importedByPath.get(path)?.id
  const prevViews = named(prev?.views, f.editor?.views ?? [])
  const linkByName = new Map(links.map((l) => [l.name, l]))
  /** Notes of a file entry, keeping the ids of `before` (by index). */
  const readNotes = (entries: NonNullable<FileEditor['notes']>, before: Note[], viewId?: Id): Note[] =>
    entries.map((n, i) => ({
      id: before[i]?.id ?? newId(),
      kind: n.kind,
      text: n.text,
      layout: { x: n.x, y: n.y, width: n.width, height: n.height },
      ...(n.color ? { color: n.color } : {}),
      ...(n.locked ? { locked: true } : {}),
      ...(viewId ? { viewId } : {})
    }))
  const viewNoteList: Note[] = []
  const views: View[] = (f.editor?.views ?? []).flatMap((v, i): View[] => {
    const was = prevViews[i]
    const root = v.root ? moduleAt(v.root) : undefined
    if (v.root && !root) return []
    const hidden = (v.hidden ?? []).flatMap((h) => anyModuleAt(h) ?? [])
    const layouts = Object.entries(v.layout ?? {}).flatMap(([path, r]) => {
      const id = moduleAt(path)
      return id ? [[id, { ...r }] as const] : []
    })
    const id = idOf(was, () => `view:${i}`)
    if (!root) return [{ id, name: v.name, rootModuleId: null, hidden }]
    const routes = Object.entries(v.links ?? {}).flatMap(([name, r]) => {
      const l = linkByName.get(name)
      return l ? [[l.id, clean({ ...r, points: r.points ?? [] })] as const] : []
    })
    const portLabels = Object.entries(v.labels ?? {}).flatMap(([path, labels]) => {
      const m = modules.find((m) => m.id === moduleAt(path)) ?? importedByPath.get(path)
      return Object.entries(labels).flatMap(([name, side]) => {
        const pt = m?.ports.find((pt) => pt.name === name)
        return pt ? [[pt.id, side] as const] : []
      })
    })
    const standIns = Object.entries(v.outside ?? {}).flatMap(([path, at]) => {
      const id = anyModuleAt(path)
      return id ? [[id, { ...at }] as const] : []
    })
    viewNoteList.push(
      ...readNotes(
        v.notes ?? [],
        (prev?.notes ?? []).filter((n) => n.viewId === id),
        id
      )
    )
    return [
      {
        id,
        name: v.name,
        rootModuleId: root,
        hidden,
        ...(layouts.length ? { layouts: Object.fromEntries(layouts) } : {}),
        ...(routes.length ? { routes: Object.fromEntries(routes) } : {}),
        ...(portLabels.length ? { portLabels: Object.fromEntries(portLabels) } : {}),
        ...(standIns.length ? { standIns: Object.fromEntries(standIns) } : {})
      }
    ]
  })
  const notes: Note[] = [
    ...readNotes(
      f.editor?.notes ?? [],
      (prev?.notes ?? []).filter((n) => !n.viewId)
    ),
    ...viewNoteList
  ]

  if (problems.length) throw new LoadError(problems)
  return {
    name: f.project.name,
    description: f.project.description ?? '',
    metadata: { ...(f.project.metadata ?? {}) },
    transports: [...(f.transports ?? [])],
    ...(f.remoteDefaults ? { remoteDefaults: clean(f.remoteDefaults) } : {}),
    binaries,
    types,
    interfaces,
    consts,
    modules,
    links,
    dependencies,
    views,
    notes,
    orientation: f.editor?.orientation ?? 'horizontal'
  }
}

export function stringify(file: FileProject, format: Format): string {
  return format === 'json' ? JSON.stringify(file, null, 2) + '\n' : YAML.stringify(file, { lineWidth: 0 })
}

/** JSON.parse keeping integers too large for a number as decimal text, where the browser tells their source. */
const readJson = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
      ? context!.source
      : value
  )

/** Integers too large for a number are kept as decimal text, as in default values (see defaults.ts). */
export function parseText(text: string, format: Format): unknown {
  try {
    return format === 'json' ? readJson(text) : safeIntegers(YAML.parse(text, { intAsBigInt: true }))
  } catch (e) {
    const message = `Invalid ${format.toUpperCase()}: ${(e as Error).message}`
    throw new LoadError([{ message, line: syntaxErrorLine(text, e) }])
  }
}

/** Line (from 1) of a YAML or JSON syntax error, when the parser tells. */
function syntaxErrorLine(text: string, e: unknown): number | undefined {
  if (e instanceof YAMLParseError) return e.linePos?.[0].line
  const message = e instanceof Error ? e.message : ''
  const line = /\bline (\d+)/.exec(message)
  if (line) return Number(line[1])
  const position = /\bposition (\d+)/.exec(message)
  return position ? text.slice(0, Number(position[1])).split('\n').length : undefined
}

/**
 * Line (from 1) of a path in the file data: the key of the deepest entry of the path found in the
 * text (JSON parses as YAML).
 */
export function lineOfPath(text: string, path: DataPath): number | undefined {
  const counter = new LineCounter()
  const doc = YAML.parseDocument(text, { lineCounter: counter })
  const start = (n: unknown): number | undefined => (n as YamlNode | null | undefined)?.range?.[0]
  let node: unknown = doc.contents
  let at = start(node)
  for (const key of path) {
    let next: unknown
    let offset: number | undefined
    if (isMap(node)) {
      const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key)
      next = pair?.value
      offset = start(pair?.key) ?? start(next)
    } else if (isSeq(node) && typeof key === 'number') {
      next = node.items[key]
      offset = start(next)
    }
    if (offset === undefined) break
    at = offset
    node = next
  }
  return at === undefined ? undefined : counter.linePos(at).line
}

/** A load error whose problems are located in the text they come from. */
function located(text: string, e: unknown): unknown {
  if (!(e instanceof LoadError) || !e.issues.some((i) => i.path && !i.line)) return e
  return new LoadError(
    e.issues.map((i) => (i.path && !i.line ? { ...i, line: lineOfPath(text, i.path) } : i))
  )
}

export function formatFromPath(path: string): Format {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'yaml'
}

export function loadText(text: string, format: Format): Project {
  try {
    return fromFile(parseText(text, format))
  } catch (e) {
    throw located(text, e)
  }
}

export function saveText(p: Project, format: Format, options: { editor: boolean }): string {
  return stringify(toFile(p, options), format)
}

/**
 * New version of `prev` read from text (edited in place or changed on disk): entities keep their
 * ids, and the editor data of `prev` stands in when the text has none.
 */
export function reloadText(text: string, format: Format, prev: Project): Project {
  const data = parseText(text, format)
  if (data && typeof data === 'object' && !Array.isArray(data) && !('editor' in data))
    (data as { editor?: FileEditor }).editor = toFile(prev, { editor: true }).editor
  try {
    return fromFile(data, prev)
  } catch (e) {
    throw located(text, e)
  }
}

/** Whether two projects are saved the same (a reload that changes nothing). */
export function sameContent(a: Project, b: Project): boolean {
  return a === b || saveText(a, 'json', { editor: true }) === saveText(b, 'json', { editor: true })
}
