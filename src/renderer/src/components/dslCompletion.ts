// Completion of Scaffold text (grammar: docs/scaffold-text.md): the keywords a statement may start
// with in its block, and the types, interfaces, modules, ports and words expected after what is
// written. Read from a tolerant scan, so that it works on text that does not parse yet.
import { dslName } from '@/model/dsl'
import { CONTAINERS, INT_PRIMITIVES, PRIMITIVES } from '@/model/types'
import type { Completion, CompletionResult, ProjectNames } from './completion'
import { scanDsl, type ScanTok } from './dslScan'

type Block =
  'file' | 'module' | 'struct' | 'enum' | 'union' | 'interface' | 'statemachine' | 'dependency' | 'value'

interface Frame {
  /** `{` blocks; `(`, `[` and `<` are groups inside a statement. */
  kind: Block | '(' | '['
  /** Statement holding the group (or the block's head). */
  saved: string[]
  /** Statemachine: states declared so far. */
  states?: string[]
}

const ACCESS = ['public', 'protected', 'private']
const MODIFIERS = new Set([
  ...ACCESS,
  'static',
  'const',
  'mutable',
  'atomic',
  'virtual',
  'pure',
  'override',
  'final',
  'threadSafe',
  'noexcept',
  'nodiscard',
  'explicit'
])
/** Written after a method's parameters, as in C++ (`pure` or `= 0`); not offered before the type. */
const TRAILING = ['const', 'noexcept', 'raises', 'override', 'final', 'pure']
const LEADING = [...MODIFIERS].filter((w) => !['override', 'final', 'noexcept'].includes(w))
const TYPEDEFS = ['struct', 'exception', 'enum', 'bitmask', 'union', 'alias', 'primitive']
const FILE_WORDS = [
  'syntax',
  'project',
  'binary',
  'const',
  ...TYPEDEFS,
  'interface',
  'module',
  'link',
  'dependency'
]
const MODULE_HEAD = ['class', 'abstract', 'interface', 'final']
const MODULE_KINDS = ['class', 'abstract', 'interface']
const MODULE_WORDS = [
  'in',
  'out',
  'constructor',
  'destructor',
  'lock',
  'invariant',
  'statemachine',
  'module',
  ...MODULE_KINDS,
  ...TYPEDEFS,
  ...LEADING,
  'void'
]
const CLAUSES = ['ack', 'realtime', 'low', 'normal', 'bulk', 'latency', 'rate', 'remote']
const PARAM_WORDS = ['in', 'out', 'inout', 'const']

const words = (list: Iterable<string>, detail = 'keyword'): Completion[] =>
  [...new Set(list)].map((w) => ({ label: w, insert: w, detail }))
const names = (list: string[], detail: string): Completion[] =>
  list.map((n) => ({ label: n, insert: dslName(n), detail }))

/** Kind of block a `{` opens after the statement head `t`. */
function blockOf(t: string[], parent: Frame | undefined): Block {
  if (parent && (parent.kind === 'value' || parent.kind === '(' || parent.kind === '[')) return 'value'
  if (t.includes('=')) return 'value'
  if (t.includes('module')) return 'module'
  for (const w of t) {
    if (w === 'struct' || w === 'exception') return 'struct'
    if (w === 'enum' || w === 'bitmask') return 'enum'
    if (w === 'union' || w === 'interface' || w === 'statemachine' || w === 'dependency') return w
  }
  return 'value'
}

const isBlock = (f: Frame | undefined): boolean =>
  !f || (f.kind !== '(' && f.kind !== '[' && f.kind !== 'value')

/** Where the caret is: the open frames and the tokens of its statement (groups as `()`, `[]`, `{}`). */
function context(toks: ScanTok[]): { stack: Frame[]; stmt: string[] } {
  const stack: Frame[] = []
  let stmt: string[] = []
  for (const tok of toks) {
    const t = tok.kind === 'string' ? '"' : tok.kind === 'number' ? '0' : tok.text
    const top = stack.at(-1)
    if (t === '{') {
      stack.push({ kind: blockOf(stmt, top), saved: stmt, states: [] })
      stmt = []
    } else if (t === '(' || t === '[') {
      stack.push({ kind: t, saved: stmt })
      stmt = []
    } else if (t === '}' || t === ')' || t === ']') {
      const open = t === '}' ? '{' : t === ')' ? '(' : '['
      let at = stack.length - 1
      while (
        at >= 0 &&
        (open === '{' ? stack[at]!.kind === '(' || stack[at]!.kind === '[' : stack[at]!.kind !== open)
      )
        at--
      if (at < 0) continue
      const frame = stack[at]!
      stack.length = at
      // A block ends its statement; a group or a value is part of it.
      stmt = isBlock(frame) ? [] : [...frame.saved, `${open}${t}`]
    } else if (t === ';') {
      if (top?.kind === 'statemachine') {
        const s = stmt.indexOf('state')
        if (s >= 0 && stmt[s + 1]) top.states!.push(stmt[s + 1]!)
      }
      if (isBlock(top)) stmt = []
      else stmt.push(t)
    } else stmt.push(t)
  }
  return { stack, stmt }
}

/** Index of the last top-level (outside `<>`) occurrence of one of `marks`, -1 when none. */
function lastTop(t: string[], marks: string[]): number {
  let depth = 0
  for (let i = t.length - 1; i >= 0; i--) {
    const w = t[i]!
    if (w === '>') depth++
    else if (w === '<') depth--
    else if (depth <= 0 && marks.includes(w)) return i
    if (depth < 0) depth = 0
  }
  return -1
}

/** A type is expected after the tokens `t` written from where a type starts. */
function typeExpected(t: string[]): boolean {
  if (!t.length) return true
  const last = t.at(-1)!
  let depth = 0
  for (const w of t) depth += w === '<' ? 1 : w === '>' ? -1 : 0
  return depth > 0 && (last === '<' || last === ',')
}

const after = (t: string[], word: string): string[] => t.slice(t.indexOf(word) + 1)

interface Lists {
  types: Completion[]
  interfaces: Completion[]
  modules: Completion[]
}

function lists(n: ProjectNames): Lists {
  const placed = Object.entries(n.placed).flatMap(([d, paths]) => paths.map((p) => `${d}/${p}`))
  return {
    types: [
      ...words(PRIMITIVES, 'primitive'),
      ...words(CONTAINERS, 'container'),
      ...names(n.types, 'type'),
      ...names([...n.modules, ...placed], 'module')
    ],
    interfaces: names(n.interfaces, 'interface'),
    modules: names(n.modules, 'module')
  }
}

/** Link ends: module paths, then their ports (`Module.port`, `Dependency/Module.port`). */
function endpoints(n: ProjectNames): Completion[] {
  const placed = Object.entries(n.placed).flatMap(([d, paths]) => paths.map((p) => `${d}/${p}`))
  const all = [...n.modules, ...placed]
  return [
    ...names(all, 'module'),
    ...all.flatMap((m) =>
      names(
        (n.ports?.[m] ?? []).map((p) => `${m}.${p}`),
        'port'
      )
    )
  ]
}

/** Head of a definition (module, typedef, constant), after access and modifiers. */
function headItems(t: string[], l: Lists): Completion[] | null {
  const first = t[0]
  const last = t.at(-1)!
  if (first === 'const') return typeExpected(t.slice(1)) ? l.types : null
  if (first === 'alias') return t.includes('=') ? (typeExpected(after(t, '=')) ? l.types : null) : null
  if (first === 'enum' || first === 'bitmask') return last === ':' ? words(INT_PRIMITIVES, 'primitive') : null
  if (t.includes('module')) {
    const impl = t.indexOf('implements')
    if (impl >= 0) return last === 'implements' || last === ',' ? l.interfaces : null
    const colon = t.indexOf(':')
    if (colon >= 0 && (last === ':' || last === ',')) return l.modules
    if (colon >= 0 && last !== '<') return words(['implements'])
    // After the name (and type parameters): `final`, as in C++.
    if (t.at(-2) === 'module' || (last === '>' && !t.includes('<', t.lastIndexOf('>') + 1)))
      return words(t.includes('final') ? ['implements'] : ['final', 'implements'])
    if (last === 'final') return words(['implements'])
    return null
  }
  if (t.every((w) => MODULE_HEAD.includes(w))) return words(['module'])
  return null
}

function linkItems(t: string[], n: ProjectNames): Completion[] | null {
  const colon = t.indexOf(':')
  if (colon < 0) return null
  const last = t.at(-1)!
  if (last === ':' || last === '->' || last === '<->') return endpoints(n)
  return t.some((w) => w === '->' || w === '<->') ? words(CLAUSES) : null
}

/** Qualifiers after a method's parameters `()` not written yet; none after `=` or `[…]`. */
function qualifiers(t: string[], allowed: string[]): Completion[] | null {
  const rest = t.slice(t.indexOf('()') + 1)
  if (rest.includes('=') || rest.includes('[]') || rest.at(-1) === 'raises') return null
  const left = allowed.filter((w) => !rest.includes(w))
  return left.length ? words(left) : null
}

/** Items expected after `t` in a block of `kind`. */
function blockItems(
  kind: Block,
  t: string[],
  frame: Frame | undefined,
  n: ProjectNames,
  l: Lists
): Completion[] | null {
  if (t[0] === 'link') return linkItems(t, n)
  switch (kind) {
    case 'file':
    case 'dependency': {
      if (!t.length) return words(kind === 'file' ? FILE_WORDS : ['const', ...TYPEDEFS, 'interface'])
      const rest = ACCESS.includes(t[0]!) ? t.slice(1) : t
      if (!rest.length) return words(TYPEDEFS)
      return headItems(rest, l)
    }
    case 'module': {
      if (!t.length) return [...words(MODULE_WORDS), ...l.types]
      if ((t[0] === 'in' || t[0] === 'out') && t.length === 1)
        return [{ label: '?', insert: '?', detail: 'no interface yet' }, ...l.interfaces]
      if (t[0] === 'lock') return t.at(-1) === ':' ? words(['mutex', 'shared', 'recursive']) : null
      if (t.includes('constructor')) return t.at(-1) === '=' ? words(['default', 'delete']) : null
      if (t[0] === 'invariant' || t[0] === 'destructor' || t[0] === 'statemachine') return null
      let i = 0
      while (i < t.length && MODIFIERS.has(t[i]!) && !(t[i] === 'final' && t[i + 1] === 'module')) i++
      const rest = t.slice(i)
      if (!rest.length) {
        const typedefs = t.every((w) => ACCESS.includes(w)) ? TYPEDEFS : []
        return [...words([...LEADING, ...typedefs, 'void', 'constructor', 'destructor']), ...l.types]
      }
      if ([...TYPEDEFS, ...MODULE_HEAD, 'module'].includes(rest[0]!)) return headItems(rest, l)
      if (rest.includes('()')) return qualifiers(rest, TRAILING)
      return typeExpected(rest) ? l.types : null
    }
    case 'struct':
      return typeExpected(t) ? l.types : null
    case 'interface':
      if (t.includes('()')) return qualifiers(t, ['raises'])
      return !t.length ? [...words(['void']), ...l.types] : typeExpected(t) ? l.types : null
    case 'union': {
      if (!t.length) return words(['case'])
      return t[0] === 'case' && t.includes(':') && typeExpected(after(t, ':')) ? l.types : null
    }
    case 'statemachine': {
      const states = words(frame?.states ?? [], 'state')
      if (!t.length) return [...words(['initial', 'state', 'final']), ...states]
      const last = t.at(-1)!
      if (last === 'initial' || last === '->') return states
      if (t.length === 1 && last === 'final') return words(['state'])
      return null
    }
    default:
      return null
  }
}

/** Items in a `( … )` group: parameters, `raises (…)`, `switch (…)`. */
function groupItems(frame: Frame, t: string[], l: Lists): Completion[] | null {
  const owner = frame.saved.at(-1)
  if (owner === 'raises') return t.length === 0 || t.at(-1) === ',' ? l.types : null
  if (owner === 'switch') return typeExpected(t) ? l.types : null
  // Parameters: the one being written, after its direction and `const`.
  const param = t.slice(lastTop(t, [',']) + 1)
  let i = 0
  while (i < param.length && PARAM_WORDS.includes(param[i]!)) i++
  const rest = param.slice(i)
  if (!rest.length) return [...words(PARAM_WORDS.filter((w) => !param.includes(w))), ...l.types]
  return typeExpected(rest) ? l.types : null
}

/** Completions at `pos` in Scaffold `text`; null where there is nothing to complete. */
export function completeDsl(text: string, pos: number, n: ProjectNames): CompletionResult | null {
  if (scanDsl(text, pos).inside) return null
  const lineEnd = text.indexOf('\n', pos)
  const wordAfter = /^[\w.]*/.exec(text.slice(pos, lineEnd < 0 ? text.length : lineEnd))![0]
  const prefix = /(?:[A-Za-z_][\w]*(?:[./][\w]*)*)?$/.exec(text.slice(0, pos))![0]
  if (/[\w`]/.test(text[pos - prefix.length - 1] ?? '')) return null
  const { stack, stmt } = context(scanDsl(text, pos - prefix.length).toks)
  const frame = stack.at(-1)
  const l = lists(n)
  const items =
    frame?.kind === '('
      ? groupItems(frame, stmt, l)
      : frame?.kind === '[' || frame?.kind === 'value'
        ? null
        : blockItems(frame?.kind ?? 'file', stmt, frame, n, l)
  if (!items) return null
  return { from: pos - prefix.length, to: pos + wordAfter.length, prefix, value: false, items }
}
