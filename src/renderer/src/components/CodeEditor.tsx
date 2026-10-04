// Code editor (CodeMirror) for the project text and the other text files: IDL, templates,
// generated code.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionSource
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  LanguageSupport,
  StreamLanguage,
  type StringStream
} from '@codemirror/language'
import { clike } from '@codemirror/legacy-modes/mode/clike'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { lintGutter, lintKeymap } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd
} from '@codemirror/view'
import { useSettings, type Settings } from '@/store/settings'
import { languageOf, type FileLanguage } from './codeLanguages'
import { fixedLiquid } from './liquidSyntax'
import { richYaml } from './yamlSyntax'
import { codeTheme } from './codeTheme'
import { minimap } from './minimap'
import { findWidget, replaceKeymap } from './searchPanel'

const words = (list: string): Record<string, true> =>
  Object.fromEntries(list.split(' ').map((w) => [w, true]))

/** OMG IDL: C-like, with preprocessor lines and annotations. */
const idl = clike({
  name: 'idl',
  keywords: words(
    'module interface struct union switch case default enum bitmask bitset bitfield typedef const exception ' +
      'attribute readonly in out inout oneway raises getraises setraises valuetype eventtype abstract local ' +
      'custom truncatable supports private public factory component connector porttype port mirrorport ' +
      'provides uses multiple home manages primarykey finder emits publishes consumes import typeid typeprefix'
  ),
  types: words(
    'void boolean char wchar octet short long float double int8 uint8 int16 uint16 int32 uint32 int64 ' +
      'uint64 unsigned string wstring sequence map fixed any Object ValueBase native'
  ),
  atoms: words('TRUE FALSE'),
  blockKeywords: words('module interface struct union enum valuetype eventtype component connector home'),
  hooks: {
    '#': (stream: StringStream, state: { startOfLine: boolean }) => {
      if (!state.startOfLine) return false
      stream.skipToEnd()
      return 'meta'
    },
    '@': (stream: StringStream) => {
      stream.eatWhile(/[\w:]/)
      return 'meta'
    }
  }
})

function plainSupport(id: Exclude<FileLanguage['id'], 'liquid'>): LanguageSupport | null {
  switch (id) {
    case 'yaml':
      return richYaml()
    case 'json':
      return json()
    case 'cpp':
      return cpp()
    case 'python':
      return python()
    case 'cmake':
      return new LanguageSupport(StreamLanguage.define(cmake))
    case 'idl':
      return new LanguageSupport(StreamLanguage.define(idl))
    case 'text':
      return null
  }
}

/** The `user` tag of the templates (`codegen/sections.ts`). */
const LIQUID_TAGS = [
  { label: 'user', type: 'keyword', detail: 'user section' },
  { label: 'enduser', type: 'keyword' }
]

/** Syntax support of a file, by its name. */
export function languageSupport(fileName: string): Extension {
  const lang = languageOf(fileName)
  if (lang.id !== 'liquid') return plainSupport(lang.id) ?? []
  const base = lang.base && plainSupport(lang.base)
  return fixedLiquid({ tags: LIQUID_TAGS, ...(base ? { base } : {}) })
}

// Application shortcuts (save, palette...), run before the editor's own keys: set by the keyboard
// setup. True when it ran one.
let passKey: (e: KeyboardEvent) => boolean = () => false

export function setPassedKeys(run: (e: KeyboardEvent) => boolean): void {
  passKey = run
}

/** Runs undo / redo in the focused code editor; false when no code editor has the focus. */
export function focusedEditorHistory(op: 'undo' | 'redo'): boolean {
  const el = document.activeElement
  const view = el instanceof HTMLElement ? EditorView.findFromDOM(el) : null
  if (!view) return false
  return (op === 'undo' ? undo : redo)(view)
}

/** Marks changes made by `setText`: not reported as edits. */
const External = Annotation.define<boolean>()

/** Replaces the text, keeping the selection where the text did not change. */
export function setText(view: EditorView, text: string): void {
  const old = view.state.doc.toString()
  if (old === text) return
  let from = 0
  const max = Math.min(old.length, text.length)
  while (from < max && old.charCodeAt(from) === text.charCodeAt(from)) from++
  let end = 0
  while (end < max - from && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end))
    end++
  view.dispatch({
    changes: { from, to: old.length - end, insert: text.slice(from, text.length - end) },
    annotations: External.of(true)
  })
}

/** Selects a line (from 1) and scrolls it into view. */
export function goToLine(view: EditorView, line: number): void {
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
  view.focus()
  view.dispatch({
    selection: { anchor: l.from, head: l.to },
    effects: EditorView.scrollIntoView(l.from, { y: 'center' })
  })
}

/** Puts the caret at the start of a line (from 1), scrolled into view if outside, keeping the focus. */
export function revealLine(view: EditorView, line: number): void {
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
  const at = l.from + /^\s*/.exec(l.text)![0].length
  const box = view.scrollDOM.getBoundingClientRect()
  const coords = view.coordsAtPos(at)
  const inside = coords !== null && coords.top >= box.top && coords.bottom <= box.bottom
  view.dispatch({
    selection: { anchor: at },
    effects: inside ? [] : EditorView.scrollIntoView(at, { y: 'center' })
  })
}

/** Settings of the code editors (Settings › Text editor). */
type EditorPrefs = Pick<
  Settings,
  | 'editorFontSize'
  | 'editorFontFamily'
  | 'editorLineHeight'
  | 'editorTabSize'
  | 'editorIndentTabs'
  | 'editorWhitespace'
  | 'editorWordWrap'
  | 'editorLineNumbers'
  | 'editorFolding'
  | 'editorActiveLine'
  | 'editorBracketMatching'
  | 'editorCloseBrackets'
  | 'editorAutocomplete'
  | 'editorSelectionMatches'
  | 'editorScrollPastEnd'
  | 'editorMinimap'
  | 'editorMinimapRender'
>

const selectPrefs = (s: Settings): EditorPrefs => ({
  editorFontSize: s.editorFontSize,
  editorFontFamily: s.editorFontFamily,
  editorLineHeight: s.editorLineHeight,
  editorTabSize: s.editorTabSize,
  editorIndentTabs: s.editorIndentTabs,
  editorWhitespace: s.editorWhitespace,
  editorWordWrap: s.editorWordWrap,
  editorLineNumbers: s.editorLineNumbers,
  editorFolding: s.editorFolding,
  editorActiveLine: s.editorActiveLine,
  editorBracketMatching: s.editorBracketMatching,
  editorCloseBrackets: s.editorCloseBrackets,
  editorAutocomplete: s.editorAutocomplete,
  editorSelectionMatches: s.editorSelectionMatches,
  editorScrollPastEnd: s.editorScrollPastEnd,
  editorMinimap: s.editorMinimap,
  editorMinimapRender: s.editorMinimapRender
})

/** The parts of the editor its settings turn on or off; YAML is always indented with spaces. */
function prefsSetup(p: EditorPrefs, fileName: string): Extension {
  const lang = languageOf(fileName).id
  const tabs = p.editorIndentTabs && lang !== 'yaml'
  return [
    p.editorLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    p.editorFolding ? foldGutter() : [],
    p.editorActiveLine ? highlightActiveLine() : [],
    p.editorBracketMatching ? bracketMatching() : [],
    p.editorCloseBrackets ? closeBrackets() : [],
    autocompletion({ activateOnTyping: p.editorAutocomplete }),
    p.editorSelectionMatches ? highlightSelectionMatches() : [],
    p.editorWordWrap ? EditorView.lineWrapping : [],
    p.editorScrollPastEnd ? scrollPastEnd() : [],
    p.editorWhitespace === 'all' ? highlightWhitespace() : [],
    p.editorWhitespace !== 'none' ? highlightTrailingWhitespace() : [],
    p.editorMinimap
      ? minimap({
          render: p.editorMinimapRender,
          selectionMatches: p.editorSelectionMatches,
          brackets: p.editorBracketMatching,
          sections: lang === 'yaml' || lang === 'json' ? lang : 'comments'
        })
      : [],
    EditorState.tabSize.of(p.editorTabSize),
    indentUnit.of(tabs ? '\t' : ' '.repeat(p.editorTabSize))
  ]
}

/** Font of the editor, read by its theme (`codeTheme.ts`). */
const fontStyle = (p: EditorPrefs): CSSProperties =>
  ({
    '--code-font-size': `${p.editorFontSize}px`,
    '--code-line-height': String(p.editorLineHeight),
    ...(p.editorFontFamily.trim() ? { '--code-font-family': p.editorFontFamily } : {})
  }) as CSSProperties

const NONE: Extension = []

const baseSetup: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  rectangularSelection(),
  crosshairCursor(),
  lintGutter(),
  findWidget(),
  // High, not highest: editors flush their pending edits first (highest), shortcuts then see them.
  Prec.high(EditorView.domEventHandlers({ keydown: (e) => passKey(e) })),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...replaceKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
    indentWithTab
  ]),
  codeTheme
]

export interface CodeEditorProps {
  /** Text shown; when it changes to something else than the edited text, it replaces it. */
  value?: string
  /** Name of the file: its language. */
  fileName: string
  label: string
  readOnly?: boolean
  /** Completions, in place of the language's own. */
  completion?: CompletionSource
  /** More extensions; replaced when another value is given. */
  extensions?: Extension
  /** Edits of the user (not `value` or `setText` changes). */
  onChange?: (text: string) => void
  /** Before the editor handles the key. */
  onKeyDown?: (e: KeyboardEvent) => void
  onFocus?: () => void
  onBlur?: () => void
  /** The caret or selection moved while the editor has the focus. */
  onCaret?: (view: EditorView) => void
  /** The editor once created, null when gone. */
  onView?: (view: EditorView | null) => void
}

type Callbacks = Pick<CodeEditorProps, 'onChange' | 'onKeyDown' | 'onFocus' | 'onBlur' | 'onCaret' | 'onView'>

const completionOf = (source: CompletionSource | undefined): Extension =>
  source ? EditorState.languageData.of(() => [{ autocomplete: source }]) : []

export function CodeEditor({
  value,
  fileName,
  label,
  readOnly = false,
  completion,
  extensions = NONE,
  ...handlers
}: CodeEditorProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const parts = useRef({
    language: new Compartment(),
    completion: new Compartment(),
    readOnly: new Compartment(),
    prefs: new Compartment(),
    extra: new Compartment()
  })
  const callbacks = useRef<Callbacks>(handlers)
  useLayoutEffect(() => {
    callbacks.current = handlers
  })
  const prefs = useSettings(useShallow(selectPrefs))

  // Created once; the props below reconfigure it.
  useLayoutEffect(() => {
    const p = parts.current
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value ?? '',
        extensions: [
          baseSetup,
          p.language.of(languageSupport(fileName)),
          p.completion.of(completionOf(completion)),
          p.readOnly.of(EditorState.readOnly.of(readOnly)),
          p.prefs.of(prefsSetup(selectPrefs(useSettings.getState()), fileName)),
          p.extra.of(extensions),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e) => void callbacks.current.onKeyDown?.(e),
              focus: () => void callbacks.current.onFocus?.(),
              blur: () => void callbacks.current.onBlur?.()
            })
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External)))
              callbacks.current.onChange?.(u.state.doc.toString())
            if (u.selectionSet && u.view.hasFocus) callbacks.current.onCaret?.(u.view)
          })
        ]
      })
    })
    view.current = v
    callbacks.current.onView?.(v)
    return () => {
      callbacks.current.onView?.(null)
      view.current = null
      v.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (view.current && value !== undefined) setText(view.current, value)
  }, [value])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.language.reconfigure(languageSupport(fileName)) })
  }, [fileName])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.completion.reconfigure(completionOf(completion)) })
  }, [completion])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.readOnly.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.prefs.reconfigure(prefsSetup(prefs, fileName)) })
  }, [prefs, fileName])
  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.extra.reconfigure(extensions) })
  }, [extensions])

  return <div ref={host} className="code-editor" style={fontStyle(prefs)} />
}
