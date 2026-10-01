// Outline of a project file read from its text (YAML, or JSON parsed as YAML): its sections and
// their named entries, with where they are in the text. Entries written with errors still show.
import YAML, { isMap, isScalar, isSeq, type Node as YamlNode, type YAMLMap } from 'yaml'
import type { FileTypeRef } from './schema'
import { printTypeExpr } from './typeExpr'
import { formatValue } from './defaults'
import { METHOD_QUALIFIERS, type Value } from './types'

export type OutlineKind =
  | 'project'
  | 'section'
  | 'struct'
  | 'enum'
  | 'bitmask'
  | 'union'
  | 'exception'
  | 'alias'
  | 'primitive'
  | 'field'
  | 'value'
  | 'interface'
  | 'constant'
  | 'message'
  | 'module'
  | 'attribute'
  | 'method'
  | 'port'
  | 'dependency'
  | 'link'

type DataPath = (string | number)[]

export interface OutlineNode {
  name: string
  kind: OutlineKind
  detail?: string
  /** Offsets in the text of the whole entry, and of its name. */
  range: [number, number]
  nameRange: [number, number]
  /** Data path of the entry, and the name of the list item at each index of it (see targetAt). */
  path: DataPath
  names: (string | undefined)[]
  children: OutlineNode[]
}

/** How an entry of a list is outlined; null to leave it out. */
type Make = (item: YAMLMap, path: DataPath, names: (string | undefined)[]) => OutlineNode | null

const span = (n: YamlNode | null | undefined): [number, number] | undefined =>
  n?.range ? [n.range[0], n.range[1]] : undefined

function text(map: YAMLMap, key: string): string | undefined {
  const v: unknown = map.get(key)
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

function typeText(map: YAMLMap, key: string): string | undefined {
  const node = map.get(key, true) as YamlNode | undefined
  try {
    return node ? printTypeExpr(node.toJSON() as FileTypeRef) : undefined
  } catch {
    // Incomplete type: no detail.
    return undefined
  }
}

function entry(
  map: YAMLMap,
  kind: OutlineKind,
  path: DataPath,
  names: (string | undefined)[],
  extra: { name?: string; detail?: string; children?: OutlineNode[] } = {}
): OutlineNode {
  const range = span(map) ?? [0, 0]
  const nameNode = map.get('name', true)
  return {
    name: extra.name ?? text(map, 'name') ?? `(${kind})`,
    kind,
    detail: extra.detail,
    range,
    nameRange: (isScalar(nameNode) && span(nameNode)) || range,
    path,
    names,
    children: extra.children ?? []
  }
}

/** Entries of the list at `parent[key]`. */
function list(
  parent: YAMLMap,
  key: string,
  path: DataPath,
  names: (string | undefined)[],
  make: Make
): OutlineNode[] {
  const seq = parent.get(key, true)
  if (!isSeq(seq)) return []
  return seq.items.flatMap((item, i) => {
    if (!isMap(item)) return []
    const node = make(
      item,
      [...path, key, i],
      [...names, undefined, text(item, 'name') ?? text(item, 'module')]
    )
    return node ? [node] : []
  })
}

const TYPE_KINDS = new Set<OutlineKind>([
  'struct',
  'enum',
  'bitmask',
  'union',
  'exception',
  'alias',
  'primitive'
])

/** Qualifiers set on an attribute, method or parameter (`static const`, `virtual pure`). */
function qualifierText(map: YAMLMap): string[] {
  return METHOD_QUALIFIERS.filter((q) => map.get(q) === true)
}

/** Qualifiers and type of a field, followed by its default value if any. */
function valueText(map: YAMLMap): string | undefined {
  const node = map.get('default', true) as YamlNode | undefined
  const type = typeText(map, 'type')
  const typed = node === undefined ? type : `${type ?? ''} = ${formatValue(node.toJSON() as Value)}`
  return [...qualifierText(map), typed].filter(Boolean).join(' ') || undefined
}

/** Type of a union case, then its labels: `Circle (1, 2)`, `Other (default)`. */
function caseText(map: YAMLMap): string | undefined {
  const labels = map.get('labels', true) as YamlNode | undefined
  const shown = [
    ...(isSeq(labels) ? labels.items.map((l) => formatValue((l as YamlNode).toJSON() as Value)) : []),
    ...(map.get('default') === true ? ['default'] : [])
  ]
  const type = typeText(map, 'type')
  return [type, shown.length ? `(${shown.join(', ')})` : ''].filter(Boolean).join(' ') || undefined
}

const field: Make = (item, path, names) => entry(item, 'field', path, names, { detail: valueText(item) })

const type: Make = (item, path, names) => {
  const kind = text(item, 'kind') as OutlineKind | undefined
  if (!kind || !TYPE_KINDS.has(kind)) return entry(item, 'struct', path, names)
  const children =
    kind === 'struct' || kind === 'exception'
      ? list(item, 'fields', path, names, field)
      : kind === 'enum'
        ? list(item, 'values', path, names, (v, p, n) =>
            entry(v, 'value', p, n, { detail: text(v, 'value') })
          )
        : kind === 'bitmask'
          ? list(item, 'flags', path, names, (v, p, n) =>
              entry(v, 'value', p, n, { detail: `1 << ${text(v, 'bit') ?? '?'}` })
            )
          : kind === 'union'
            ? list(item, 'cases', path, names, (v, p, n) => entry(v, 'field', p, n, { detail: caseText(v) }))
            : []
  const detail =
    kind === 'alias'
      ? typeText(item, 'type')
      : kind === 'union'
        ? `switch (${typeText(item, 'discriminator') ?? '?'})`
        : kind === 'enum' || kind === 'bitmask'
          ? text(item, 'underlying')
          : kind
  return entry(item, kind, path, names, { detail, children })
}

/** Interface message or module method, with its parameters. */
const message =
  (kind: 'message' | 'method'): Make =>
  (item, path, names) => {
    const returns = typeText(item, 'returns')
    const detail = [...qualifierText(item), returns && `→ ${returns}`].filter(Boolean)
    return entry(item, kind, path, names, {
      detail: detail.length ? detail.join(' ') : undefined,
      children: list(item, 'params', path, names, field)
    })
  }

const iface: Make = (item, path, names) =>
  entry(item, 'interface', path, names, {
    children: list(item, 'messages', path, names, message('message'))
  })

const port: Make = (item, path, names) =>
  entry(item, 'port', path, names, {
    detail: [text(item, 'role'), text(item, 'interface')].filter(Boolean).join(' ')
  })

/** Kind (unless a class) and bases of a module, else its description. */
function moduleText(map: YAMLMap): string | undefined {
  const kind = text(map, 'kind')
  const bases = map.get('bases', true)
  const names = isSeq(bases) ? bases.items.map((b) => (isScalar(b) ? String(b.value) : '?')) : []
  const detail = [kind !== 'class' && kind, names.length && `: ${names.join(', ')}`].filter(Boolean).join(' ')
  return detail || text(map, 'description')
}

const module: Make = (item, path, names) =>
  entry(item, 'module', path, names, {
    detail: moduleText(item),
    children: [
      ...list(item, 'attributes', path, names, (a, p, n) =>
        entry(a, 'attribute', p, n, { detail: valueText(a) })
      ),
      ...list(item, 'methods', path, names, message('method')),
      ...list(item, 'ports', path, names, port),
      ...list(item, 'modules', path, names, module)
    ]
  })

const constant: Make = (item, path, names) => {
  const node = item.get('value', true) as YamlNode | undefined
  const type = typeText(item, 'type')
  const detail = node === undefined ? type : `${type ?? ''} = ${formatValue(node.toJSON() as Value)}`
  return entry(item, 'constant', path, names, { detail })
}

const dependency: Make = (item, path, names) =>
  entry(item, 'dependency', path, names, {
    detail: text(item, 'file'),
    children: [
      ...list(item, 'types', path, names, type),
      ...list(item, 'interfaces', path, names, iface),
      ...list(item, 'constants', path, names, constant),
      ...list(item, 'modules', path, names, (m, p, n) =>
        entry(m, 'module', p, n, { name: text(m, 'module'), children: list(m, 'ports', p, n, port) })
      )
    ]
  })

function endpoint(map: YAMLMap, key: string): string {
  const end = map.get(key, true)
  if (!isMap(end)) return '?'
  const dep = text(end, 'project')
  return `${dep ? `${dep}/` : ''}${text(end, 'module') ?? '?'}:${text(end, 'port') ?? '?'}`
}

const link: Make = (item, path, names) =>
  entry(item, 'link', path, names, { detail: `${endpoint(item, 'from')} → ${endpoint(item, 'to')}` })

const SECTIONS: [key: string, title: string, make: Make][] = [
  ['types', 'Types', type],
  ['interfaces', 'Interfaces', iface],
  ['constants', 'Constants', constant],
  ['modules', 'Modules', module],
  ['dependencies', 'Dependencies', dependency],
  ['links', 'Links', link]
]

export function outline(source: string): OutlineNode[] {
  const root = YAML.parseDocument(source).contents
  if (!isMap(root)) return []
  const nodes: OutlineNode[] = []
  const project = root.get('project', true)
  if (isMap(project))
    nodes.push(entry(project, 'project', ['project'], [undefined], { name: text(project, 'name') }))
  for (const [key, title, make] of SECTIONS) {
    const pair = root.items.find((p) => isScalar(p.key) && p.key.value === key)
    const keyRange = span(pair?.key)
    const valueRange = span(pair?.value)
    if (!pair || !keyRange || !isSeq(pair.value)) continue
    nodes.push({
      name: title,
      kind: 'section',
      range: [keyRange[0], valueRange?.[1] ?? keyRange[1]],
      nameRange: keyRange,
      path: [key],
      names: [undefined],
      children: list(root, key, [], [], make)
    })
  }
  return nodes
}
