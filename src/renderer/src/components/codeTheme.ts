// Code editor colors from the app's CSS variables: they follow the light, dark and VS Code themes.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { liquidDelimiter, liquidPunctuation } from './liquidSyntax'

const MONO = "ui-monospace, 'SF Mono', Consolas, monospace"

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--panel)',
    fontSize: 'var(--code-font-size, 12px)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: `var(--code-font-family, ${MONO})`,
    lineHeight: 'var(--code-line-height, 1.5)'
  },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent)',
    borderRadius: '2px',
    outline: 'none'
  },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--panel-2)',
    borderRight: '1px solid var(--border)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
  '.cm-foldMarker': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '100%',
    cursor: 'pointer'
  },
  '.cm-foldMarker svg': {
    width: '14px',
    height: '14px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.5',
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  },
  '.cm-foldMarker:hover': { color: 'var(--text)' },
  '.cm-foldPlaceholder': {
    color: 'var(--muted)',
    backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)'
  },
  '.cm-highlightSpace': {
    backgroundImage: 'radial-gradient(circle at 50% 55%, var(--border) 15%, transparent 5%)'
  },
  '.cm-highlightTab': { color: 'var(--border)' },
  // Columns from `indentGuides.ts`: a 1px line every `--indent-width` columns over `--indent-columns`.
  '.cm-indentGuides': {
    backgroundImage:
      'repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px calc(var(--indent-width) * 1ch))',
    backgroundSize: 'calc(var(--indent-columns) * 1ch) 100%',
    backgroundRepeat: 'no-repeat',
    backgroundOrigin: 'content-box'
  },
  '.cm-tooltip': {
    color: 'var(--text)',
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.2)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: MONO, maxHeight: '220px', maxWidth: '480px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--text)',
    backgroundColor: 'var(--accent-soft)'
  },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', fontFamily: 'system-ui, sans-serif' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-panels': { color: 'var(--text)', backgroundColor: 'var(--panel-2)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  // Panel controls as the app's: more specific than the base theme's light gradients.
  '.cm-panel .cm-textfield': {
    fontSize: 'var(--code-font-size, 12px)',
    color: 'var(--text)',
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: '4px'
  },
  '.cm-panel .cm-button, .cm-panel .cm-button:active': {
    fontSize: 'var(--code-font-size, 12px)',
    color: 'var(--text)',
    backgroundImage: 'none',
    backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px'
  },
  '.cm-panel button[name=close]': { color: 'var(--muted)', backgroundColor: 'transparent', border: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 35%, transparent)'
  },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  // Changes since the last save (unified merge view): the base theme's colors follow no app theme.
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--ok) 10%, transparent)' },
  '&.cm-merge-b .cm-changedText': {
    background: 'color-mix(in srgb, var(--ok) 28%, transparent)'
  },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  '.cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--danger) 28%, transparent)'
  },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--ok)' },
  '.cm-deletedLineGutter': { background: 'var(--danger)' },
  '.cm-deletedChunk button[name=reject]': {
    fontSize: '11px',
    color: 'var(--text)',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px'
  }
})

/** Syntax colors; also read by the minimap. */
export const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword],
    color: 'var(--syn-key)',
    fontWeight: '600'
  },
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: 'var(--syn-key)' },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: 'var(--accent)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal, t.unit], color: 'var(--syn-literal)' },
  { tag: [t.processingInstruction, t.meta, t.macroName], color: 'var(--syn-literal)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--muted)',
    fontStyle: 'italic'
  },
  { tag: [t.punctuation, t.separator, t.bracket, t.brace, t.squareBracket, t.paren], color: 'var(--muted)' },
  { tag: liquidDelimiter, color: 'var(--syn-liquid)', fontWeight: '700' },
  { tag: liquidPunctuation, color: 'var(--syn-liquid)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' }
])

export const codeTheme: Extension = [theme, syntaxHighlighting(highlight)]
