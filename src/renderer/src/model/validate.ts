// Semantic checks. Errors block export; warnings do not.
import {
  allTypeRefs,
  ancestorModules,
  baseMethods,
  baseModule,
  canUseType,
  globalTypeNames,
  isModuleRef,
  isModuleType,
  memberNames,
  missingName,
  moduleTypes,
  typeParamsOf,
  parseDependencyModuleRef,
  refContext,
  refNamer,
  typeNames,
  findImported,
  findPort,
  IDENTIFIER_RE,
  isImportedId,
  linkRoles,
  methodSignature,
  overloadKey,
  typeKey,
  overloadName,
  modulePath,
  unimplementedMethods
} from './project'
import { normalizeFile } from './sync'
import { isReservedTypeName, walkTypeRef } from './typeExpr'
import { resolve as resolveType, valueErrors } from './defaults'
import { constraintErrors, constraintValueErrors, moduleRefs } from './constraints'
import { unknownNames } from './contracts'
import { binariesOf, crosses } from './binaries'
import { DEFAULT_HOST, foreignFields } from './transports'
import {
  INT_PRIMITIVES,
  INT_RANGES,
  TRANSPORTS,
  type Id,
  type Attribute,
  type Constructor,
  type Message,
  type MethodParam,
  type Module,
  type PrimitiveDef,
  type Project,
  type TypeDef,
  type TypeRef,
  type ValueField
} from './types'

export type Severity = 'error' | 'warning'
export type ProblemTarget =
  | { kind: 'project' }
  | { kind: 'type'; id: Id }
  | { kind: 'interface'; id: Id }
  | { kind: 'const'; id: Id }
  | { kind: 'module'; id: Id }
  | { kind: 'link'; id: Id }
  | { kind: 'dependency'; id: Id }

export interface Problem {
  severity: Severity
  message: string
  target: ProblemTarget
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const n of names) (seen.has(n) ? dups : seen).add(n)
  return [...dups]
}

/** What a reference to something the project lacks says: the name it keeps (see `missingRef`), if any. */
function missingText(id: Id, kind: string, deleted: string, verb = 'references'): string {
  const name = missingName(id)
  return name === undefined ? `${verb} a deleted ${deleted}` : `${verb} unknown ${kind} '${name}'`
}

export function validate(p: Project): Problem[] {
  const problems: Problem[] = []
  // Entities of dependencies are checked in their own file: here only errors matter.
  const fromLibrary = new Set(
    [...p.types, ...p.interfaces, ...p.consts].filter((e) => e.dependency).map((e) => e.id)
  )
  const push = (severity: Severity, target: ProblemTarget, message: string): void => {
    if (severity === 'warning' && 'id' in target && fromLibrary.has(target.id)) return
    problems.push({ severity, target, message })
  }
  const types = new Map(p.types.map((t) => [t.id, t]))
  const interfaces = new Map(p.interfaces.map((i) => [i.id, i]))
  const isModule = (id: Id): boolean => isModuleRef(p, id)
  const dependencyIds = new Set(p.dependencies.map((x) => x.id))
  /** Whether a type reference names an existing type or module (of a dependency: an existing one). */
  const exists = (id: Id): boolean => {
    if (types.has(id)) return true
    const ref = parseDependencyModuleRef(id)
    return ref ? dependencyIds.has(ref.dependency) : isModule(id)
  }

  /** Follow aliases to the underlying type; the reference itself for a module, null for dangling or cyclic aliases. */
  const resolve = (t: TypeRef, seen = new Set<Id>()): TypeRef | TypeDef | null => {
    if (t.kind !== 'ref') return t
    const def = types.get(t.id)
    if (!def && exists(t.id)) return t
    if (!def || seen.has(t.id)) return null
    if (def.kind !== 'alias') return def
    seen.add(t.id)
    return resolve(def.type, seen)
  }

  /** Type arguments `args` given to the type or module `id` (`name`): its type parameters. */
  const checkTypeArgs = (
    id: Id,
    args: readonly TypeRef[],
    target: ProblemTarget,
    where: string,
    name: string
  ): void => {
    const params = p.modules.some((m) => m.id === id) ? typeParamsOf(p, id) : []
    if (!params.length) {
      if (args.length) push('error', target, `${where}: ${name} takes no type arguments`)
      return
    }
    if (args.length > params.length)
      push('error', target, `${where}: ${name} takes ${params.length} type arguments, not ${args.length}`)
    params.forEach((tp, i) => {
      const arg = args[i]
      if (!arg) {
        if (!tp.typeParam!.default)
          push('error', target, `${where}: ${name} needs a type argument for ${tp.name}`)
        return
      }
      for (const e of typeArgErrors(arg, tp)) push('error', target, `${where}: ${tp.name} of ${name}: ${e}`)
    })
  }

  /** Why a type argument does not fit a type parameter. */
  const typeArgErrors = (arg: TypeRef, tp: PrimitiveDef): string[] => {
    const { constraint, derivesFrom } = tp.typeParam!
    const r = resolve(arg)
    // A type parameter given on: it fits when it is at least as constrained.
    const param = r?.kind === 'primitive' && 'id' in r ? r.typeParam : undefined
    const errors: string[] = []
    if (constraint) {
      const name = r?.kind === 'primitive' && !('id' in r) ? r.name : undefined
      const integral = !!name && (INT_PRIMITIVES as readonly string[]).includes(name)
      const fits = param
        ? param.constraint === 'integral' || param.constraint === constraint
        : constraint === 'integral'
          ? integral
          : integral || name === 'float32' || name === 'float64'
      if (!fits) errors.push(constraint === 'integral' ? 'an integer type' : 'a number type')
    }
    if (derivesFrom) {
      const id = arg.kind === 'ref' ? arg.id : undefined
      const fits =
        (param && param.derivesFrom === derivesFrom) ||
        (!!id && (id === derivesFrom || ancestorModules(p, id).some((b) => b.id === derivesFrom)))
      if (!fits) errors.push(`a module deriving from ${modulePath(p, derivesFrom)}`)
    }
    return errors.map((e) => `expects ${e}`)
  }

  const checkTypeRef = (t: TypeRef, target: ProblemTarget, where: string): void => {
    walkTypeRef(t, (n) => {
      if (n.kind === 'ref' && exists(n.id))
        checkTypeArgs(n.id, n.args ?? [], target, where, types.get(n.id)?.name ?? moduleName(n.id))
      if (n.kind === 'ref' && !exists(n.id))
        push('error', target, `${where}: ${missingText(n.id, 'type', 'type or module')}`)
      if (n.kind === 'ref' && types.get(n.id)?.kind === 'exception')
        push('error', target, `${where}: exception '${types.get(n.id)!.name}' can only be raised`)
      if (n.kind === 'primitive' && n.max !== undefined && n.name !== 'string' && n.name !== 'bytes')
        push('error', target, `${where}: ${n.name} cannot be bounded`)
      const keyOf = n.kind === 'map' ? n.key : n.kind === 'set' ? n.of : null
      if (!keyOf) return
      const k = resolve(keyOf)
      if (!k) return
      const ok = k.kind === 'primitive' || k.kind === 'enum' || k.kind === 'bitmask' || k.kind === 'ref'
      if (!ok)
        push('error', target, `${where}: ${n.kind} key must be a primitive, an enum, a bitmask or a module`)
      else if (k.kind === 'primitive' && (k.name === 'float32' || k.name === 'float64'))
        push('warning', target, `${where}: floating-point ${n.kind} key`)
    })
  }

  const moduleName = (id: Id): string => {
    const of = parseDependencyModuleRef(id)
    return of
      ? `${p.dependencies.find((x) => x.id === of.dependency)?.name ?? '?'}/${of.path}`
      : modulePath(p, id)
  }

  /** Modules some field or attribute holds as `shared`: those a `weak` one may reference. */
  let sharedModules: Set<Id> | undefined
  const shared = (): Set<Id> => {
    if (sharedModules) return sharedModules
    const fields = [
      ...p.modules.flatMap((m) => m.attributes),
      ...p.types.flatMap((t) => (t.kind === 'struct' || t.kind === 'exception' ? t.fields : []))
    ]
    sharedModules = new Set(
      fields.filter((f) => f.ownership === 'shared').flatMap((f) => moduleRefs(f.type, isModule))
    )
    return sharedModules
  }

  /** Default value, constraints and ownership of a field, attribute or parameter (`where`). */
  const checkDefault = (
    f: Pick<ValueField, 'type' | 'default' | 'constraints' | 'ownership'>,
    target: ProblemTarget,
    where: string
  ): void => {
    const c = f.constraints
    if (c) for (const e of constraintErrors(c, f.type, p.types)) push('error', target, `${where}: ${e}`)
    if (f.ownership) {
      const refs = moduleRefs(f.type, isModule)
      if (!refs.length) push('error', target, `${where}: ownership applies to types referencing modules`)
      else if (f.ownership === 'weak')
        for (const id of refs)
          if (!shared().has(id))
            push('warning', target, `${where}: weak, but nothing holds ${moduleName(id)} as shared`)
    }
    if (f.default === undefined) return
    const errors = valueErrors(f.default, f.type, p.types, isModule)
    for (const e of errors) push('error', target, `${where} default: ${e}`)
    if (c && !errors.length)
      for (const e of constraintValueErrors(f.default, c)) push('error', target, `${where} default: ${e}`)
  }

  // Project
  if (!p.name.trim()) push('warning', { kind: 'project' }, 'Project has no name')

  // Types, interfaces & constants namespace (types of modules: their module's)
  for (const n of duplicates(globalTypeNames(p)))
    push('error', { kind: 'project' }, `Duplicate type/interface/constant name '${n}'`)

  for (const c of p.consts) {
    const target = { kind: 'const', id: c.id } as const
    if (isReservedTypeName(c.name)) push('error', target, `'${c.name}' is a reserved type name`)
    checkTypeRef(c.type, target, c.name)
    for (const e of valueErrors(c.value, c.type, p.types, isModule))
      push('error', target, `Constant '${c.name}': ${e}`)
  }

  for (const t of p.types) {
    const target = { kind: 'type', id: t.id } as const
    if (isReservedTypeName(t.name)) push('error', target, `'${t.name}' is a reserved type name`)
    switch (t.kind) {
      case 'struct':
      case 'exception':
        if (t.kind === 'struct' && !t.fields.length)
          push('warning', target, `Struct '${t.name}' has no fields`)
        for (const n of duplicates(t.fields.map((f) => f.name)))
          push(
            'error',
            target,
            `${t.kind === 'struct' ? 'Struct' : 'Exception'} '${t.name}': duplicate field '${n}'`
          )
        for (const f of t.fields) {
          checkTypeRef(f.type, target, `${t.name}.${f.name}`)
          checkDefault(f, target, `${t.name}.${f.name}`)
        }
        break
      case 'enum': {
        if (!t.values.length) push('warning', target, `Enum '${t.name}' has no values`)
        for (const n of duplicates(t.values.map((v) => v.name)))
          push('error', target, `Enum '${t.name}': duplicate value name '${n}'`)
        for (const n of duplicates(t.values.map((v) => String(v.value))))
          push('warning', target, `Enum '${t.name}': value ${n} used more than once`)
        const [min, max] = INT_RANGES[t.underlying]
        for (const v of t.values)
          if (BigInt(v.value) < min || BigInt(v.value) > max)
            push('error', target, `Enum '${t.name}': ${v.name} = ${v.value} does not fit in ${t.underlying}`)
        break
      }
      case 'bitmask': {
        if (!t.flags.length) push('warning', target, `Bitmask '${t.name}' has no flags`)
        for (const n of duplicates(t.flags.map((v) => v.name)))
          push('error', target, `Bitmask '${t.name}': duplicate flag '${n}'`)
        for (const n of duplicates(t.flags.map((v) => String(v.bit))))
          push('error', target, `Bitmask '${t.name}': bit ${n} used more than once`)
        const width = Number(t.underlying.slice(4))
        for (const v of t.flags)
          if (v.bit >= width)
            push(
              'error',
              target,
              `Bitmask '${t.name}': ${v.name} (bit ${v.bit}) does not fit in ${t.underlying}`
            )
        break
      }
      case 'union': {
        checkTypeRef(t.discriminator, target, `${t.name} discriminator`)
        const d = resolve(t.discriminator)
        const valid =
          d?.kind === 'enum' ||
          (d?.kind === 'primitive' &&
            (d.name === 'bool' ||
              d.name === 'char' ||
              (INT_PRIMITIVES as readonly string[]).includes(d.name)))
        if (d && !valid)
          push('error', target, `Union '${t.name}': discriminator must be an integer, bool, char or enum`)
        if (!t.cases.length) push('warning', target, `Union '${t.name}' has no cases`)
        for (const n of duplicates(t.cases.map((c) => c.name)))
          push('error', target, `Union '${t.name}': duplicate case '${n}'`)
        if (t.cases.filter((c) => c.isDefault).length > 1)
          push('error', target, `Union '${t.name}': more than one default case`)
        for (const c of t.cases) {
          checkTypeRef(c.type, target, `${t.name}.${c.name}`)
          if (!c.labels.length && !c.isDefault)
            push('error', target, `Union '${t.name}': case '${c.name}' has no label`)
          if (valid)
            for (const l of c.labels)
              for (const e of valueErrors(l, t.discriminator, p.types))
                push('error', target, `Union '${t.name}': label of case '${c.name}': ${e}`)
        }
        const labels = t.cases.flatMap((c) => c.labels.map(String))
        for (const n of duplicates(labels))
          push('error', target, `Union '${t.name}': label ${n} used by several cases`)
        const all =
          d?.kind === 'enum'
            ? d.values.map((v) => v.name)
            : d?.kind === 'primitive' && d.name === 'bool'
              ? ['true', 'false']
              : null
        if (t.cases.some((c) => c.isDefault) && all?.every((v) => labels.includes(v)))
          push('warning', target, `Union '${t.name}': the default case is never held, every value has a case`)
        break
      }
      case 'alias':
        checkTypeRef(t.type, target, t.name)
        if (t.type.kind === 'ref' && types.has(t.type.id) && resolve(t.type, new Set([t.id])) === null)
          push('error', target, `Alias '${t.name}' is cyclic`)
        break
    }
  }

  // Structs and unions containing themselves by value (through fields, cases, arrays, optionals and aliases).
  const byValue = (t: TypeRef, out: Set<Id>, seenAlias = new Set<Id>()): void => {
    switch (t.kind) {
      case 'array':
      case 'optional':
        byValue(t.of, out, seenAlias)
        break
      case 'ref': {
        const def = types.get(t.id)
        if (def?.kind === 'struct' || def?.kind === 'union') out.add(def.id)
        else if (def?.kind === 'alias' && !seenAlias.has(def.id)) {
          seenAlias.add(def.id)
          byValue(def.type, out, seenAlias)
        }
        break
      }
    }
  }
  const edges = new Map<Id, Set<Id>>()
  for (const t of p.types) {
    if (t.kind !== 'struct' && t.kind !== 'union') continue
    const out = new Set<Id>()
    for (const f of t.kind === 'struct' ? t.fields : t.cases) byValue(f.type, out)
    edges.set(t.id, out)
  }
  const state = new Map<Id, 'visiting' | 'done'>()
  const cyclic = new Set<Id>()
  const visit = (id: Id, stack: Id[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      for (const s of stack.slice(stack.indexOf(id))) cyclic.add(s)
      return
    }
    state.set(id, 'visiting')
    for (const next of edges.get(id) ?? []) visit(next, [...stack, id])
    state.set(id, 'done')
  }
  for (const id of edges.keys()) visit(id, [])
  for (const id of cyclic) {
    const t = types.get(id)!
    push(
      'error',
      { kind: 'type', id },
      `${t.kind === 'union' ? 'Union' : 'Struct'} '${t.name}' contains itself by value (use vector, list, map or set to break the cycle)`
    )
  }

  /** Parameters and return type of an interface message or a module method. */
  /** Type parameters of a module (`path`) and the type arguments of its bases. */
  const checkGenerics = (m: Module, target: ProblemTarget, path: string): void => {
    let defaulted: string | null = null
    for (const tp of typeParamsOf(p, m.id)) {
      const d = tp.typeParam!.default
      if (d) {
        checkTypeRef(d, target, `${path}<${tp.name}> default`)
        for (const e of typeArgErrors(d, tp)) push('error', target, `${path}<${tp.name}> default: ${e}`)
        defaulted ??= tp.name
      } else if (defaulted)
        push('error', target, `${path}<${tp.name}>: needs a default, as ${defaulted} before it has one`)
      const from = tp.typeParam!.derivesFrom
      if (from && !p.modules.some((x) => x.id === from))
        push('error', target, `${path}<${tp.name}>: derives from a deleted module`)
    }
    for (const b of m.bases ?? [])
      if (p.modules.some((x) => x.id === b)) {
        const args = m.baseArgs?.[b] ?? []
        for (const a of args) checkTypeRef(a, target, `${path} base ${modulePath(p, b)}`)
        checkTypeArgs(b, args, target, `${path} base`, modulePath(p, b))
      }
  }

  /** Names any contract may use: types (first part of a path), constants, enum values, dependencies. */
  let contractNames: Set<string> | undefined
  const contractGlobals = (): Set<string> =>
    (contractNames ??= new Set([
      ...p.types.map((t) => t.name),
      ...p.types.flatMap((t) => (t.kind === 'enum' ? t.values.map((v) => v.name) : [])),
      ...p.types.flatMap((t) => (t.kind === 'bitmask' ? t.flags.map((v) => v.name) : [])),
      ...p.consts.map((c) => c.name),
      ...p.modules.filter((x) => !x.parentId).map((x) => x.name),
      ...p.dependencies.map((d) => d.name)
    ]))

  /** Preconditions, postconditions and invariants of a module (`path`): the names they use. */
  const checkContracts = (
    m: Module,
    target: ProblemTarget,
    path: string,
    ancestors: ReturnType<typeof ancestorModules>
  ): void => {
    const members = new Set([
      ...contractGlobals(),
      ...m.attributes.map((a) => a.name),
      ...m.methods.map((x) => x.name),
      ...(m.locks ?? []).map((l) => l.name),
      ...moduleTypes(p, m.id).map((t) => t.name),
      ...ancestors.flatMap((b) => [
        ...(b.attributes ?? []).map((a) => a.name),
        ...baseMethods(b).map((x) => x.name)
      ])
    ])
    const check = (expression: string, known: ReadonlySet<string>, where: string): void => {
      if (!expression.trim()) push('warning', target, `${where}: empty condition`)
      for (const n of unknownNames(expression, known))
        push('warning', target, `${where}: '${n}' names nothing here`)
    }
    for (const e of m.invariants ?? []) check(e, members, `${path} invariant`)
    for (const x of m.methods) {
      if (!x.pre?.length && !x.post?.length) continue
      const params = new Set([...members, ...x.params.map((prm) => prm.name)])
      for (const e of x.pre ?? []) check(e, params, `${path}.${x.name} precondition`)
      const after = new Set([...params, ...(x.returns ? ['result'] : [])])
      for (const e of x.post ?? []) check(e, after, `${path}.${x.name} postcondition`)
    }
  }

  /** Qualifiers, accessors and lock of an attribute (`where`) of `m`. */
  const checkAttribute = (m: Module, a: Attribute, target: ProblemTarget, where: string): void => {
    if (a.mutable && (a.static || a.const))
      push('error', target, `${where}: a mutable attribute is not ${a.static ? 'static' : 'const'}`)
    if (a.accessors === 'read' && a.const)
      push('warning', target, `${where}: const has no setter already (accessors: read)`)
    if (a.accessors && a.access === 'private')
      push('warning', target, `${where}: private has no accessors already (accessors: ${a.accessors})`)
    if (a.atomic) {
      if (a.guardedBy) push('error', target, `${where}: atomic, it needs no lock`)
      const scalar = constrainedScalarOf(a.type)
      if (scalar === 'other' || scalar === 'string' || scalar === 'bytes')
        push('error', target, `${where}: atomic applies to booleans, characters, numbers, enums and bitmasks`)
      if (a.const) push('warning', target, `${where}: const, atomic changes nothing`)
    }
    if (a.guardedBy && !m.locks?.some((l) => l.id === a.guardedBy))
      push('error', target, `${where}: guarded by a deleted lock`)
  }

  /** What an attribute's value is, for atomic ones: a scalar type, not a container. */
  const constrainedScalarOf = (t: TypeRef): string => {
    const r = resolveType(t, types, isModule)
    if (!r) return 'other'
    if (r.kind === 'enum' || r.kind === 'bitmask') return r.kind
    return r.kind === 'primitive' && !('id' in r) ? r.name : 'other'
  }

  /** Qualifiers and defaults of the parameters of a method or constructor (`where`). */
  const checkParams = (params: MethodParam[], target: ProblemTarget, where: string): void => {
    let defaulted: string | null = null
    for (const prm of params) {
      const at = `${where}(${prm.name})`
      if (prm.const && prm.direction !== 'in')
        push('error', target, `${at}: an ${prm.direction} parameter cannot be const`)
      if (prm.default !== undefined) {
        if (prm.direction !== 'in')
          push('error', target, `${at}: an ${prm.direction} parameter cannot have a default`)
        else checkDefault(prm, target, at)
        defaulted ??= prm.name
      } else if (defaulted)
        push('error', target, `${at}: needs a default or to move before ${defaulted}, which has one`)
    }
  }

  /** Constructors, copy, move, destructor and instantiation of a module (`path`). */
  const checkLifecycle = (
    m: Module,
    target: ProblemTarget,
    path: string,
    ancestors: ReturnType<typeof ancestorModules>
  ): void => {
    const ctors = m.constructors ?? []
    const ctorWhere = (c: Constructor): string => `${path}(${c.params.map((prm) => prm.name).join(', ')})`
    const attributes = new Map(m.attributes.map((a) => [a.name, a]))
    const keys = new Set<string>()
    for (const c of ctors) {
      const where = ctorWhere(c)
      const key = overloadKey(c)
      if (keys.has(key)) push('error', target, `${where}: same parameters as another constructor`)
      keys.add(key)
      checkMessage({ ...c, name: m.name, returns: null }, target, where)
      checkParams(c.params, target, path)
      if (c.defaulted && c.deleted) push('error', target, `${where}: cannot be both defaulted and deleted`)
      else if (c.defaulted && c.params.length)
        push('error', target, `${where}: a defaulted constructor has no parameters`)
      if (c.explicit && !c.params.length)
        push('warning', target, `${where}: explicit has no effect without parameters`)
      for (const prm of c.params) {
        const a = attributes.get(prm.name)
        if (!a) continue
        if (a.static)
          push('error', target, `${where}: ${prm.name} is a static attribute, constructors do not set it`)
        else if (typeKey(a.type) !== typeKey(prm.type))
          push('error', target, `${where}: ${prm.name} is not of the type of the attribute it sets`)
        else if (prm.direction !== 'in')
          push('error', target, `${where}: ${prm.name} sets the attribute: an in parameter`)
      }
    }
    for (const n of duplicates((m.locks ?? []).map((l) => l.name)))
      push('error', target, `${path}: duplicate lock '${n}'`)
    const members = new Set([...m.attributes.map((a) => a.name), ...m.methods.map((x) => x.name)])
    for (const l of m.locks ?? [])
      if (members.has(l.name)) push('error', target, `${path}: lock '${l.name}' has the name of a member`)
    for (const a of m.attributes)
      if (a.ownership === 'owned' && m.copy === 'default')
        push('error', target, `${path}.${a.name}: owned modules are not copied (copy: default)`)
    if (m.kind === 'interface' && ctors.length)
      push('error', target, `${path}: an interface module has no constructors`)
    // Const attributes get their value from their default, else from every constructor.
    const live = ctors.filter((c) => !c.deleted)
    for (const a of m.attributes)
      if (a.const && !a.static && a.default === undefined) {
        if (!ctors.length)
          push(
            'warning',
            target,
            `${path}.${a.name}: const, without a default value nor constructors setting it`
          )
        for (const c of live)
          if (!c.params.some((prm) => prm.name === a.name))
            push('error', target, `${ctorWhere(c)}: leaves const attribute ${a.name} unset`)
      }
    const virtuals =
      m.methods.some((x) => x.virtual) || ancestors.some((b) => baseMethods(b).some((x) => x.virtual))
    if (m.destructor?.virtual === false && virtuals && !m.destructor.access)
      push('warning', target, `${path}: virtual methods, but a public destructor that is not virtual`)
    const publicCtors = ctors.filter((c) => !c.deleted && !c.access)
    switch (m.instantiation) {
      case 'singleton':
        for (const c of publicCtors)
          push('error', target, `${ctorWhere(c)}: constructors of a singleton are not public`)
        if (m.copy && m.copy !== 'delete')
          push('error', target, `${path}: a singleton is not copied (copy: delete)`)
        if (m.move && m.move !== 'delete')
          push('error', target, `${path}: a singleton is not moved (move: delete)`)
        break
      case 'utility':
        if (live.length)
          push('error', target, `${path}: a utility module is not instantiated (no constructors)`)
        for (const a of m.attributes)
          if (!a.static) push('error', target, `${path}.${a.name}: members of a utility module are static`)
        for (const x of m.methods)
          if (!x.static) push('error', target, `${path}.${x.name}: members of a utility module are static`)
        if (m.ports.length) push('error', target, `${path}: a utility module has no ports`)
        break
      case 'value':
        if (m.kind) push('error', target, `${path}: a value module is a class (not ${m.kind})`)
        for (const x of m.methods)
          if (x.virtual) push('error', target, `${path}.${x.name}: a value module has no virtual methods`)
        if (m.copy === 'delete') push('error', target, `${path}: a value module is copied (not copy: delete)`)
        if (m.ports.length) push('warning', target, `${path}: a value module with ports`)
        break
    }
  }

  const checkMessage = (m: Message, target: ProblemTarget, where: string): void => {
    for (const n of duplicates(m.params.map((prm) => prm.name)))
      push('error', target, `${where}: duplicate parameter '${n}'`)
    for (const prm of m.params) checkTypeRef(prm.type, target, `${where}(${prm.name})`)
    if (m.returns) checkTypeRef(m.returns, target, `${where} returns`)
    for (const id of m.raises ?? []) {
      const e = types.get(id)
      if (!e) push('error', target, `${where} ${missingText(id, 'exception', 'type', 'raises')}`)
      else if (e.kind !== 'exception')
        push('error', target, `${where} raises '${e.name}', which is not an exception`)
    }
    for (const id of duplicates(m.raises ?? []))
      push('error', target, `${where} raises '${types.get(id)?.name ?? id}' more than once`)
  }

  // Interfaces
  for (const i of p.interfaces) {
    const target = { kind: 'interface', id: i.id } as const
    if (isReservedTypeName(i.name)) push('error', target, `'${i.name}' is a reserved type name`)
    if (!i.messages.length) push('warning', target, `Interface '${i.name}' has no messages`)
    for (const n of duplicates(i.messages.map((m) => m.name)))
      push('error', target, `Interface '${i.name}': duplicate message '${n}'`)
    for (const m of i.messages) checkMessage(m, target, `${i.name}.${m.name}`)
  }

  // Modules
  const siblings = new Map<Id | null, string[]>()
  for (const m of p.modules) siblings.set(m.parentId, [...(siblings.get(m.parentId) ?? []), m.name])
  for (const [parentId, names] of siblings)
    for (const n of duplicates(names))
      push(
        'error',
        parentId ? { kind: 'module', id: parentId } : { kind: 'project' },
        `Duplicate module name '${n}'`
      )
  // Type references name top-level modules as types: a type of the same name hides the module.
  const globalNames = new Set(globalTypeNames(p))
  for (const m of p.modules)
    if (!m.parentId && globalNames.has(m.name))
      push(
        'warning',
        { kind: 'module', id: m.id },
        `Module '${m.name}' has the name of a type, interface or constant: '${m.name}' in a type names that one`
      )
  // Binaries
  for (const n of duplicates(p.binaries.map((b) => b.name)))
    push('error', { kind: 'project' }, `Duplicate binary name '${n}'`)
  for (const b of p.binaries)
    if (!IDENTIFIER_RE.test(b.name))
      push('error', { kind: 'project' }, `Binary '${b.name}': not an identifier`)
  const binaryNames = new Map(p.binaries.map((b) => [b.id, b.name]))
  const binaries = binariesOf(p)

  for (const m of p.modules) {
    const target = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    if (m.binaryId && !binaryNames.has(m.binaryId)) push('error', target, `${path}: runs in a deleted binary`)
    else if (p.binaries.length && !m.parentId && !m.binaryId)
      push('error', target, `${path}: runs in no binary (the project has binaries)`)
    for (const n of duplicates(m.ports.map((pt) => pt.name)))
      push('error', target, `${path}: duplicate port '${n}'`)
    const ownTypes = moduleTypes(p, m.id)
    for (const n of duplicates(ownTypes.map((t) => t.name)))
      push('error', target, `${path}: duplicate type '${n}'`)
    const members = new Set(memberNames(p, m))
    for (const t of ownTypes)
      if (members.has(t.name))
        push('error', target, `${path}: '${t.name}' is both a type and a member or submodule`)
    for (const n of duplicates(m.attributes.map((a) => a.name)))
      push('error', target, `${path}: duplicate attribute '${n}'`)
    for (const a of m.attributes) {
      checkTypeRef(a.type, target, `${path}.${a.name}`)
      checkDefault(a, target, `${path}.${a.name}`)
      checkAttribute(m, a, target, `${path}.${a.name}`)
    }
    // Overloads share a name, with other parameter types or const.
    for (const n of duplicates(m.methods.map(overloadName)))
      push('error', target, `${path}: duplicate method '${n.slice(0, n.indexOf('('))}'`)
    const attributes = new Set(m.attributes.map((a) => a.name))
    const ancestors = ancestorModules(p, m.id)
    for (const x of m.methods) {
      const where = `${path}.${x.name}`
      if (x.static && x.const) push('error', target, `${where}: a static method cannot be const`)
      if (x.static && x.virtual) push('error', target, `${where}: a static method cannot be virtual`)
      const virtualOnly = x.pure ? 'pure' : x.override ? 'override' : x.final ? 'final' : null
      if (virtualOnly && !x.virtual)
        push('error', target, `${where}: a ${virtualOnly} method must be virtual`)
      if (x.pure && x.final) push('error', target, `${where}: a pure method cannot be final`)
      if (x.nodiscard && !x.returns) push('warning', target, `${where}: nodiscard but returns nothing`)
      if (x.pure && !m.kind)
        push('error', target, `${where}: pure method in a concrete module (make it abstract or an interface)`)
      if (m.kind === 'interface' && !x.pure)
        push('error', target, `${where}: methods of an interface module must be pure`)
      // The overload of the same parameters, else (for an override) the only one of the name.
      const virtuals = (a: (typeof ancestors)[number]) =>
        baseMethods(a).filter((y) => y.name === x.name && y.virtual)
      const inherited =
        ancestors
          .map((a) => ({ base: a, method: virtuals(a).find((y) => overloadKey(y) === overloadKey(x)) }))
          .find((e) => e.method) ??
        (x.override
          ? ancestors.map((a) => ({ base: a, method: virtuals(a)[0] })).find((e) => e.method)
          : undefined)
      if (inherited?.method!.final)
        push('error', target, `${where}: overrides final ${modulePath(p, inherited.base.id)}.${x.name}`)
      else if (inherited?.method!.noexcept && !x.noexcept)
        push(
          'warning',
          target,
          `${where}: not noexcept, as ${modulePath(p, inherited.base.id)}.${x.name} it overrides is`
        )
      if (x.override) {
        if (!inherited) push('error', target, `${where}: overrides no virtual method of a base`)
        else if (methodSignature(x) !== methodSignature(inherited.method!))
          push(
            'error',
            target,
            `${where}: signature differs from ${modulePath(p, inherited.base.id)}.${x.name} it overrides`
          )
        else if ((x.access ?? 'public') !== (inherited.method!.access ?? 'public'))
          push(
            'warning',
            target,
            `${where}: access differs from ${modulePath(p, inherited.base.id)}.${x.name} it overrides`
          )
      } else if (inherited && !inherited.method!.final)
        push(
          'warning',
          target,
          `${where}: hides virtual ${modulePath(p, inherited.base.id)}.${x.name} (mark it override)`
        )
      if (attributes.has(x.name))
        push('error', target, `${path}: '${x.name}' is both an attribute and a method`)
      checkMessage(x, target, `${path}.${x.name}`)
      checkParams(x.params, target, `${path}.${x.name}`)
    }
    checkLifecycle(m, target, path, ancestors)
    checkGenerics(m, target, path)
    checkContracts(m, target, path, ancestors)
    if (m.kind === 'interface' && m.attributes.length)
      push('error', target, `${path}: an interface module cannot have attributes`)
    const bases = m.bases ?? []
    for (const b of bases)
      if (!baseModule(p, b))
        push(
          'error',
          target,
          `${path} derives from a deleted module${isImportedId(b) ? ' of a dependency' : ''}`
        )
    if (m.final && m.kind)
      push(
        'error',
        target,
        `${path}: ${m.kind === 'abstract' ? 'an abstract' : 'an interface'} module cannot be final`
      )
    for (const b of bases)
      if (b !== m.id && baseModule(p, b)?.final)
        push('error', target, `${path} derives from final module ${modulePath(p, b)}`)
    if (bases.includes(m.id)) push('error', target, `${path} derives from itself`)
    else if (bases.some((b) => ancestorModules(p, b).some((a) => a.id === m.id)))
      push('error', target, `${path} derives from itself through its bases`)
    for (const id of duplicates(bases))
      push('error', target, `${path} derives from ${modulePath(p, id)} more than once`)
    if (!m.kind)
      for (const { base, method } of unimplementedMethods(p, m.id))
        push(
          'error',
          target,
          `${path} does not implement pure method ${modulePath(p, base.id)}.${method.name} (implement it or make the module abstract)`
        )
    for (const pt of m.ports) {
      if (!pt.interfaceId) push('warning', target, `${path}:${pt.name} has no interface`)
      else if (!interfaces.has(pt.interfaceId))
        push('error', target, `${path}:${pt.name} ${missingText(pt.interfaceId, 'interface', 'interface')}`)
    }
  }

  // Dependencies
  const project = { kind: 'project' } as const
  for (const n of duplicates(p.dependencies.map((x) => x.name)))
    push('error', project, `Duplicate dependency name '${n}'`)
  for (const n of duplicates(p.dependencies.map((x) => normalizeFile(x.file))))
    push('error', project, `Dependency file '${n}' listed more than once`)
  const dependencyByName = new Map(p.dependencies.map((x) => [x.name, x]))
  /** Dependencies whose entities those of `id` may use: itself and the ones it uses, directly or not. */
  const reach = (id: Id, seen = new Set<Id>()): Set<Id> => {
    if (seen.has(id)) return seen
    seen.add(id)
    const dep = p.dependencies.find((x) => x.id === id)
    for (const u of dep?.uses ?? []) {
      const used = dependencyByName.get(u)
      if (used) reach(used.id, seen)
    }
    return seen
  }
  for (const x of p.dependencies) {
    if (!x.file.trim()) push('warning', project, `Dependency '${x.name}' has no file`)
    for (const u of x.uses)
      if (!dependencyByName.has(u))
        push('error', project, `Dependency '${x.name}' uses unknown dependency '${u}'`)
    if (
      x.uses.some((u) => {
        const used = dependencyByName.get(u)
        return !!used && reach(used.id).has(x.id)
      })
    )
      push('error', project, `Dependency '${x.name}' uses itself through other dependencies`)
  }
  // Types of modules: public ones anywhere, the others in modules only, as their access allows.
  const qualified = typeNames(p)
  const rank = { public: 0, protected: 1, private: 2 } as const
  for (const { ref, where, owner, access } of allTypeRefs(p)) {
    if (fromLibrary.has(owner.id)) continue
    const context = refContext(p, owner)
    walkTypeRef(ref, (n) => {
      const used = n.kind === 'ref' && types.get(n.id)
      if (!used || !isModuleType(used)) return
      const name = qualified.get(used.id)!
      const target = { kind: owner.kind, id: owner.id }
      const of = used.module ? modulePath(p, used.module) : used.modulePath
      if (!context && !canUseType(p, context, used))
        push(
          'error',
          target,
          `${where}: '${name}' is a ${used.access} type of module ${of}, used by modules only`
        )
      else if (!canUseType(p, context, used))
        push('error', target, `${where}: '${name}' is ${used.access ?? 'public'} in ${of}`)
      // Type parameters stand for their arguments: any member uses them.
      else if (
        access &&
        rank[used.access ?? 'public'] > rank[access] &&
        !(used.kind === 'primitive' && used.typeParam)
      )
        push('warning', target, `${where}: ${access} member uses ${used.access} type '${name}'`)
    })
  }

  const owners = new Map([...p.types, ...p.interfaces, ...p.consts].map((e) => [e.id, e.dependency]))
  const refName = refNamer(p)
  for (const { ref, where, owner } of allTypeRefs(p)) {
    const dependency = owner.kind === 'module' ? undefined : owners.get(owner.id)
    if (!dependency) continue
    const allowed = reach(dependency)
    // Entities held by another dependency count as those of the ones sharing them.
    const shared = new Set(p.dependencies.filter((x) => allowed.has(x.id)).flatMap((x) => x.shared))
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && isModule(n.id)) {
        const of = parseDependencyModuleRef(n.id)
        if (!of || !allowed.has(of.dependency))
          push(
            'error',
            { kind: owner.kind, id: owner.id },
            `${where}: module '${refName(n.id) ?? '?'}' is not in its dependency or the dependencies it uses`
          )
        return
      }
      const used = n.kind === 'ref' && types.get(n.id)
      if (used && (!used.dependency || !allowed.has(used.dependency)) && !shared.has(used.name))
        push(
          'error',
          { kind: owner.kind, id: owner.id },
          `${where}: '${used.name}' is not in its dependency or the dependencies it uses`
        )
    })
  }

  // Links
  for (const n of duplicates(p.links.map((l) => l.name)))
    push('error', { kind: 'project' }, `Duplicate link name '${n}'`)
  const endpoints = new Set<string>()
  // Remote links by the address their server binds, and by shm segment: collisions.
  const servers = new Map<string, string>()
  const segments = new Map<string, string>()
  for (const l of p.links) {
    const target = { kind: 'link', id: l.id } as const
    const from = findPort(p, l.from.moduleId, l.from.portId)
    const to = findPort(p, l.to.moduleId, l.to.portId)
    if (!from || !to) {
      push('error', target, `Link '${l.name}' has a missing endpoint`)
      continue
    }
    const key = `${l.from.portId}->${l.to.portId}`
    if (endpoints.has(key)) push('warning', target, `Link '${l.name}' duplicates another link`)
    endpoints.add(key)
    const [fromRole, toRole] = linkRoles(p, l.from.moduleId, l.to.moduleId)
    if (from.role !== fromRole)
      push('error', target, `Link '${l.name}': source port '${from.name}' must be an '${fromRole}' port`)
    if (to.role !== toRole)
      push('error', target, `Link '${l.name}': target port '${to.name}' must be an '${toRole}' port`)
    // Imported ports use this project's interface of the same name.
    const foreign = [l.from, l.to].flatMap((e) => {
      const name = findImported(p, e.moduleId)?.module.ports.find((pt) => pt.id === e.portId)?.interface
      return name && !p.interfaces.some((i) => i.name === name)
        ? [
            `${modulePath(p, e.moduleId)}:${findPort(p, e.moduleId, e.portId)?.name} uses interface '${name}', not defined in this project`
          ]
        : []
    })
    for (const f of foreign) push('error', target, `Link '${l.name}': ${f}`)
    if (!foreign.length && from.interfaceId !== to.interfaceId)
      push('error', target, `Link '${l.name}': ports use different interfaces`)
    if (isImportedId(l.from.moduleId) && isImportedId(l.to.moduleId))
      push('error', target, `Link '${l.name}' joins two imported modules: one end must be in this project`)
    const c = l.constraints
    const iface = from.interfaceId ? interfaces.get(from.interfaceId) : undefined
    if (iface && c.direction === 'unidirectional')
      for (const m of iface.messages)
        if (m.returns)
          push(
            'error',
            target,
            `Link '${l.name}' is unidirectional but ${iface.name}.${m.name} returns a value`
          )
        else if (m.params.some((prm) => prm.direction !== 'in'))
          push(
            'error',
            target,
            `Link '${l.name}' is unidirectional but ${iface.name}.${m.name} has out parameters`
          )
    if (c.direction === 'unidirectional' && c.ack.required)
      push('error', target, `Link '${l.name}' is unidirectional but requires an ack`)
    if (!c.ack.required && c.ack.timeoutMs !== undefined)
      push('warning', target, `Link '${l.name}': ack timeout set but ack not required`)
    const binaryFrom = binaries.get(l.from.moduleId)
    const binaryTo = binaries.get(l.to.moduleId)
    const between = `binaries ${binaryNames.get(binaryFrom!)} and ${binaryNames.get(binaryTo!)}`
    if (crosses(binaries, l) && !c.remote.enabled)
      push('error', target, `Link '${l.name}' joins ${between}: it must be remote`)
    else if (crosses(binaries, l) && !c.remote.transport)
      push('error', target, `Link '${l.name}' joins ${between}: it needs a transport`)
    else if (c.remote.enabled && !c.remote.transport)
      push('warning', target, `Link '${l.name}' is remote but has no transport`)
    if (c.remote.enabled && binaryFrom && binaryFrom === binaryTo)
      push(
        'warning',
        target,
        `Link '${l.name}' is remote but both ends run in binary ${binaryNames.get(binaryFrom)}`
      )
    if (
      c.remote.transport &&
      !(TRANSPORTS as readonly string[]).includes(c.remote.transport) &&
      !p.transports.includes(c.remote.transport)
    )
      push('warning', target, `Link '${l.name}': unknown transport '${c.remote.transport}'`)
    if (!c.remote.enabled && c.remote.transport)
      push('warning', target, `Link '${l.name}': transport set but link is not remote`)
    const settings = c.remote.settings
    if (!c.remote.enabled && settings)
      push('warning', target, `Link '${l.name}': transport settings set but link is not remote`)
    if (settings && c.remote.enabled) {
      const transport = c.remote.transport
      const foreign = foreignFields(settings, transport)
      if (foreign.length)
        push(
          'warning',
          target,
          `Link '${l.name}': ${foreign.join(', ')} ${foreign.length > 1 ? 'do' : 'does'} not apply to transport '${transport ?? ''}'`
        )
      if (
        (transport === 'http' || transport === 'websocket') &&
        settings.path &&
        !settings.path.startsWith('/')
      )
        push('error', target, `Link '${l.name}': path '${settings.path}' must start with '/'`)
      if (transport === 'shm' && settings.name !== undefined) {
        if (!/^\/?[^/]+$/.test(settings.name) || settings.name.length > 255)
          push('error', target, `Link '${l.name}': shared memory name '${settings.name}' is not valid`)
        const segment = settings.name.replace(/^\//, '')
        const other = segments.get(segment)
        if (other)
          push('warning', target, `Link '${l.name}' uses the shared memory '${segment}' of link '${other}'`)
        else segments.set(segment, l.name)
      }
      const port = settings.server?.port
      const family =
        transport === 'udp'
          ? 'udp'
          : ['tcp', 'http', 'websocket', 'grpc'].includes(transport ?? '')
            ? 'tcp'
            : null
      if (family && port !== undefined) {
        const host = settings.server?.host ?? p.remoteDefaults?.server?.host ?? DEFAULT_HOST
        const key = `${family} ${host}:${port}`
        const other = servers.get(key)
        if (other)
          push('warning', target, `Link '${l.name}' listens on ${family} ${host}:${port}, as link '${other}'`)
        else servers.set(key, l.name)
      }
    }
    if (l.from.moduleId === l.to.moduleId)
      push('warning', target, `Link '${l.name}' loops back on the same module`)
  }

  return problems
}

export const hasErrors = (problems: Problem[]): boolean => problems.some((pr) => pr.severity === 'error')
