// Completion of the project YAML from the file's JSON Schema: the keys an object may have, and the
// values a key takes (schema enums and constants, booleans, names of the project's interfaces,
// modules and types). The structure around the caret is read from the indentation, so that it
// works on text that does not parse yet.

/** The subset of JSON Schema the file schema uses. */
export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  additionalProperties?: JsonSchema | boolean
  items?: JsonSchema
  required?: string[]
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  $ref?: string
  $defs?: Record<string, JsonSchema>
  description?: string
}

/** Names of the project, for values that reference them. */
export interface ProjectNames {
  interfaces: string[]
  modules: string[]
  types: string[]
}

export interface Completion {
  label: string
  /** Text replacing the word at the caret. */
  insert: string
  detail?: string
}

export interface CompletionResult {
  /** Range of the text the completion replaces. */
  from: number
  to: number
  /** Typed part of the word, which filters the items. */
  prefix: string
  /** A value after `key: ` rather than a key. */
  value: boolean
  items: Completion[]
}

export type Path = (string | number)[]

interface Frame {
  kind: 'map' | 'seq'
  col: number
  /** Map: last key seen, and the scalar values of its keys. */
  key?: string
  values?: Map<string, string>
  /** Sequence: index of the last item. */
  index?: number
}

const KEY_LINE = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s#'"[\]{},:][^#]*?)\s*:(?:\s+(.*?))?\s*$/
const unquote = (s: string): string => (/^["'].*["']$/.test(s) ? s.slice(1, -1) : s)

/**
 * Close the frames deeper than `col`: a key at a column ends the sequences at that column too
 * (`key:` then `- item` at the same indent), an item does not end the mapping owning it.
 */
function popTo(stack: Frame[], col: number, sequences: boolean): void {
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    if (top.col < col || (top.col === col && !(sequences && top.kind === 'seq'))) return
    stack.pop()
  }
}

/** Frames of the mappings and sequences open at the end of `lines`. */
function frames(lines: string[]): Frame[] {
  const stack: Frame[] = []
  /** Column that the lines of a block scalar are indented beyond. */
  let block: number | null = null
  for (const line of lines) {
    const indent = /^ */.exec(line)![0].length
    if (block !== null) {
      if (!line.trim() || indent > block) continue
      block = null
    }
    const content = line.slice(indent)
    if (!content || content.startsWith('#')) continue
    let col = indent
    let rest = content
    // Sequence items.
    for (let m; (m = /^-(?: +|$)/.exec(rest)); rest = rest.slice(m[0].length)) {
      popTo(stack, col, false)
      const top = stack.at(-1)
      if (top?.kind === 'seq' && top.col === col) top.index! += 1
      else stack.push({ kind: 'seq', col, index: 0 })
      col += m[0].length
    }
    const key = KEY_LINE.exec(rest)
    if (!key) continue
    popTo(stack, col, true)
    const name = unquote(key[1]!)
    const value = key[2] ?? ''
    let top = stack.at(-1)
    if (top?.kind !== 'map' || top.col !== col) stack.push((top = { kind: 'map', col, values: new Map() }))
    top.key = name
    if (value && !value.startsWith('#')) top.values!.set(name, unquote(value.replace(/\s+#.*$/, '')))
    if (/^[|>]/.test(value)) block = col
  }
  return stack
}

/** Data path of the value at the top of the frames. */
function pathOf(stack: Frame[]): Path {
  return stack.map((f) => (f.kind === 'map' ? f.key! : f.index!))
}

/**
 * Where the caret is in the data: the path of its line (a key, or the list item it starts), and the
 * `name` (`module` for the modules of an import) of each list item along it, where written above.
 */
export function structureAt(text: string, pos: number): { path: Path; names: (string | undefined)[] } {
  const end = text.indexOf('\n', pos)
  const stack = frames(text.slice(0, end < 0 ? text.length : end).split('\n'))
  const names = stack.map((f, i) => {
    const item = stack[i + 1]
    return f.kind === 'seq' && item?.kind === 'map'
      ? (item.values?.get('name') ?? item.values?.get('module'))
      : undefined
  })
  return { path: pathOf(stack), names }
}

/** Subschemas matching a path; alternatives are kept unless the sibling values rule them out. */
function resolve(root: JsonSchema, path: Path): JsonSchema[] {
  let current = expand(root, [root])
  for (const key of path) {
    const next: JsonSchema[] = []
    for (const s of current) {
      if (typeof key === 'number') {
        if (s.items) next.push(s.items)
      } else if (s.properties?.[key]) next.push(s.properties[key])
      else if (typeof s.additionalProperties === 'object') next.push(s.additionalProperties)
    }
    current = expand(root, next)
  }
  return current
}

/** Dereferenced schemas, with their alternatives flattened. */
function expand(root: JsonSchema, list: JsonSchema[]): JsonSchema[] {
  const out: JsonSchema[] = []
  const visit = (s: JsonSchema): void => {
    if (s.$ref) {
      const name = s.$ref.replace('#/$defs/', '')
      const target = root.$defs?.[name]
      if (target) visit(target)
      return
    }
    const alts = s.anyOf ?? s.oneOf
    if (alts) alts.forEach(visit)
    else out.push(s)
  }
  list.forEach(visit)
  return out
}

/** Constant values a schema allows. */
function allowed(s: JsonSchema): unknown[] | null {
  if (s.const !== undefined) return [s.const]
  if (s.enum) return s.enum
  return null
}

/** Alternatives whose constant properties agree with the values already written. */
function matching(list: JsonSchema[], values: Map<string, string> | undefined): JsonSchema[] {
  if (!values?.size) return list
  const kept = list.filter((s) =>
    [...values].every(([k, v]) => {
      const prop = s.properties?.[k]
      if (!s.properties) return true
      if (!prop) return false
      const values = allowed(prop)
      return !values || values.map(String).includes(v)
    })
  )
  return kept.length ? kept : list
}

const isObject = (s: JsonSchema): boolean => s.type === 'object'
const isArray = (s: JsonSchema): boolean => s.type === 'array'

/** Scalar text of a value: quoted when YAML would read it otherwise. */
function scalar(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  return /^(?:true|false|null|~|[-+.\d].*|.*[:#].*)$/i.test(v) || v === '' ? JSON.stringify(v) : v
}

function keyItems(root: JsonSchema, schemas: JsonSchema[], present: Set<string>, col: number): Completion[] {
  const items = new Map<string, Completion & { required: boolean }>()
  for (const s of schemas)
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (present.has(key) || items.has(key)) continue
      const alts = expand(root, [prop])
      const pad = ' '.repeat(col + 2)
      // Nested objects and lists start on the next line.
      const insert = alts.some(isArray)
        ? `${key}:\n${pad}- `
        : alts.some(isObject)
          ? `${key}:\n${pad}`
          : `${key}: `
      items.set(key, {
        label: key,
        insert,
        detail: prop.description,
        required: !!s.required?.includes(key)
      })
    }
  // Required keys first, then in schema order.
  return [...items.values()]
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map(({ label, insert, detail }) => ({ label, insert, ...(detail ? { detail } : {}) }))
}

function valueItems(schemas: JsonSchema[], path: Path, names: ProjectNames): Completion[] {
  const key = path.at(-1)
  const parent = path.at(-2)
  const values = new Set<unknown>()
  for (const s of schemas) {
    for (const v of allowed(s) ?? []) values.add(v)
    if (s.type === 'boolean') [true, false].forEach((v) => values.add(v))
  }
  const out: Completion[] = [...values].map((v) => ({ label: String(v), insert: scalar(v) }))
  const add = (list: string[], detail: string): void => {
    for (const n of list) if (!values.has(n)) out.push({ label: n, insert: scalar(n), detail })
  }
  if (key === 'interface') add(names.interfaces, 'interface')
  else if (key === 'module' && (parent === 'from' || parent === 'to')) add(names.modules, 'module')
  else if (key === 'root') add(names.modules, 'module')
  return out
}

/** Type names complete the `name` of a `kind: ref` type reference. */
function refNames(values: Map<string, string> | undefined, key: string, names: ProjectNames): Completion[] {
  return key === 'name' && values?.get('kind') === 'ref'
    ? names.types.map((n) => ({ label: n, insert: n, detail: 'type' }))
    : []
}

/** Completions at `pos` in YAML `text`; null where there is nothing to complete. */
export function complete(
  text: string,
  pos: number,
  schema: JsonSchema,
  names: ProjectNames
): CompletionResult | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = text.indexOf('\n', pos)
  const before = text.slice(lineStart, pos)
  const after = text.slice(pos, lineEnd < 0 ? text.length : lineEnd)
  const wordAfter = /^[\w.-]*/.exec(after)![0]
  const head = /^( *)((?:- +)*)/.exec(before)!
  const col = head[0].length
  const rest = before.slice(col)
  // The lines above, and the sequence items starting the caret line (as if an `x` key followed).
  const stack = frames([...text.slice(0, lineStart).split('\n'), head[2] ? `${head[0]}x: ` : ''])

  const keyWord = /^[\w-]*$/.exec(rest)
  if (keyWord) {
    // Key of the mapping at the caret column (a new item of a sequence starts one).
    if (head[2]) stack.pop()
    popTo(stack, col, true)
    const top = stack.at(-1)
    const inMap = top?.kind === 'map' && top.col === col
    const path = inMap ? pathOf(stack).slice(0, -1) : pathOf(stack)
    const siblings = inMap ? top.values : undefined
    const present = new Set(inMap ? [...(top.values?.keys() ?? []), top.key!] : [])
    // Keys written below the caret, in the same mapping.
    for (const line of text.slice(pos).split('\n').slice(1)) {
      const indent = /^ */.exec(line)![0].length
      if (!line.trim()) continue
      if (indent < col) break
      const key = indent === col ? KEY_LINE.exec(line.slice(indent)) : null
      if (key) present.add(unquote(key[1]!))
      else if (indent === col) break
    }
    const schemas = matching(resolve(schema, path).filter(isObject), siblings)
    const items = keyItems(schema, schemas, present, col)
    return {
      from: pos - keyWord[0].length,
      to: pos + wordAfter.length,
      prefix: keyWord[0],
      value: false,
      items
    }
  }

  const valueMatch = KEY_LINE.exec(rest.replace(/\S*$/, '')) ? /^(.*?):\s+(\S*)$/.exec(rest) : null
  if (!valueMatch) return null
  const key = unquote(valueMatch[1]!.trim())
  const prefix = valueMatch[2]!
  if (/^["'[{]/.test(prefix)) return null
  // The key's mapping: the caret line adds or replaces its key.
  popTo(stack, col, true)
  const top = stack.at(-1)
  const inMap = top?.kind === 'map' && top.col === col
  const siblings = inMap ? top.values : undefined
  const path = [...(inMap ? pathOf(stack).slice(0, -1) : pathOf(stack)), key]
  const parents = matching(resolve(schema, path.slice(0, -1)).filter(isObject), siblings)
  const schemas = expand(
    schema,
    parents.flatMap((s) => (s.properties?.[key] ? [s.properties[key]] : []))
  )
  const items = [...valueItems(schemas, path, names), ...refNames(siblings, key, names)]
  return { from: pos - prefix.length, to: pos + wordAfter.length, prefix, value: true, items }
}

/** Items starting with the typed prefix, then those containing it. */
export function filterItems(result: CompletionResult): Completion[] {
  const p = result.prefix.toLowerCase()
  if (!p) return result.items
  const starts = result.items.filter((i) => i.label.toLowerCase().startsWith(p))
  const contains = result.items.filter((i) => !starts.includes(i) && i.label.toLowerCase().includes(p))
  return [...starts, ...contains].filter((i) => i.label !== result.prefix || i.insert !== result.prefix)
}
