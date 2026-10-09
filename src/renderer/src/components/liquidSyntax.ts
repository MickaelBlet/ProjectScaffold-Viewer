// Liquid syntax with whitespace-control end tags in raw blocks: @codemirror/lang-liquid 6.3.3 misses
// `{%- endcomment %}` / `{%- endraw %}` (its raw tokenizers skip no dash), so the block runs to the end
// of the file. Its comment and raw tokenizers are replaced by ones that accept the dash.
// Its delimiters and punctuation get tags of their own, to tell them from the generated code's.
import { LanguageSupport, LRLanguage } from '@codemirror/language'
import { liquid } from '@codemirror/lang-liquid'
import { styleTags, Tag } from '@lezer/highlight'
import { ExternalTokenizer } from '@lezer/lr'

/** `{% %} {{ }}` of Liquid. */
export const liquidDelimiter = Tag.define()
/** Filter pipes, separators, brackets inside Liquid tags and outputs. */
export const liquidPunctuation = Tag.define()

// Terms of the generated lang-liquid parser.
const endrawTagStart = 4
const rawText = 184
const endcommentTagStart = 5
const commentText = 185

const isSpace = (ch: number): boolean => ch === 32 || ch === 9 || ch === 10 || ch === 13

const isWordChar = (ch: number): boolean => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)

/** Text of a raw block up to `{%[-] endTag`, then that tag's start (`{%` or `{%-`). */
function rawTokenizer(endTag: string, text: number, tagStart: number): ExternalTokenizer {
  return new ExternalTokenizer((input) => {
    const start = input.pos
    for (;;) {
      const { next } = input
      if (next < 0) break
      if (next === 123 /* { */ && input.peek(1) === 37 /* % */) {
        const size = input.peek(2) === 45 /* - */ ? 3 : 2
        let scan = size
        while (isSpace(input.peek(scan))) scan++
        let word = ''
        for (let ch = input.peek(scan); isWordChar(ch); ch = input.peek(++scan))
          word += String.fromCharCode(ch)
        if (word === endTag) {
          if (input.pos === start) input.acceptToken(tagStart, size)
          break
        }
      }
      input.advance()
      if (next === 10 /* \n */) break
    }
    if (input.pos > start) input.acceptToken(text)
  })
}

const comment = rawTokenizer('endcomment', commentText, endcommentTagStart)
const raw = rawTokenizer('endraw', rawText, endrawTagStart)

/** `liquid()` with the fixed raw tokenizers and its own delimiter tags. */
export function fixedLiquid(config: Parameters<typeof liquid>[0]): LanguageSupport {
  const support = liquid(config)
  const lang = support.language as LRLanguage
  // Tokenizers of the generated parser (internal field): base, raw, comment, inlineComment, then the
  // grammar's.
  type Tokenizers = [ExternalTokenizer, ExternalTokenizer, ExternalTokenizer]
  const [, oldRaw, oldComment] = (lang.parser as unknown as { tokenizers: Tokenizers }).tokenizers
  const fixed = lang.configure({
    tokenizers: [
      { from: oldRaw, to: raw },
      { from: oldComment, to: comment }
    ],
    props: [
      styleTags({
        '{% %} {{ }}': liquidDelimiter,
        '| : , .. . ( ) [ ]': liquidPunctuation
      })
    ]
  })
  return new LanguageSupport(fixed, support.support)
}
