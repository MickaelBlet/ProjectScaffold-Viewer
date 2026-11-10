// Tolerant scan of Scaffold text (`model/dsl.ts` grammar) for the editor: tokens that never throw on
// text being typed, and the `{ … }` pairs that fold.

export interface ScanTok {
  kind: 'ident' | 'string' | 'number' | 'punct'
  text: string
  start: number
}

export interface Scan {
  toks: ScanTok[]
  /** `end` falls inside a comment or a string. */
  inside: boolean
}

const PUNCTS = ['<->', '->', '+=', '{', '}', '(', ')', '[', ']', '<', '>', ',', ';', ':', '=', '.', '/', '?']
const IDENT_START = /[A-Za-z_]/
const IDENT_CHAR = /[A-Za-z0-9_]/
const NUMBER = /-?[0-9][0-9.eE+-]*/y

/** Tokens of `text` up to `end`, comments left out; unknown characters are skipped. */
export function scanDsl(text: string, end = text.length): Scan {
  const toks: ScanTok[] = []
  let i = 0
  while (i < end) {
    const c = text[i]!
    if (/\s/.test(c) || c === '﻿') {
      i++
      continue
    }
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i)
      if (nl < 0 || nl >= end) return { toks, inside: true }
      i = nl
      continue
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2)
      if (close < 0 || close + 2 > end) return { toks, inside: true }
      i = close + 2
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < end && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      if (j >= end) return { toks, inside: true }
      toks.push({ kind: 'string', text: text.slice(i, j + 1), start: i })
      i = j + 1
      continue
    }
    if (IDENT_START.test(c) || c === '`') {
      let j = i + 1
      while (j < end && IDENT_CHAR.test(text[j]!)) j++
      if (c === '`' && text[j] === '`' && j < end) j++
      toks.push({ kind: 'ident', text: text.slice(i, j).replaceAll('`', ''), start: i })
      i = j
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      if (m && !text.startsWith('->', i)) {
        const j = Math.min(i + m[0].length, end)
        toks.push({ kind: 'number', text: text.slice(i, j), start: i })
        i = j
        continue
      }
    }
    const p = PUNCTS.find((s) => text.startsWith(s, i) && i + s.length <= end)
    if (p) toks.push({ kind: 'punct', text: p, start: i })
    i += p?.length ?? 1
  }
  return { toks, inside: false }
}

/** Offsets of a `{` and of its `}`. */
export interface BracePair {
  open: number
  close: number
}

/** The `{ … }` pairs of the text, by opening offset; unmatched braces are left out. */
export function bracePairs(text: string): BracePair[] {
  const pairs: BracePair[] = []
  const stack: number[] = []
  for (const t of scanDsl(text).toks) {
    if (t.text === '{') stack.push(t.start)
    else if (t.text === '}') {
      const open = stack.pop()
      if (open !== undefined) pairs.push({ open, close: t.start })
    }
  }
  return pairs.sort((a, b) => a.open - b.open)
}

/** The fold range of the line `[from, to)`: after its first `{` closed on a later line, to its `}`. */
export function braceFoldAt(
  pairs: BracePair[],
  from: number,
  to: number
): { from: number; to: number } | null {
  // First pair opening at or after `from`.
  let lo = 0
  let hi = pairs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pairs[mid]!.open < from) lo = mid + 1
    else hi = mid
  }
  for (let k = lo; k < pairs.length && pairs[k]!.open < to; k++) {
    const p = pairs[k]!
    if (p.close > to) return { from: p.open + 1, to: p.close }
  }
  return null
}
