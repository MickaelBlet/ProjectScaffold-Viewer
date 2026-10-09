// YAML highlighting: the YAML grammar leaves plain scalars untyped (`content`); this colors values
// by what they resolve to (string, number, boolean, null) and shows top-level keys in bold.
import { yamlLanguage } from '@codemirror/lang-yaml'
import { highlightingFor, LanguageSupport, syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags as t, type Tag } from '@lezer/highlight'

const NULL = /^(?:~|null|Null|NULL)$/
const BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/
const NUMBER =
  /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/

function scalarTag(text: string): Tag {
  if (NULL.test(text)) return t.null
  if (BOOL.test(text)) return t.bool
  if (NUMBER.test(text)) return t.number
  return t.string
}

const section = Decoration.mark({ class: 'cm-yaml-section' })

function decorations(view: EditorView): DecorationSet {
  const { state } = view
  const marks = new Map<Tag, Decoration>()
  const markOf = (tag: Tag, s: EditorState): Decoration | null => {
    let mark = marks.get(tag)
    if (!mark) {
      const cls = highlightingFor(s, [tag])
      if (!cls) return null
      mark = Decoration.mark({ class: cls })
      marks.set(tag, mark)
    }
    return mark
  }
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'Key') {
          // Key > Pair > BlockMapping > Document: a section of the file.
          if (node.node.parent?.parent?.parent?.name === 'Document') builder.add(node.from, node.to, section)
          return false
        }
        if (node.name !== 'Literal' && node.name !== 'BlockLiteralContent') return
        const tag = node.name === 'Literal' ? scalarTag(state.sliceDoc(node.from, node.to)) : t.string
        const mark = markOf(tag, state)
        if (mark) builder.add(node.from, node.to, mark)
      }
    })
  }
  return builder.finish()
}

const scalars = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorations(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = decorations(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

const theme = EditorView.baseTheme({ '.cm-yaml-section': { fontWeight: '600' } })

export function richYaml(): LanguageSupport {
  return new LanguageSupport(yamlLanguage, [scalars, theme])
}
