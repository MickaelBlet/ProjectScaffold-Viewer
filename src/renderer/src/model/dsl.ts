// Scaffold text syntax (`*.scaffold`): a compact, .proto-like form of the project file, read into the
// same data as YAML/JSON (then checked by the schema) and written from it. Grammar: docs/dsl.md.
// Every property has a generic form (`key = value;`, `key += item;`, `[key = value]`), so any file
// data round-trips; sugar covers types, interfaces, constants, modules and links.
// Ported to Rust by scaffold-gen (src/model/dsl.rs): change both together.
import { PRIMITIVES } from './types'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }
type DataPath = (string | number)[]

export class DslError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message)
  }
}

// Lexer

type TokKind = 'ident' | 'string' | 'number' | 'punct' | 'doc' | 'eof'
interface Tok {
  kind: TokKind
  /** Source text; a string's value, a doc comment's text, an escaped identifier's name. */
  text: string
  line: number
  start: number
  end: number
  escaped?: boolean
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
const IDENT_START = /[A-Za-z_]/
const IDENT_CHAR = /[A-Za-z0-9_]/
const PUNCTS = ['<->', '->', '+=', '{', '}', '(', ')', '[', ']', '<', '>', ',', ';', ':', '=', '.', '/', '?']

function lex(text: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const n = text.length
  while (i < n) {
    const c = text[i]!
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++
      continue
    }
    if (text.startsWith('//', i)) {
      let end = text.indexOf('\n', i)
      if (end < 0) end = n
      if (text.startsWith('///', i) && text[i + 3] !== '/') {
        let doc = text.slice(i + 3, end)
        if (doc.endsWith('\r')) doc = doc.slice(0, -1)
        if (doc.startsWith(' ')) doc = doc.slice(1)
        toks.push({ kind: 'doc', text: doc, line, start: i, end })
      }
      i = end
      continue
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new DslError('unterminated comment', line)
      for (let k = i; k < end; k++) if (text[k] === '\n') line++
      i = end + 2
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < n && IDENT_CHAR.test(text[j]!)) j++
      toks.push({ kind: 'ident', text: text.slice(i, j), line, start: i, end: j })
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < n && IDENT_CHAR.test(text[j]!)) j++
      const name = text.slice(i + 1, j)
      if (text[j] !== '`' || !IDENT_START.test(name[0] ?? '')) throw new DslError('invalid `name`', line)
      toks.push({ kind: 'ident', text: name, line, start: i, end: j + 1, escaped: true })
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') {
        if (text[j] === '\n') throw new DslError('unterminated string', line)
        j += text[j] === '\\' ? 2 : 1
      }
      if (j >= n) throw new DslError('unterminated string', line)
      let value: unknown
      try {
        value = JSON.parse(text.slice(i, j + 1))
      } catch {
        throw new DslError('invalid string', line)
      }
      toks.push({ kind: 'string', text: value as string, line, start: i, end: j + 1 })
      i = j + 1
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      if (m) {
        const j = i + m[0].length
        if (j < n && (IDENT_CHAR.test(text[j]!) || text[j] === '.'))
          throw new DslError(`invalid number '${text.slice(i, j + 1)}'`, line)
        toks.push({ kind: 'number', text: m[0], line, start: i, end: j })
        i = j
        continue
      }
    }
    const p = PUNCTS.find((s) => text.startsWith(s, i))
    if (!p) throw new DslError(`unexpected character '${c}'`, line)
    toks.push({ kind: 'punct', text: p, line, start: i, end: i + p.length })
    i += p.length
  }
  toks.push({ kind: 'eof', text: '', line, start: n, end: n })
  return toks
}

const describe = (t: Tok): string =>
  t.kind === 'eof'
    ? 'end of file'
    : t.kind === 'string'
      ? JSON.stringify(t.text)
      : t.kind === 'doc'
        ? 'a documentation comment'
        : t.escaped
          ? `\`${t.text}\``
          : `'${t.text}'`

// Parser

const PRIMS = new Set<string>(PRIMITIVES)
const TYPEDEFS = new Set(['struct', 'exception', 'enum', 'bitmask', 'union', 'alias', 'primitive'])
const ACCESS = ['public', 'protected', 'private']
const KINDS = ['class', 'abstract', 'interface']
const MODIFIERS = new Set([
  ...ACCESS,
  ...KINDS,
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
const ATTRIBUTE_MODS = new Set([...ACCESS, 'static', 'const', 'mutable', 'atomic'])
const METHOD_MODS = new Set([
  ...ACCESS,
  'static',
  'const',
  'virtual',
  'pure',
  'override',
  'final',
  'threadSafe',
  'noexcept',
  'nodiscard'
])
const MODULE_MODS = new Set([...KINDS, 'final'])
const PERF = new Set(['realtime', 'low', 'normal', 'bulk'])
const CLAUSES = new Set(['ack', 'latency', 'rate', 'remote', ...PERF])
const UNSAFE_INT = /^-?[0-9]+$/

const pathKey = (p: DataPath): string => p.join('\u0001')

/** Sets a key, `__proto__` included, as JSON.parse does. */
function put(o: Obj, k: string, v: Json): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
}

interface Doc {
  text: string
  line: number
}
interface Mod {
  word: string
  line: number
}

class Parser {
  private toks: Tok[]
  private i = 0
  readonly lines = new Map<string, number>()
  /** Each recorded path, in the order of the text. */
  readonly paths: DataPath[] = []

  constructor(readonly text: string) {
    this.toks = lex(text)
  }

  // Tokens

  private peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!
  }
  private next(): Tok {
    const t = this.peek()
    if (t.kind !== 'eof') this.i++
    return t
  }
  private isP(p: string, k = 0): boolean {
    const t = this.peek(k)
    return t.kind === 'punct' && t.text === p
  }
  private isKw(w: string, k = 0): boolean {
    const t = this.peek(k)
    return t.kind === 'ident' && !t.escaped && t.text === w
  }
  private accept(p: string): boolean {
    if (!this.isP(p)) return false
    this.next()
    return true
  }
  private expect(p: string): void {
    if (!this.accept(p)) this.fail(`'${p}'`)
  }
  private expectKw(w: string): void {
    if (!this.isKw(w)) this.fail(`'${w}'`)
    this.next()
  }
  private fail(what: string): never {
    const t = this.peek()
    throw new DslError(`expected ${what}, found ${describe(t)}`, t.line)
  }
  private ident(what = 'a name'): string {
    if (this.peek().kind !== 'ident') this.fail(what)
    return this.next().text
  }
  private rec(path: DataPath, line: number): void {
    const k = pathKey(path)
    if (this.lines.has(k)) return
    this.lines.set(k, line)
    this.paths.push(path)
  }
  private atEnd(closer: '}' | 'eof'): boolean {
    return closer === 'eof' ? this.peek().kind === 'eof' : this.isP('}')
  }
  private closeBody(closer: '}' | 'eof'): void {
    if (closer === '}') this.expect('}')
  }

  private docs(): Doc | undefined {
    if (this.peek().kind !== 'doc') return undefined
    const line = this.peek().line
    const parts: string[] = []
    while (this.peek().kind === 'doc') parts.push(this.next().text)
    return { text: parts.join('\n'), line }
  }
  private noDoc(doc: Doc | undefined): void {
    if (doc) throw new DslError('documentation comment documents nothing', doc.line)
  }
  private describe(o: Obj, path: DataPath, doc: Doc | undefined): void {
    if (!doc) return
    put(o, 'description', doc.text)
    this.rec([...path, 'description'], doc.line)
  }

  // Values

  private number(): Json {
    const t = this.peek()
    if (t.kind !== 'number') this.fail('a number')
    this.next()
    const v = Number(t.text)
    return UNSAFE_INT.test(t.text) && !Number.isSafeInteger(v) ? t.text : v
  }

  /** `a.b.c` */
  private dotted(what = 'a name'): string {
    let s = this.ident(what)
    while (this.isP('.') && this.peek(1).kind === 'ident') {
      this.next()
      s += '.' + this.next().text
    }
    return s
  }

  /** `Dependency/A.B.C` */
  private qualified(what = 'a name'): string {
    let s = this.ident(what)
    if (this.accept('/')) s += '/' + this.ident(what)
    while (this.accept('.')) s += '.' + this.ident(what)
    return s
  }

  value(path: DataPath): Json {
    const t = this.peek()
    this.rec(path, t.line)
    if (this.accept('{')) {
      const o: Obj = {}
      while (!this.accept('}')) {
        const k = this.peek()
        let key: string
        if (k.kind === 'string') key = this.next().text
        else if (k.kind === 'ident') key = this.dotted('a key')
        else if (k.kind === 'number') key = this.next().text
        else this.fail('a key')
        this.expect(':')
        this.rec([...path, key], k.line)
        put(o, key, this.value([...path, key]))
        if (!this.accept(',')) {
          this.expect('}')
          break
        }
      }
      return o
    }
    if (this.accept('[')) {
      const a: Json[] = []
      while (!this.accept(']')) {
        a.push(this.value([...path, a.length]))
        if (!this.accept(',')) {
          this.expect(']')
          break
        }
      }
      return a
    }
    if (t.kind === 'string') return this.next().text
    if (t.kind === 'number') return this.number()
    if (t.kind === 'ident') {
      if (!t.escaped && (t.text === 'true' || t.text === 'false' || t.text === 'null')) {
        this.next()
        return t.text === 'null' ? null : t.text === 'true'
      }
      return this.dotted('a value')
    }
    return this.fail('a value')
  }

  /** `[key = value, …]`: properties of `o`. */
  private options(o: Obj, path: DataPath): void {
    if (!this.accept('[')) return
    while (!this.accept(']')) {
      const line = this.peek().line
      const key = this.ident('a property name')
      this.expect('=')
      this.rec([...path, key], line)
      put(o, key, this.value([...path, key]))
      if (!this.accept(',')) {
        this.expect(']')
        break
      }
    }
  }

  private isGeneric(): boolean {
    return this.peek().kind === 'ident' && (this.isP('=', 1) || this.isP('+=', 1))
  }

  /** `key = value;` or `key += item;` */
  private generic(o: Obj, path: DataPath): void {
    const line = this.peek().line
    const key = this.next().text
    const append = this.next().text === '+='
    if (append) {
      const list = this.list(o, key, path, line)
      list.push(this.value([...path, key, list.length]))
    } else {
      this.rec([...path, key], line)
      put(o, key, this.value([...path, key]))
    }
    this.expect(';')
  }

  /** List `key` of `o`, created when absent. */
  private list(o: Obj, key: string, path: DataPath, line: number): Json[] {
    if (!Object.prototype.hasOwnProperty.call(o, key)) put(o, key, [])
    const l = o[key]
    if (!Array.isArray(l)) throw new DslError(`'${key}' is not a list`, line)
    this.rec([...path, key], line)
    return l
  }

  /** Appends the item `make` builds at its path. */
  private push(o: Obj, key: string, path: DataPath, make: (p: DataPath) => Json): void {
    const line = this.peek().line
    const list = this.list(o, key, path, line)
    const p = [...path, key, list.length]
    this.rec(p, line)
    list.push(make(p))
  }

  // Types

  type(path: DataPath): Obj {
    const t = this.peek()
    this.rec(path, t.line)
    if (t.kind !== 'ident') this.fail('a type')
    if (!t.escaped && PRIMS.has(t.text)) {
      this.next()
      const r: Obj = { kind: 'primitive', name: t.text }
      if (this.accept('(')) {
        r.max = this.number()
        this.expect(')')
      }
      return r
    }
    if (!t.escaped && this.isP('<', 1)) {
      const kind = t.text
      if (['vector', 'list', 'set', 'array', 'optional', 'map'].includes(kind)) {
        this.next()
        this.next()
        let r: Obj
        if (kind === 'map') {
          const key = this.type([...path, 'key'])
          this.expect(',')
          r = { kind, key, value: this.type([...path, 'value']) }
          if (this.accept(',')) r.max = this.number()
        } else {
          r = { kind, of: this.type([...path, 'of']) }
          if (kind === 'array') {
            this.expect(',')
            r.size = this.number()
          } else if (kind !== 'optional' && this.accept(',')) r.max = this.number()
        }
        this.expect('>')
        return r
      }
    }
    const r: Obj = { kind: 'ref', name: this.qualified('a type') }
    if (this.accept('<')) {
      const args: Json[] = []
      do args.push(this.type([...path, 'args', args.length]))
      while (this.accept(','))
      this.expect('>')
      r.args = args
    }
    return r
  }

  /** A result type: `void` (none) or a type. */
  private returns(path: DataPath): Obj | null {
    if (this.isKw('void')) {
      this.rec(path, this.next().line)
      return null
    }
    return this.type(path)
  }

  // Modifiers

  private mods(): Mod[] {
    const out: Mod[] = []
    while (
      this.peek().kind === 'ident' &&
      !this.peek().escaped &&
      MODIFIERS.has(this.peek().text) &&
      !this.isP('=', 1) &&
      !this.isP('+=', 1)
    ) {
      const t = this.next()
      out.push({ word: t.text, line: t.line })
    }
    return out
  }

  private applyMods(o: Obj, mods: Mod[], allowed: Set<string>, what: string): void {
    for (const m of mods) {
      if (!allowed.has(m.word)) throw new DslError(`'${m.word}' does not apply to ${what}`, m.line)
      if (ACCESS.includes(m.word)) o.access = m.word
      else if (KINDS.includes(m.word)) o.kind = m.word
      else o[m.word] = true
    }
  }

  // Files

  file(): Obj {
    const f: Obj = {}
    this.rec([], this.peek().line)
    this.body('top', f, [], 'eof')
    for (const k of ['types', 'interfaces', 'modules', 'links']) if (!(k in f)) f[k] = []
    return f
  }

  /** Statements of a body, until its closer. */
  body(ctx: Ctx, o: Obj, path: DataPath, closer: '}' | 'eof'): void {
    while (!this.atEnd(closer)) {
      if (this.peek().kind === 'eof') this.fail(`'}'`)
      const doc = this.docs()
      if (this.atEnd(closer)) this.noDoc(doc)
      else if (this.isGeneric()) {
        this.noDoc(doc)
        if (ctx === 'top' && this.isKw('syntax')) this.syntax(o)
        else this.generic(o, path)
      } else this.statement(ctx, o, path, doc)
    }
    this.closeBody(closer)
  }

  private syntax(f: Obj): void {
    const line = this.next().line
    this.next()
    const t = this.peek()
    if (t.kind !== 'string') this.fail('"scaffold1"')
    this.next()
    const m = /^scaffold([1-9][0-9]*)$/.exec(t.text)
    if (!m) throw new DslError(`unknown syntax ${JSON.stringify(t.text)}`, t.line)
    this.rec(['schemaVersion'], line)
    f.schemaVersion = Number(m[1])
    this.expect(';')
  }

  private statement(ctx: Ctx, o: Obj, path: DataPath, doc: Doc | undefined): void {
    switch (ctx) {
      case 'top':
        return this.topStatement(o, path, doc)
      case 'dependency':
        return this.dependencyStatement(o, path, doc)
      case 'module':
        return this.moduleStatement(o, path, doc)
      case 'fields':
        return this.push(o, 'fields', path, (p) => this.field(p, doc))
      case 'union':
        return this.push(o, 'cases', path, (p) => this.unionCase(p, doc))
      case 'interface':
        return this.push(o, 'messages', path, (p) => this.message(p, doc, [], false))
      case 'stateMachine':
        return this.stateStatement(o, path, doc)
      case 'generic':
        return this.fail('a property: key = value;')
    }
  }

  private topStatement(f: Obj, path: DataPath, doc: Doc | undefined): void {
    if (this.isKw('project')) {
      this.rec(['project'], this.peek().line)
      f.project = this.project(['project'], doc)
    } else if (this.isKw('binary')) this.push(f, 'binaries', path, (p) => this.binary(p, doc))
    else if (this.isKw('const')) this.push(f, 'constants', path, (p) => this.constant(p, doc))
    else if (this.isKw('link')) this.push(f, 'links', path, (p) => this.link(p, doc))
    else if (this.isKw('dependency')) this.push(f, 'dependencies', path, (p) => this.dependency(p, doc))
    else if (this.peek().kind === 'ident' && !this.peek().escaped && TYPEDEFS.has(this.peek().text))
      this.push(f, 'types', path, (p) => this.typedef(p, doc, []))
    else if (this.isKw('interface') && !this.isKw('module', 1) && !MODIFIERS.has(this.peek(1).text))
      this.push(f, 'interfaces', path, (p) => this.iface(p, doc))
    else {
      const mods = this.mods()
      if (!this.isKw('module')) this.fail('a definition')
      this.push(f, 'modules', path, (p) => this.module(p, doc, mods))
    }
  }

  private dependencyStatement(d: Obj, path: DataPath, doc: Doc | undefined): void {
    if (this.isKw('const')) this.push(d, 'constants', path, (p) => this.constant(p, doc))
    else if (this.isKw('interface')) this.push(d, 'interfaces', path, (p) => this.iface(p, doc))
    else if (this.peek().kind === 'ident' && !this.peek().escaped && TYPEDEFS.has(this.peek().text))
      this.push(d, 'types', path, (p) => this.typedef(p, doc, []))
    else this.fail('a type, an interface, a constant or a property')
  }

  private project(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('project')
    const t = this.peek()
    if (t.kind !== 'string') this.fail('the project name, as a string')
    this.next()
    const o: Obj = { name: t.text }
    this.rec([...path, 'name'], t.line)
    this.describe(o, path, doc)
    this.options(o, path)
    this.expect(';')
    return o
  }

  private binary(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('binary')
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    this.options(o, path)
    this.expect(';')
    return o
  }

  private constant(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('const')
    const type = this.type([...path, 'type'])
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    o.type = type
    this.expect('=')
    o.value = this.value([...path, 'value'])
    this.options(o, path)
    this.expect(';')
    return o
  }

  private dependency(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('dependency')
    const o: Obj = { name: this.ident() }
    this.noDoc(doc)
    const t = this.peek()
    if (t.kind !== 'string') this.fail('the file of the dependency, as a string')
    this.next()
    o.file = t.text
    this.options(o, path)
    if (!this.accept(';')) {
      this.expect('{')
      this.body('dependency', o, path, '}')
    }
    for (const k of ['types', 'interfaces']) if (!(k in o)) o[k] = []
    return o
  }

  private typedef(path: DataPath, doc: Doc | undefined, mods: Mod[]): Obj {
    const kind = this.next().text
    const o: Obj = { kind }
    this.applyMods(o, mods, new Set(ACCESS), 'a type')
    o.name = this.ident()
    this.describe(o, path, doc)
    switch (kind) {
      case 'struct':
      case 'exception':
        this.options(o, path)
        this.expect('{')
        this.body('fields', o, path, '}')
        if (!('fields' in o)) o.fields = []
        break
      case 'enum':
      case 'bitmask': {
        this.expect(':')
        o.underlying = this.ident('an integer type')
        this.options(o, path)
        const key = kind === 'enum' ? 'values' : 'flags'
        this.list(o, key, path, this.peek().line)
        this.expect('{')
        while (!this.accept('}')) {
          this.noDoc(this.docs())
          if (this.accept('}')) break
          this.push(o, key, path, (p) => {
            const v: Obj = { name: this.ident() }
            this.expect('=')
            this.rec([...p, kind === 'enum' ? 'value' : 'bit'], this.peek().line)
            if (kind === 'enum') v.value = this.number()
            else {
              const one = this.peek()
              if (one.kind !== 'number' || one.text !== '1') this.fail(`'1 << bit'`)
              this.next()
              this.expect('<')
              this.expect('<')
              v.bit = this.number()
            }
            this.expect(';')
            return v
          })
        }
        break
      }
      case 'union':
        this.expectKw('switch')
        this.expect('(')
        o.discriminator = this.type([...path, 'discriminator'])
        this.expect(')')
        this.options(o, path)
        this.expect('{')
        this.body('union', o, path, '}')
        if (!('cases' in o)) o.cases = []
        break
      case 'alias':
        this.expect('=')
        o.type = this.type([...path, 'type'])
        this.options(o, path)
        this.expect(';')
        break
      default:
        this.options(o, path)
        this.expect(';')
    }
    return o
  }

  /** `Type name [= value] [options];` */
  private field(path: DataPath, doc: Doc | undefined): Obj {
    const type = this.type([...path, 'type'])
    const o: Obj = { name: this.ident() }
    o.type = type
    this.describe(o, path, doc)
    if (this.accept('=')) o.default = this.value([...path, 'default'])
    this.options(o, path)
    this.expect(';')
    return o
  }

  private unionCase(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('case')
    const labels: Json[] = []
    let isDefault = false
    while (!this.isP(':')) {
      if (this.isKw('default')) {
        this.next()
        isDefault = true
      } else labels.push(this.value([...path, 'labels', labels.length]))
      if (!this.accept(',')) break
    }
    this.expect(':')
    const type = this.type([...path, 'type'])
    const o: Obj = { name: this.ident() }
    o.type = type
    this.describe(o, path, doc)
    if (labels.length) o.labels = labels
    if (isDefault) o.default = true
    this.options(o, path)
    this.expect(';')
    return o
  }

  private iface(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('interface')
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    this.options(o, path)
    this.expect('{')
    this.body('interface', o, path, '}')
    if (!('messages' in o)) o.messages = []
    return o
  }

  /** `Ret name(params) [raises (…)] [options];`: a message, or a method (`method`). */
  private message(path: DataPath, doc: Doc | undefined, mods: Mod[], method: boolean): Obj {
    const returns = this.returns([...path, 'returns'])
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    if (method) this.applyMods(o, mods, METHOD_MODS, 'a method')
    o.params = this.params([...path, 'params'])
    o.returns = returns
    if (this.isKw('raises')) {
      this.next()
      this.rec([...path, 'raises'], this.peek().line)
      const raises: Json[] = []
      this.expect('(')
      while (!this.accept(')')) {
        raises.push(this.qualified('an exception'))
        if (!this.accept(',')) {
          this.expect(')')
          break
        }
      }
      o.raises = raises
    }
    this.options(o, path)
    this.expect(';')
    return o
  }

  private params(path: DataPath): Json[] {
    this.rec(path, this.peek().line)
    this.expect('(')
    const out: Json[] = []
    while (!this.isP(')')) {
      const doc = this.docs()
      const p = [...path, out.length]
      this.rec(p, this.peek().line)
      let direction: string | undefined
      let isConst = false
      while (this.peek().kind === 'ident' && !this.peek().escaped) {
        const w = this.peek().text
        if (w === 'in' || w === 'out' || w === 'inout') direction = w
        else if (w === 'const') isConst = true
        else break
        this.next()
      }
      const type = this.type([...p, 'type'])
      const o: Obj = { name: this.ident() }
      o.type = type
      this.describe(o, p, doc)
      if (direction) o.direction = direction
      if (isConst) o.const = true
      if (this.accept('=')) o.default = this.value([...p, 'default'])
      this.options(o, p)
      out.push(o)
      if (!this.accept(',')) break
    }
    this.expect(')')
    return out
  }

  private module(path: DataPath, doc: Doc | undefined, mods: Mod[]): Obj {
    this.expectKw('module')
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    this.applyMods(o, mods, MODULE_MODS, 'a module')
    if (this.accept('<')) {
      const tps: Json[] = []
      this.rec([...path, 'typeParams'], this.peek().line)
      do {
        const p = [...path, 'typeParams', tps.length]
        this.rec(p, this.peek().line)
        const tp: Obj = { name: this.ident() }
        if (this.accept(':')) tp.constraint = this.ident('numeric or integral')
        if (this.isKw('extends')) {
          this.next()
          tp.derivesFrom = this.qualified('a module')
        }
        if (this.accept('=')) tp.default = this.type([...p, 'default'])
        tps.push(tp)
      } while (this.accept(','))
      this.expect('>')
      o.typeParams = tps
    }
    if (this.accept(':')) {
      this.rec([...path, 'bases'], this.peek().line)
      const bases: Json[] = []
      do bases.push(this.base())
      while (this.accept(','))
      o.bases = bases
    }
    if (this.isKw('implements')) {
      this.next()
      this.rec([...path, 'implements'], this.peek().line)
      const ifs: Json[] = []
      do ifs.push(this.ident('an interface'))
      while (this.accept(','))
      o.implements = ifs
    }
    this.options(o, path)
    this.expect('{')
    this.body('module', o, path, '}')
    if (!('ports' in o)) o.ports = []
    return o
  }

  /** A base: its path, with its type arguments as written (`Box<int32>`). */
  private base(): string {
    const name = this.qualified('a module')
    if (!this.isP('<')) return name
    const start = this.peek().start
    let depth = 0
    let end: number
    do {
      const t = this.next()
      if (t.kind === 'eof') this.fail(`'>'`)
      if (t.kind === 'punct' && t.text === '<') depth++
      else if (t.kind === 'punct' && t.text === '>') depth--
      end = t.end
    } while (depth > 0)
    return name + this.text.slice(start, end)
  }

  private moduleStatement(m: Obj, path: DataPath, doc: Doc | undefined): void {
    if ((this.isKw('in') || this.isKw('out')) && (this.peek(1).kind === 'ident' || this.isP('?', 1))) {
      return this.push(m, 'ports', path, (p) => {
        const role = this.next().text
        const iface = this.accept('?') ? null : this.ident('an interface or ?')
        const o: Obj = { name: this.ident(), role, interface: iface }
        this.describe(o, p, doc)
        this.options(o, p)
        this.expect(';')
        return o
      })
    }
    if (this.isKw('lock')) {
      this.noDoc(doc)
      return this.push(m, 'locks', path, (p) => {
        this.next()
        const o: Obj = { name: this.ident() }
        this.expect(':')
        o.kind = this.ident('mutex, shared or recursive')
        this.options(o, p)
        this.expect(';')
        return o
      })
    }
    if (this.isKw('invariant')) {
      this.noDoc(doc)
      return this.push(m, 'invariants', path, () => {
        this.next()
        const t = this.peek()
        if (t.kind !== 'string') this.fail('a condition, as a string')
        this.next()
        this.expect(';')
        return t.text
      })
    }
    if (this.isKw('statemachine')) {
      this.noDoc(doc)
      const p = [...path, 'stateMachine']
      this.rec(p, this.next().line)
      const sm: Obj = {}
      this.expect('{')
      this.body('stateMachine', sm, p, '}')
      for (const k of ['states', 'transitions']) if (!(k in sm)) sm[k] = []
      m.stateMachine = sm
      return
    }
    const mods = this.mods()
    const t = this.peek()
    if (this.isKw('module')) return this.push(m, 'modules', path, (p) => this.module(p, doc, mods))
    if (t.kind === 'ident' && !t.escaped && TYPEDEFS.has(t.text))
      return this.push(m, 'types', path, (p) => this.typedef(p, doc, mods))
    if (this.isKw('constructor'))
      return this.push(m, 'constructors', path, (p) => {
        this.next()
        const o: Obj = {}
        this.describe(o, p, doc)
        this.applyMods(o, mods, new Set([...ACCESS, 'explicit']), 'a constructor')
        o.params = this.params([...p, 'params'])
        if (this.accept('=')) {
          if (this.isKw('default')) o.defaulted = true
          else if (this.isKw('delete')) o.deleted = true
          else this.fail(`'default' or 'delete'`)
          this.next()
        }
        this.options(o, p)
        this.expect(';')
        return o
      })
    if (this.isKw('destructor')) {
      this.noDoc(doc)
      const p = [...path, 'destructor']
      this.rec(p, this.next().line)
      const o: Obj = {}
      this.applyMods(o, mods, new Set([...ACCESS, 'virtual']), 'a destructor')
      this.options(o, p)
      this.expect(';')
      m.destructor = o
      return
    }
    // An attribute or a method: type (or void) and name, then `(` for a method.
    const start = this.i
    this.returns([])
    this.ident()
    const isMethod = this.isP('(')
    this.i = start
    if (isMethod) return this.push(m, 'methods', path, (p) => this.message(p, doc, mods, true))
    this.push(m, 'attributes', path, (p) => {
      const o = this.field(p, doc)
      this.applyMods(o, mods, ATTRIBUTE_MODS, 'an attribute')
      return o
    })
  }

  private stateStatement(sm: Obj, path: DataPath, doc: Doc | undefined): void {
    if (this.peek().kind === 'ident' && this.isP('->', 1)) {
      this.noDoc(doc)
      return this.push(sm, 'transitions', path, (p) => {
        const o: Obj = { from: this.ident() }
        this.expect('->')
        o.to = this.ident()
        for (;;) {
          if (this.isKw('on')) {
            this.next()
            o.trigger = this.ident('a method')
          } else if (this.isKw('if')) {
            this.next()
            const t = this.peek()
            if (t.kind !== 'string') this.fail('a condition, as a string')
            o.guard = this.next().text
          } else if (this.isKw('do')) {
            this.next()
            o.action = this.ident('a method')
          } else break
        }
        this.options(o, p)
        this.expect(';')
        return o
      })
    }
    if (this.isKw('initial')) {
      this.noDoc(doc)
      this.rec([...path, 'initial'], this.next().line)
      sm.initial = this.ident()
      this.expect(';')
      return
    }
    let isFinal = false
    if (this.isKw('final')) {
      this.next()
      isFinal = true
    }
    if (!this.isKw('state')) this.fail(`'state', a transition 'A -> B' or 'initial'`)
    this.push(sm, 'states', path, (p) => {
      this.next()
      const o: Obj = { name: this.ident() }
      this.describe(o, p, doc)
      if (isFinal) o.final = true
      this.options(o, p)
      this.expect(';')
      return o
    })
  }

  private endpoint(path: DataPath): Obj {
    this.rec(path, this.peek().line)
    const first = this.ident('a module path')
    const o: Obj = {}
    const segs: string[] = []
    if (this.accept('/')) {
      o.project = first
      segs.push(this.ident('a module path'))
    } else segs.push(first)
    while (this.accept('.')) segs.push(this.ident('a module path or a port'))
    if (segs.length < 2) this.fail(`'.port'`)
    o.module = segs.slice(0, -1).join('.')
    o.port = segs[segs.length - 1]!
    return o
  }

  private link(path: DataPath, doc: Doc | undefined): Obj {
    this.expectKw('link')
    const o: Obj = { name: this.ident() }
    this.describe(o, path, doc)
    this.expect(':')
    o.from = this.endpoint([...path, 'from'])
    let direction: string
    if (this.accept('->')) direction = 'unidirectional'
    else if (this.accept('<->')) direction = 'bidirectional'
    else this.fail(`'->' or '<->'`)
    o.to = this.endpoint([...path, 'to'])
    const ack: Obj = { required: false }
    const performance: Obj = { class: 'normal' }
    const remote: Obj = { enabled: false }
    this.rec([...path, 'constraints'], this.peek().line)
    while (this.peek().kind === 'ident' && !this.peek().escaped && CLAUSES.has(this.peek().text)) {
      const w = this.next().text
      if (w === 'ack') {
        ack.required = true
        if (this.peek().kind === 'number') ack.timeoutMs = this.number()
      } else if (PERF.has(w)) performance.class = w
      else if (w === 'latency') performance.maxLatencyMs = this.number()
      else if (w === 'rate') performance.rateHz = this.number()
      else {
        remote.enabled = true
        const t = this.peek()
        if (t.kind === 'string' || (t.kind === 'ident' && (t.escaped || !CLAUSES.has(t.text)))) {
          this.next()
          remote.transport = t.text
        }
        if (this.isP('{')) remote.settings = this.value([...path, 'constraints', 'remote', 'settings'])
      }
    }
    o.constraints = { direction, ack, performance, remote }
    this.options(o, path)
    this.expect(';')
    return o
  }
}

type Ctx = 'top' | 'dependency' | 'module' | 'fields' | 'union' | 'interface' | 'stateMachine' | 'generic'

/** Data of a Scaffold text, with the line of each of its nodes. */
export function parseDslDoc(text: string): { data: Obj; lines: Map<string, number>; paths: DataPath[] } {
  const p = new Parser(text)
  const data = p.file()
  return { data, lines: p.lines, paths: p.paths }
}

/** Data of a Scaffold text (the file data, before the schema check). */
export function parseDsl(text: string): Obj {
  return parseDslDoc(text).data
}

/** Line (from 1) of a path in the data of a Scaffold text: that of its deepest entry found. */
export function dslLineOfPath(text: string, path: DataPath): number | undefined {
  let lines: Map<string, number>
  try {
    lines = parseDslDoc(text).lines
  } catch {
    return undefined
  }
  for (let n = path.length; n >= 0; n--) {
    const l = lines.get(pathKey(path.slice(0, n)))
    if (l !== undefined) return l
  }
  return undefined
}

/**
 * Where a line (from 1) of a Scaffold text is in its data: the deepest path starting last on or
 * before it, and the `name` (`module` for the modules of an import) of each list item along it.
 * Null when the text cannot be read.
 */
export function dslStructureAt(
  text: string,
  line: number
): { path: DataPath; names: (string | undefined)[] } | null {
  let doc: ReturnType<typeof parseDslDoc>
  try {
    doc = parseDslDoc(text)
  } catch {
    return null
  }
  let path: DataPath = []
  let at = 0
  for (const p of doc.paths) {
    const l = doc.lines.get(pathKey(p))!
    if (l > line) continue
    if (l > at || (l === at && p.length > path.length)) {
      path = p
      at = l
    }
  }
  const names: (string | undefined)[] = []
  let node: unknown = doc.data
  for (const key of path) {
    const next: unknown = (node as Record<string | number, unknown> | null | undefined)?.[key]
    const item = Array.isArray(node) && next && typeof next === 'object' ? (next as Obj) : undefined
    const name = item?.name ?? item?.module
    names.push(typeof name === 'string' ? name : undefined)
    node = next
  }
  return { path, names }
}

// Writer

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const QUALIFIED = /^([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
/** Words escaped in type and path positions. */
const RESERVED = new Set([
  ...PRIMS,
  ...TYPEDEFS,
  ...MODIFIERS,
  ...CLAUSES,
  'array',
  'vector',
  'list',
  'set',
  'optional',
  'map',
  'void',
  'module',
  'link',
  'binary',
  'dependency',
  'project',
  'syntax',
  'constructor',
  'destructor',
  'lock',
  'invariant',
  'statemachine',
  'state',
  'initial',
  'in',
  'out',
  'inout',
  'true',
  'false',
  'null',
  'implements',
  'extends',
  'raises',
  'switch',
  'case',
  'default',
  'on',
  'if',
  'do'
])
const WIDTH = 100

/** Thrown by a sugar writer that cannot write an item: the generic form stands in. */
class NoSugar extends Error {}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

const esc = (s: string): string => (RESERVED.has(s) ? `\`${s}\`` : s)
/** A path, its reserved words escaped. */
function escPath(s: string): string {
  if (!QUALIFIED.test(s)) throw new NoSugar()
  return s
    .split('/')
    .map((part) => part.split('.').map(esc).join('.'))
    .join('/')
}

const str = (s: string): string => JSON.stringify(s)
const key = (k: string): string => (DOTTED.test(k) ? k : str(k))

function litOne(v: Json): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') return DOTTED.test(v) && !['true', 'false', 'null'].includes(v) ? v : str(v)
  if (Array.isArray(v)) return `[${v.map(litOne).join(', ')}]`
  const entries = Object.entries(v)
  return entries.length ? `{ ${entries.map(([k, x]) => `${key(k)}: ${litOne(x)}`).join(', ')} }` : '{}'
}

/** A value literal, on several lines (indented by `ind`) when long. */
function lit(v: Json, ind = 0): string {
  const one = litOne(v)
  if (one.length + ind <= WIDTH || v === null || typeof v !== 'object') return one
  const pad = ' '.repeat(ind + 2)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[\n${v.map((x) => pad + lit(x, ind + 2)).join(',\n')}\n${' '.repeat(ind)}]`
  }
  const entries = Object.entries(v)
  if (!entries.length) return '{}'
  return `{\n${entries.map(([k, x]) => `${pad}${key(k)}: ${lit(x, ind + 2)}`).join(',\n')}\n${' '.repeat(ind)}}`
}

function typeStr(t: Json | undefined): string {
  if (!isObj(t)) throw new NoSugar()
  const has = (...keys: string[]) => Object.keys(t).every((k) => keys.includes(k))
  const max = () => (t.max === undefined ? '' : `, ${num(t.max)}`)
  switch (t.kind) {
    case 'primitive':
      if (!has('kind', 'name', 'max') || typeof t.name !== 'string' || !PRIMS.has(t.name)) throw new NoSugar()
      return t.max === undefined ? t.name : `${t.name}(${num(t.max)})`
    case 'array':
      if (!has('kind', 'of', 'size')) throw new NoSugar()
      return `array<${typeStr(t.of)}, ${num(t.size)}>`
    case 'vector':
    case 'list':
    case 'set':
      if (!has('kind', 'of', 'max')) throw new NoSugar()
      return `${t.kind}<${typeStr(t.of)}${max()}>`
    case 'optional':
      if (!has('kind', 'of')) throw new NoSugar()
      return `optional<${typeStr(t.of)}>`
    case 'map':
      if (!has('kind', 'key', 'value', 'max')) throw new NoSugar()
      return `map<${typeStr(t.key)}, ${typeStr(t.value)}${max()}>`
    case 'ref': {
      if (!has('kind', 'name', 'args') || typeof t.name !== 'string') throw new NoSugar()
      const args = t.args
      if (args === undefined) return escPath(t.name)
      if (!Array.isArray(args) || !args.length) throw new NoSugar()
      return `${escPath(t.name)}<${args.map(typeStr).join(', ')}>`
    }
    default:
      throw new NoSugar()
  }
}

function num(v: Json | undefined): string {
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string' && UNSAFE_INT.test(v)) return v
  throw new NoSugar()
}

function name(v: Json | undefined): string {
  if (typeof v !== 'string' || !IDENT.test(v)) throw new NoSugar()
  return v
}

function docLines(d: Json | undefined): string[] {
  if (d === undefined) return []
  if (typeof d !== 'string' || /[\r\u2028\u2029]/.test(d)) throw new NoSugar()
  return d.split('\n').map((l) => (l ? `/// ${l}` : '///'))
}

/** `[key = value, …]` of the keys of `o` not in `used`. */
function opts(o: Obj, used: string[]): string {
  const rest = Object.entries(o).filter(([k]) => !used.includes(k))
  if (!rest.length) return ''
  for (const [k] of rest) if (!IDENT.test(k)) throw new NoSugar()
  return ` [${rest.map(([k, v]) => `${k} = ${lit(v)}`).join(', ')}]`
}

/** Leading modifier words: the `true` flags of `o` among `flags`, its access among `access`. */
function modWords(o: Obj, flags: string[], used: string[], withAccess = true): string {
  const words: string[] = []
  if (withAccess && typeof o.access === 'string' && ACCESS.includes(o.access)) {
    words.push(o.access)
    used.push('access')
  }
  for (const f of flags)
    if (o[f] === true) {
      words.push(f)
      used.push(f)
    }
  return words.map((w) => w + ' ').join('')
}

function fieldLine(f: Obj, used: string[], prefix = ''): string[] {
  used.push('name', 'type', 'description')
  let s = `${prefix}${typeStr(f.type)} ${name(f.name)}`
  if ('default' in f) {
    s += ` = ${lit(f.default)}`
    used.push('default')
  }
  return [...docLines(f.description), s + opts(f, used) + ';']
}

function paramsStr(ps: Json | undefined, method: boolean): string[] {
  if (!Array.isArray(ps)) throw new NoSugar()
  const items = ps.map((p) => {
    if (!isObj(p)) throw new NoSugar()
    const used = ['name', 'type', 'description']
    let s = ''
    if (p.direction !== undefined) {
      if (p.direction !== 'in' && p.direction !== 'out' && p.direction !== 'inout') throw new NoSugar()
      s += p.direction + ' '
      used.push('direction')
    }
    if (method && p.const === true) {
      s += 'const '
      used.push('const')
    }
    s += `${typeStr(p.type)} ${name(p.name)}`
    if (method && 'default' in p) {
      s += ` = ${lit(p.default)}`
      used.push('default')
    }
    return { doc: docLines(p.description), text: s + opts(p, used) }
  })
  const one = `(${items.map((i) => i.text).join(', ')})`
  if (items.every((i) => !i.doc.length) && one.length <= WIDTH) return [one]
  return [
    '(',
    ...items.flatMap((i, n) => [...i.doc, i.text + (n < items.length - 1 ? ',' : '')].map((l) => '  ' + l)),
    ')'
  ]
}

/** Joins a head, parameter lines and a tail into lines. */
function withParams(head: string, params: string[], tail: string): string[] {
  if (params.length === 1) return [head + params[0] + tail]
  return [head + params[0], ...params.slice(1, -1), params[params.length - 1] + tail]
}

function messageLines(m: Obj, mods: string, used: string[], method: boolean): string[] {
  used.push('name', 'description', 'params', 'returns')
  const ret = m.returns === null ? 'void' : typeStr(m.returns)
  let tail = ''
  if (m.raises !== undefined) {
    if (!Array.isArray(m.raises)) throw new NoSugar()
    tail += ` raises (${m.raises.map((r) => escPath(r as string)).join(', ')})`
    used.push('raises')
  }
  const params = paramsStr(m.params, method)
  return [
    ...docLines(m.description),
    ...withParams(`${mods}${ret} ${name(m.name)}`, params, tail + opts(m, used) + ';')
  ]
}

function typedefLines(t: Obj, inModule: boolean): string[] {
  const used = ['kind', 'name', 'description']
  const access = inModule ? modWords(t, [], used) : ''
  const head = `${access}${t.kind as string} ${name(t.name)}`
  const doc = docLines(t.description)
  switch (t.kind) {
    case 'struct':
    case 'exception': {
      used.push('fields')
      if (!Array.isArray(t.fields)) throw new NoSugar()
      const body = t.fields.flatMap((f) => {
        if (!isObj(f)) throw new NoSugar()
        return fieldLine(f, [])
      })
      return [...doc, ...block(head + opts(t, used), body)]
    }
    case 'enum':
    case 'bitmask': {
      const key = t.kind === 'enum' ? 'values' : 'flags'
      used.push('underlying', key)
      const list = t[key]
      if (!Array.isArray(list)) throw new NoSugar()
      const body = list.map((v) => {
        if (!isObj(v)) throw new NoSugar()
        const n = Object.keys(v).length
        if (t.kind === 'enum') {
          if (n !== 2 || typeof v.value !== 'number') throw new NoSugar()
          return `${name(v.name)} = ${num(v.value)};`
        }
        if (n !== 2 || typeof v.bit !== 'number') throw new NoSugar()
        return `${name(v.name)} = 1 << ${num(v.bit)};`
      })
      return [...doc, ...block(`${head} : ${name(t.underlying)}${opts(t, used)}`, body)]
    }
    case 'union': {
      used.push('discriminator', 'cases')
      if (!Array.isArray(t.cases)) throw new NoSugar()
      const body = t.cases.flatMap((c) => {
        if (!isObj(c)) throw new NoSugar()
        const cu = ['name', 'type', 'description']
        const words: string[] = []
        if (Array.isArray(c.labels) && c.labels.length) {
          words.push(...c.labels.map((l) => (l === 'default' ? str(l) : litOne(l))))
          cu.push('labels')
        }
        if (c.default === true) {
          words.push('default')
          cu.push('default')
        }
        const caseHead = words.length ? `case ${words.join(', ')}:` : 'case:'
        return [...docLines(c.description), `${caseHead} ${typeStr(c.type)} ${name(c.name)}${opts(c, cu)};`]
      })
      return [...doc, ...block(`${head} switch (${typeStr(t.discriminator)})${opts(t, used)}`, body)]
    }
    case 'alias':
      used.push('type')
      return [...doc, `${head} = ${typeStr(t.type)}${opts(t, used)};`]
    case 'primitive':
      return [...doc, `${head}${opts(t, used)};`]
    default:
      throw new NoSugar()
  }
}

/** `head {` body `}`, or `head {}` when empty. */
function block(head: string, body: string[]): string[] {
  return body.length ? [`${head} {`, ...body.map((l) => (l ? '  ' + l : l)), '}'] : [`${head} {}`]
}

function interfaceLines(i: Obj): string[] {
  const used = ['name', 'description', 'messages']
  if (!Array.isArray(i.messages)) throw new NoSugar()
  const body = i.messages.flatMap((m) => {
    if (!isObj(m)) throw new NoSugar()
    return messageLines(m, '', [], false)
  })
  return [...docLines(i.description), ...block(`interface ${name(i.name)}${opts(i, used)}`, body)]
}

function endpointStr(e: Json | undefined): string {
  if (!isObj(e) || !Object.keys(e).every((k) => ['project', 'module', 'port'].includes(k)))
    throw new NoSugar()
  if (typeof e.module !== 'string' || !DOTTED.test(e.module)) throw new NoSugar()
  return `${e.project === undefined ? '' : name(e.project) + '/'}${e.module}.${name(e.port)}`
}

function linkLines(l: Obj): string[] {
  const used = ['name', 'description', 'from', 'to']
  const c = l.constraints
  let arrow = '->'
  let clauses = ''
  const sugar = (): string => {
    if (!isObj(c)) throw new NoSugar()
    const { direction, ack, performance, remote } = c
    if (Object.keys(c).length !== 4 || !isObj(ack) || !isObj(performance) || !isObj(remote))
      throw new NoSugar()
    const only = (o: Obj, keys: string[]) => {
      if (!Object.keys(o).every((k) => keys.includes(k))) throw new NoSugar()
    }
    only(ack, ['required', 'timeoutMs'])
    only(performance, ['class', 'maxLatencyMs', 'rateHz'])
    only(remote, ['enabled', 'transport', 'settings'])
    let s = ''
    if (ack.required === true) s += ack.timeoutMs === undefined ? ' ack' : ` ack ${num(ack.timeoutMs)}`
    else if (ack.required !== false || ack.timeoutMs !== undefined) throw new NoSugar()
    if (typeof performance.class !== 'string' || !PERF.has(performance.class)) throw new NoSugar()
    if (performance.class !== 'normal') s += ' ' + performance.class
    if (performance.maxLatencyMs !== undefined) s += ` latency ${num(performance.maxLatencyMs)}`
    if (performance.rateHz !== undefined) s += ` rate ${num(performance.rateHz)}`
    if (remote.enabled === true) {
      s += ' remote'
      if (remote.transport !== undefined) {
        if (typeof remote.transport !== 'string') throw new NoSugar()
        s +=
          ' ' +
          (IDENT.test(remote.transport) && !CLAUSES.has(remote.transport)
            ? remote.transport
            : str(remote.transport))
      }
      if (remote.settings !== undefined) {
        if (!isObj(remote.settings)) throw new NoSugar()
        s += ' ' + litOne(remote.settings)
      }
    } else if (remote.enabled !== false || remote.transport !== undefined || remote.settings !== undefined)
      throw new NoSugar()
    if (direction === 'bidirectional') arrow = '<->'
    else if (direction !== 'unidirectional') throw new NoSugar()
    return s
  }
  try {
    clauses = sugar()
    used.push('constraints')
  } catch (e) {
    if (!(e instanceof NoSugar)) throw e
    arrow = '->'
  }
  return [
    ...docLines(l.description),
    `link ${name(l.name)}: ${endpointStr(l.from)} ${arrow} ${endpointStr(l.to)}${clauses}${opts(l, used)};`
  ]
}

function dependencyLines(d: Obj): string[] {
  const used = ['name', 'file', 'types', 'interfaces', 'constants']
  if (typeof d.file !== 'string') throw new NoSugar()
  const body: string[] = []
  const section = (lines: string[][]) => {
    if (body.length && lines.length) body.push('')
    lines.forEach((l, n) => body.push(...(n ? [''] : []), ...l))
  }
  for (const k of ['types', 'interfaces', 'constants']) {
    const list = d[k]
    if (list === undefined) continue
    if (!Array.isArray(list) || (k === 'constants' && !list.length)) throw new NoSugar()
    section(
      list.map((x) =>
        sugarOr('dependency', k, x, () =>
          k === 'types'
            ? typedefLines(x as Obj, false)
            : k === 'interfaces'
              ? interfaceLines(x as Obj)
              : constantLines(x as Obj)
        )
      )
    )
  }
  for (const k of Object.keys(d)) if (!used.includes(k) && !IDENT.test(k)) throw new NoSugar()
  const rest = Object.entries(d).filter(([k]) => !used.includes(k))
  section(rest.map(([k, v]) => [`${k} = ${lit(v, 2)};`]))
  return block(`dependency ${name(d.name)} ${str(d.file)}`, body)
}

function constantLines(c: Obj): string[] {
  const used = ['name', 'description', 'type', 'value']
  if (!('value' in c)) throw new NoSugar()
  return [
    ...docLines(c.description),
    `const ${typeStr(c.type)} ${name(c.name)} = ${lit(c.value)}${opts(c, used)};`
  ]
}

function attributeLines(a: Obj): string[] {
  const used: string[] = []
  return fieldLine(a, used, modWords(a, ['static', 'const', 'mutable', 'atomic'], used))
}

function methodLines(m: Obj): string[] {
  const used: string[] = []
  const mods = modWords(
    m,
    ['static', 'const', 'virtual', 'pure', 'override', 'final', 'threadSafe', 'noexcept', 'nodiscard'],
    used
  )
  return messageLines(m, mods, used, true)
}

function constructorLines(c: Obj): string[] {
  const used = ['description', 'params']
  const mods = modWords(c, ['explicit'], used)
  let tail = ''
  if (c.defaulted === true) {
    tail = ' = default'
    used.push('defaulted')
  } else if (c.deleted === true) {
    tail = ' = delete'
    used.push('deleted')
  }
  return [
    ...docLines(c.description),
    ...withParams(`${mods}constructor`, paramsStr(c.params, true), tail + opts(c, used) + ';')
  ]
}

function destructorLines(d: Obj): string[] {
  const used: string[] = []
  return [`${modWords(d, ['virtual'], used)}destructor${opts(d, used)};`]
}

function portLines(p: Obj): string[] {
  const used = ['name', 'role', 'interface', 'description']
  if (p.role !== 'in' && p.role !== 'out') throw new NoSugar()
  const iface = p.interface === null ? '?' : name(p.interface)
  return [...docLines(p.description), `${p.role} ${iface} ${name(p.name)}${opts(p, used)};`]
}

function lockLines(l: Obj): string[] {
  return [`lock ${name(l.name)}: ${name(l.kind)}${opts(l, ['name', 'kind'])};`]
}

function stateMachineLines(sm: Obj): string[] {
  const used = ['initial', 'states', 'transitions']
  if (!Array.isArray(sm.states) || !Array.isArray(sm.transitions)) throw new NoSugar()
  const body: string[] = []
  if (sm.initial !== undefined) body.push(`initial ${name(sm.initial)};`)
  for (const s of sm.states) {
    if (!isObj(s)) throw new NoSugar()
    const su = ['name', 'description']
    const fin = s.final === true ? 'final ' : ''
    if (fin) su.push('final')
    body.push(...docLines(s.description), `${fin}state ${name(s.name)}${opts(s, su)};`)
  }
  for (const t of sm.transitions) {
    if (!isObj(t)) throw new NoSugar()
    const tu = ['from', 'to']
    let s = `${name(t.from)} -> ${name(t.to)}`
    if (t.trigger !== undefined) {
      s += ` on ${name(t.trigger)}`
      tu.push('trigger')
    }
    if (t.guard !== undefined) {
      if (typeof t.guard !== 'string') throw new NoSugar()
      s += ` if ${str(t.guard)}`
      tu.push('guard')
    }
    if (t.action !== undefined) {
      s += ` do ${name(t.action)}`
      tu.push('action')
    }
    body.push(s + opts(t, tu) + ';')
  }
  for (const k of Object.keys(sm)) if (!used.includes(k)) body.push(`${k} = ${lit(sm[k]!, 2)};`)
  return block('statemachine', body)
}

/**
 * Lines of an item of the list `key` (or of the property `key` when `single`) in a body of `ctx`:
 * its sugar when it reads back as the same data, else its generic form.
 */
function sugarOr(ctx: Ctx, key: string, item: Json, sugar: () => string[], single = false): string[] {
  const generic = [single ? `${key} = ${lit(item, 0)};` : `${key} += ${lit(item, 0)};`]
  if (!isObj(item)) return generic
  let lines: string[]
  try {
    lines = sugar()
  } catch (e) {
    if (e instanceof NoSugar) return generic
    throw e
  }
  try {
    const p = new Parser(lines.join('\n'))
    const o: Obj = {}
    p.body(ctx, o, [], 'eof')
    return deepEqual(o, { [key]: single ? item : [item] }) ? lines : generic
  } catch (e) {
    if (e instanceof DslError) return generic
    throw e
  }
}

const TYPE_PARAM = (tp: Json): string => {
  if (
    !isObj(tp) ||
    !Object.keys(tp).every((k) => ['name', 'constraint', 'derivesFrom', 'default'].includes(k))
  )
    throw new NoSugar()
  let s = name(tp.name)
  if (tp.constraint !== undefined) {
    if (tp.constraint !== 'numeric' && tp.constraint !== 'integral') throw new NoSugar()
    s += `: ${tp.constraint}`
  }
  if (tp.derivesFrom !== undefined) s += ` extends ${escPath(tp.derivesFrom as string)}`
  if (tp.default !== undefined) s += ` = ${typeStr(tp.default)}`
  return s
}

const BASE =
  /^(([A-Za-z_][A-Za-z0-9_]*\/)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)(<[A-Za-z0-9_.,/ <>]*>)?$/

function baseStr(b: Json): string {
  if (typeof b !== 'string') throw new NoSugar()
  const m = BASE.exec(b)
  if (!m) throw new NoSugar()
  const args = m[4] ?? ''
  let depth = 0
  for (const ch of args) {
    depth += ch === '<' ? 1 : ch === '>' ? -1 : 0
    if (depth < 0) throw new NoSugar()
  }
  if (depth !== 0 || (args && !args.endsWith('>'))) throw new NoSugar()
  // the arguments must read back as written: their closing bracket ends them
  if (
    args &&
    args
      .slice(0, -1)
      .split('')
      .reduce((d, ch) => d + (ch === '<' ? 1 : ch === '>' ? -1 : 0), 0) !== 1
  )
    throw new NoSugar()
  return escPath(m[1]!) + args
}

function moduleLines(m: Obj): string[] {
  const used = ['name', 'description']
  let doc: string[] = []
  try {
    doc = docLines(m.description)
  } catch (e) {
    if (!(e instanceof NoSugar)) throw e
    used.pop()
  }
  let mods = ''
  if (typeof m.kind === 'string' && KINDS.includes(m.kind)) {
    mods += m.kind + ' '
    used.push('kind')
  }
  if (m.final === true) {
    mods += 'final '
    used.push('final')
  }
  let head = `${mods}module ${name(m.name)}`
  const tryPart = (k: string, f: () => string) => {
    if (m[k] === undefined) return
    try {
      head += f()
      used.push(k)
    } catch (e) {
      if (!(e instanceof NoSugar)) throw e
    }
  }
  const nonEmpty = (k: string): Json[] => {
    const v = m[k]
    if (!Array.isArray(v) || !v.length) throw new NoSugar()
    return v
  }
  tryPart('typeParams', () => `<${nonEmpty('typeParams').map(TYPE_PARAM).join(', ')}>`)
  tryPart('bases', () => {
    const bs = nonEmpty('bases').map(baseStr)
    if (bs.some((b) => b === 'implements' || b.startsWith('implements.') || b.startsWith('implements/')))
      throw new NoSugar()
    return ` : ${bs.join(', ')}`
  })
  tryPart('implements', () => ` implements ${nonEmpty('implements').map(name).join(', ')}`)
  const body: string[] = []
  const sep = () => {
    if (body.length && body[body.length - 1] !== '') body.push('')
  }
  const items: Record<string, (x: Obj) => string[]> = {
    types: (x) => typedefLines(x, true),
    attributes: attributeLines,
    constructors: constructorLines,
    methods: methodLines,
    ports: portLines,
    locks: lockLines
  }
  for (const [k, v] of Object.entries(m)) {
    if (used.includes(k)) continue
    if (k === 'ports' && Array.isArray(v) && !v.length) continue
    if (Array.isArray(v) && !v.length) {
      body.push(`${k} = [];`)
      continue
    }
    if (k in items && Array.isArray(v)) {
      sep()
      const each = v.map((x) => sugarOr('module', k, x, () => items[k]!(x as Obj)))
      const multi = each.some((l) => l.length > 1)
      each.forEach((l, n) => body.push(...(multi && n ? [''] : []), ...l))
    } else if (k === 'invariants' && Array.isArray(v)) {
      sep()
      for (const x of v)
        body.push(typeof x === 'string' ? `invariant ${str(x)};` : `invariants += ${lit(x, 0)};`)
    } else if (k === 'destructor') {
      sep()
      body.push(...sugarOr('module', k, v, () => destructorLines(v as Obj), true))
    } else if (k === 'stateMachine') {
      sep()
      body.push(...sugarOr('module', k, v, () => stateMachineLines(v as Obj), true))
    } else if (k === 'modules' && Array.isArray(v)) {
      for (const x of v) {
        sep()
        let lines: string[]
        try {
          if (!isObj(x)) throw new NoSugar()
          lines = moduleLines(x)
        } catch (e) {
          if (!(e instanceof NoSugar)) throw e
          lines = [`modules += ${lit(x, 0)};`]
        }
        body.push(...lines)
      }
    } else if (IDENT.test(k)) body.push(`${k} = ${lit(v, 0)};`)
    else throw new NoSugar()
  }
  while (body[body.length - 1] === '') body.pop()
  return [...doc, ...block(head, body)]
}

/** Scaffold text of file data. */
export function stringifyDsl(file: unknown): string {
  const f = JSON.parse(JSON.stringify(file)) as Obj
  const out: string[] = []
  const add = (lines: string[]) => {
    if (out.length) out.push('')
    out.push(...lines)
  }
  for (const [k, v] of Object.entries(f)) {
    if (k === 'schemaVersion' && typeof v === 'number' && Number.isInteger(v) && v > 0)
      add([`syntax = "scaffold${v}";`])
    else if (k === 'project')
      add(
        sugarOr(
          'top',
          k,
          v,
          () => {
            const p = v as Obj
            if (typeof p.name !== 'string') throw new NoSugar()
            return [...docLines(p.description), `project ${str(p.name)}${opts(p, ['name', 'description'])};`]
          },
          true
        )
      )
    else if (['types', 'interfaces', 'modules', 'links'].includes(k) && Array.isArray(v) && !v.length)
      continue
    else if (Array.isArray(v) && !v.length) add([`${k} = [];`])
    else if (k === 'modules' && Array.isArray(v))
      for (const m of v) {
        let lines: string[]
        try {
          if (!isObj(m)) throw new NoSugar()
          lines = moduleLines(m)
        } catch (e) {
          if (!(e instanceof NoSugar)) throw e
          lines = [`modules += ${lit(m, 0)};`]
        }
        add(lines)
      }
    else if (k === 'binaries' && Array.isArray(v))
      add(
        v.flatMap((b) =>
          sugarOr('top', k, b, () => {
            const o = b as Obj
            return [...docLines(o.description), `binary ${name(o.name)}${opts(o, ['name', 'description'])};`]
          })
        )
      )
    else if (k === 'links' && Array.isArray(v))
      add(v.flatMap((l) => sugarOr('top', k, l, () => linkLines(l as Obj))))
    else if (k === 'constants' && Array.isArray(v))
      add(v.flatMap((c) => sugarOr('top', k, c, () => constantLines(c as Obj))))
    else if ((k === 'types' || k === 'interfaces' || k === 'dependencies') && Array.isArray(v))
      for (const x of v)
        add(
          sugarOr('top', k, x, () =>
            k === 'types'
              ? typedefLines(x as Obj, false)
              : k === 'interfaces'
                ? interfaceLines(x as Obj)
                : dependencyLines(x as Obj)
          )
        )
    else add([`${IDENT.test(k) && k !== 'syntax' ? k : str(k)} = ${lit(v, 0)};`])
  }
  return out.join('\n') + '\n'
}
