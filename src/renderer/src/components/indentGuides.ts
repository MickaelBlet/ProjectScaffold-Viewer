// Indentation guides of the code editors, like VS Code's: a vertical line at each indentation level in
// the leading whitespace of the lines, blank lines taking the indentation of the next line with text.
// The guide of the block of the caret is highlighted. Drawn as the line's background (`.cm-indentGuides`
// in `codeTheme.ts`), so the text and caret are untouched.
import { countColumn, RangeSetBuilder, type EditorState, type Text } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'

/** Lines read to guess the indentation width. */
const SAMPLE_LINES = 2000
/** Lines searched below a blank line for one with text. */
const BLANK_LOOKAHEAD = 200

/** Columns of the leading whitespace of a line, -1 when blank. */
function indentOf(text: string, tabSize: number): number {
  const ws = /^[ \t]*/.exec(text)![0]
  return ws.length === text.length ? -1 : countColumn(ws, tabSize)
}

/**
 * Columns per indentation level of the text: the tab size when indented with tabs, else the most frequent
 * step between a line and the next more indented one (1 only when no other: ` * ` of block comments).
 */
function indentWidth(state: EditorState): number {
  const { doc, tabSize } = state
  /** Lines more indented than the previous one with text, by step (up to 8 columns). */
  const steps = new Map<number, number>()
  let tabs = 0
  let spaces = 0
  let prev = 0
  let n = 0
  for (const iter = doc.iterLines(); !iter.next().done && n < SAMPLE_LINES; n++) {
    const text = iter.value
    const col = indentOf(text, tabSize)
    if (col < 0) continue
    if (text.startsWith('\t')) tabs++
    else if (col > 0) spaces++
    if (col > prev && col - prev <= 8) steps.set(col - prev, (steps.get(col - prev) ?? 0) + 1)
    prev = col
  }
  if (tabs > spaces) return tabSize
  let best = 0
  let count = 0
  for (const [step, n] of steps)
    if (step > 1 && (n > count || (n === count && step < best))) [best, count] = [step, n]
  return best || (steps.has(1) ? 1 : tabSize)
}

const decorations = new Map<string, Decoration>()

/** Guides over `columns`, the one at column `active` (when not -1) highlighted. */
function guidesOf(columns: number, width: number, active: number): Decoration {
  const key = `${columns}:${width}:${active}`
  let deco = decorations.get(key)
  if (!deco) {
    deco = Decoration.line(
      active < 0
        ? {
            class: 'cm-indentGuides',
            attributes: { style: `--indent-columns: ${columns}; --indent-width: ${width}` }
          }
        : {
            class: 'cm-indentGuides cm-indentGuides-active',
            attributes: {
              style: `--indent-columns: ${columns}; --indent-width: ${width}; --indent-active: ${active}`
            }
          }
    )
    decorations.set(key, deco)
  }
  return deco
}

/** Columns of the indentation of line `n`; a blank line takes the next line with text's. */
function lineIndent(doc: Text, n: number, tabSize: number): number {
  const last = Math.min(doc.lines, n + BLANK_LOOKAHEAD)
  for (let i = n; i <= last; i++) {
    const col = indentOf(doc.line(i).text, tabSize)
    if (col >= 0) return col
  }
  return 0
}

/** Lines `from`-`to` of the block of the caret, its guide at `column`. */
interface ActiveBlock {
  from: number
  to: number
  column: number
}

/**
 * Block of the main caret, as VS Code's active guide: the lines below a line opening a block (followed by
 * a more indented one), else the lines around the caret more indented than its innermost guide. Only
 * searched up to lines `top`-`bottom` (in view).
 */
function activeBlock(state: EditorState, width: number, top: number, bottom: number): ActiveBlock | null {
  const { doc, tabSize } = state
  const caret = doc.lineAt(state.selection.main.head).number
  const indent = lineIndent(doc, caret, tabSize)
  const opens =
    caret < doc.lines &&
    indentOf(doc.line(caret).text, tabSize) >= 0 &&
    lineIndent(doc, caret + 1, tabSize) > indent
  if (!opens && indent === 0) return null
  const column = opens ? indent : (Math.ceil(indent / width) - 1) * width
  let from = opens ? caret + 1 : caret
  let to = from
  while (from > top && from > 1 && lineIndent(doc, from - 1, tabSize) > column) from--
  while (to < bottom && to < doc.lines && lineIndent(doc, to + 1, tabSize) > column) to++
  return { from, to, column }
}

function guides(view: EditorView, width: number): DecorationSet {
  const { doc, tabSize } = view.state
  const builder = new RangeSetBuilder<Decoration>()
  const { viewport } = view
  const active = activeBlock(
    view.state,
    width,
    doc.lineAt(viewport.from).number,
    doc.lineAt(viewport.to).number
  )
  let last = 0
  // Indentation taken by blank lines up to line `blankUntil`.
  let blankIndent = 0
  let blankUntil = 0
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos)
      pos = line.to + 1
      if (line.number <= last) continue
      last = line.number
      let col = indentOf(line.text, tabSize)
      if (col < 0) {
        if (line.number > blankUntil) {
          blankIndent = 0
          blankUntil = Math.min(doc.lines, line.number + BLANK_LOOKAHEAD)
          for (let n = line.number + 1; n <= blankUntil; n++) {
            const next = indentOf(doc.line(n).text, tabSize)
            if (next >= 0) {
              blankIndent = next
              blankUntil = n
              break
            }
          }
        }
        col = blankIndent
      }
      const levels = Math.ceil(col / width)
      if (levels === 0) continue
      const inBlock = active !== null && line.number >= active.from && line.number <= active.to
      builder.add(line.from, line.from, guidesOf(levels * width, width, inBlock ? active.column : -1))
    }
  }
  return builder.finish()
}

const indentGuidesPlugin = ViewPlugin.fromClass(
  class {
    width: number
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.width = indentWidth(view.state)
      this.decorations = guides(view, this.width)
    }

    update(u: ViewUpdate): void {
      const tabSize = u.state.tabSize !== u.startState.tabSize
      if (u.docChanged || tabSize) this.width = indentWidth(u.state)
      if (u.docChanged || tabSize || u.viewportChanged || u.selectionSet)
        this.decorations = guides(u.view, this.width)
    }
  },
  { decorations: (v) => v.decorations }
)

export const indentGuides = () => indentGuidesPlugin
