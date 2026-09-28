// Syntax coloring of the project text (YAML or JSON), line by line: good enough for the files the
// app writes and for hand edits, not a full parser.
import type { Format } from '@/model/serialize'

export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'comment' | 'punct'

export interface Token {
  text: string
  /** Absent for plain text (spaces, line breaks). */
  kind?: TokenKind
}

const NUMBER =
  /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.Inf|\.nan|\.NaN)$/
const LITERAL = /^(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/
const FLOW_PUNCT = '[]{},:'
/** `key:` at the start of a YAML line (after the indent and the `- ` of sequence items). */
const YAML_KEY =
  /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s#'"[\]{},|>&*!%@`-][^#]*?|-[^\s#][^#]*?)(\s*)(:)(?=\s|$)/
/** Block scalar header: `|`, `>-`, `|2+`... */
const BLOCK_SCALAR = /^[|>][-+]?\d*[-+]?(?=\s|$)/

function scalarKind(text: string): TokenKind {
  return NUMBER.test(text) ? 'number' : LITERAL.test(text) ? 'literal' : 'string'
}

/** End (exclusive) of the quoted string starting at `from`; the line end when unclosed. */
function quoteEnd(line: string, from: number): number {
  const q = line[from]
  for (let i = from + 1; i < line.length; i++) {
    if (q === '"' && line[i] === '\\') i++
    else if (line[i] === q) {
      // '' escapes a quote in single-quoted YAML.
      if (q === "'" && line[i + 1] === "'") i++
      else return i + 1
    }
  }
  return line.length
}

/** JSON, and YAML flow collections (`[a, b]`, `{k: v}`) and quoted values. */
function flow(line: string, from: number, out: Token[], yaml: boolean): void {
  let i = from
  while (i < line.length) {
    const c = line[i]!
    let end: number
    if (c === ' ' || c === '\t') {
      end = i + 1
      while (line[end] === ' ' || line[end] === '\t') end++
      out.push({ text: line.slice(i, end) })
    } else if (yaml && c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      out.push({ text: line.slice(i), kind: 'comment' })
      return
    } else if (c === '"' || (yaml && c === "'")) {
      end = quoteEnd(line, i)
      const isKey = /^\s*:/.test(line.slice(end))
      out.push({ text: line.slice(i, end), kind: isKey ? 'key' : 'string' })
    } else if (FLOW_PUNCT.includes(c)) {
      end = i + 1
      out.push({ text: c, kind: 'punct' })
    } else {
      end = i + 1
      while (end < line.length && !FLOW_PUNCT.includes(line[end]!) && !/\s/.test(line[end]!)) end++
      const word = line.slice(i, end)
      const isKey = yaml && /^\s*:(?:\s|$)/.test(line.slice(end))
      out.push({ text: word, kind: isKey ? 'key' : scalarKind(word) })
    }
    i = end
  }
}

/** Plain YAML value: up to a ` #` comment. */
function plainValue(line: string, from: number, out: Token[]): void {
  const rest = line.slice(from)
  const hash = rest.search(/(?:^|\s)#/)
  const value = hash < 0 ? rest : rest.slice(0, hash)
  const trimmed = value.trimEnd()
  if (trimmed) out.push({ text: trimmed, kind: scalarKind(trimmed) })
  if (value.length > trimmed.length) out.push({ text: value.slice(trimmed.length) })
  if (hash >= 0) out.push({ text: rest.slice(hash), kind: 'comment' })
}

function yaml(text: string): Token[] {
  const out: Token[] = []
  /** Column a block scalar's lines are indented beyond, while inside one. */
  let block: number | null = null
  for (const [n, line] of text.split('\n').entries()) {
    if (n) out.push({ text: '\n' })
    if (!line) continue
    const indent = /^[ \t]*/.exec(line)![0]
    if (block !== null) {
      if (!line.trim() || indent.length > block) {
        out.push({ text: indent }, { text: line.slice(indent.length), kind: 'string' })
        continue
      }
      block = null
    }
    if (indent) out.push({ text: indent })
    let i = indent.length
    // Sequence items: `- `, possibly nested (`- - a`).
    for (let m; (m = /^-(?:\s+|$)/.exec(line.slice(i))); i += m[0].length) {
      out.push({ text: '-', kind: 'punct' })
      if (m[0].length > 1) out.push({ text: m[0].slice(1) })
    }
    const start = i
    const rest = line.slice(i)
    if (rest.startsWith('#')) {
      out.push({ text: rest, kind: 'comment' })
      continue
    }
    if (rest === '---' || rest === '...') {
      out.push({ text: rest, kind: 'punct' })
      continue
    }
    const key = YAML_KEY.exec(rest)
    if (key) {
      out.push({ text: key[1]!, kind: 'key' })
      if (key[2]) out.push({ text: key[2] })
      out.push({ text: ':', kind: 'punct' })
      i += key[0].length
      const space = /^\s*/.exec(line.slice(i))![0]
      if (space) out.push({ text: space })
      i += space.length
    }
    const value = line.slice(i)
    if (!value) continue
    const header = BLOCK_SCALAR.exec(value)
    if (header) {
      out.push({ text: header[0], kind: 'punct' })
      plainValue(line, i + header[0].length, out)
      block = start
    } else if ('"\'[{'.includes(value[0]!)) flow(line, i, out, true)
    else if (value.startsWith('#')) out.push({ text: value, kind: 'comment' })
    else plainValue(line, i, out)
  }
  return out
}

function json(text: string): Token[] {
  const out: Token[] = []
  for (const [n, line] of text.split('\n').entries()) {
    if (n) out.push({ text: '\n' })
    flow(line, 0, out, false)
  }
  return out
}

/** Tokens covering the whole text, in order. */
export function highlight(text: string, format: Format): Token[] {
  return format === 'json' ? json(text) : yaml(text)
}

/** What is drawn for one token or one whitespace character. */
export interface Piece extends Token {
  /** Leading or trailing whitespace, and tabs: drawn as a dot or an arrow when shown. */
  ws?: 'space' | 'tab'
  /** Indent guide at the left of this character. */
  guide?: boolean
  /** Not in the text: carries a guide across a blank line. */
  virtual?: boolean
}

/** Width of an indent level: the smallest indent of the text, 2 when none. */
function indentUnit(indents: number[]): number {
  const set = indents.filter((n) => n > 0)
  return set.length ? Math.min(...set) : 2
}

/** Tokens split in lines, with whitespace and indent guides. */
export function layoutLines(text: string, format: Format): Piece[][] {
  const lines: Token[][] = [[]]
  for (const t of highlight(text, format)) {
    if (t.text === '\n' && !t.kind) lines.push([])
    else lines[lines.length - 1]!.push(t)
  }
  const texts = lines.map((l) => l.map((t) => t.text).join(''))
  const blank = texts.map((t) => !t.trim())
  const spaces = texts.map((t) => /^ */.exec(t)![0].length)
  const unit = indentUnit(spaces.filter((_, i) => !blank[i]))
  // A blank line takes the guides of the lines around it (the smaller of both indents).
  const guides = spaces.slice()
  for (let i = 0, prev = 0; i < lines.length; i++) {
    if (!blank[i]) {
      prev = spaces[i]!
      continue
    }
    const next = spaces.find((_, j) => j > i && !blank[j]) ?? 0
    guides[i] = Math.min(prev, next)
  }
  return lines.map((tokens, i) => {
    const line = texts[i]!
    const lead = /^[ \t]*/.exec(line)![0].length
    const trail = line.trimEnd().length
    const out: Piece[] = []
    let col = 0
    const guideAt = (c: number): boolean => c < guides[i]! && c % unit === 0
    for (const t of tokens) {
      let plain = ''
      const flush = (): void => {
        if (plain) out.push(t.kind ? { text: plain, kind: t.kind } : { text: plain })
        plain = ''
      }
      for (const ch of t.text) {
        const ws = ch === '\t' ? 'tab' : ch === ' ' && (col < lead || col >= trail) ? 'space' : undefined
        if (ws) {
          flush()
          out.push({ text: ch, ws, ...(ws === 'space' && col < lead && guideAt(col) ? { guide: true } : {}) })
        } else plain += ch
        col++
      }
      flush()
    }
    // Blank lines shorter than their guides.
    for (; col < guides[i]!; col++)
      out.push({ text: ' ', virtual: true, ...(guideAt(col) ? { guide: true } : {}) })
    return out
  })
}

/** Colored copy of the text, one block per line, as DOM nodes (no HTML parsing of user text). */
export function highlightNodes(text: string, format: Format): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const line of layoutLines(text, format)) {
    const row = document.createElement('div')
    for (const p of line) {
      if (!p.kind && !p.ws && !p.guide) {
        row.append(p.text)
        continue
      }
      const span = document.createElement('span')
      span.className = [p.kind && `tok-${p.kind}`, p.ws && `ws ws-${p.ws}`, p.guide && 'guide']
        .filter(Boolean)
        .join(' ')
      span.textContent = p.text
      row.append(span)
    }
    // An empty line still takes up its line height.
    if (!line.length) row.append('\u200b')
    fragment.append(row)
  }
  return fragment
}
