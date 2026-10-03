// Minimap of the code editors, like VS Code's: the text drawn small on the right of the editor with
// its syntax colors, a slider over the lines in view, the caret lines, selections, search and
// selection matches, problems and section headers. An overview ruler on its right edge spans the
// whole text.
import { foldedRanges, syntaxTree } from '@codemirror/language'
import { forEachDiagnostic } from '@codemirror/lint'
import { getSearchQuery, SearchCursor, searchPanelOpen } from '@codemirror/search'
import { countColumn, Facet, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'
import { highlight } from './codeTheme'
import {
  mapGeometry,
  placeLabels,
  rowAt,
  rowOfLine,
  rulerRow,
  scrollForDrag,
  visibleLines,
  wrapColumns,
  type MapGeometry,
  type MapInput
} from './minimapGeometry'

export interface MinimapOptions {
  /** Characters shaded by their ink, or solid blocks. */
  render: 'characters' | 'blocks'
  /** Occurrences of the selected text marked. */
  selectionMatches: boolean
  /** Lines shown as section headers: top-level keys (YAML, JSON), or `MARK:` / `#region` comments. */
  sections: 'yaml' | 'json' | 'comments'
}

const config = Facet.define<MinimapOptions, MinimapOptions | null>({ combine: (v) => v[0] ?? null })

/** CSS pixels: height of a line, width of a column. */
const ROW = 2
const COLUMN = 1
const PAD = 4
/** Text area, overview ruler on its right. */
const TEXT_WIDTH = 96
const RULER = 6
const WIDTH = TEXT_WIDTH + RULER
const COLUMNS = Math.floor((TEXT_WIDTH - PAD) / COLUMN)
/** Narrower editors have no minimap. */
const MIN_EDITOR_WIDTH = 360
/** Section header label, its rule above. */
const LABEL_HEIGHT = 11
/** Matches marked at most. */
const MAX_MATCHES = 5000

const HEADERS = {
  yaml: /^([A-Za-z_][\w-]*)\s*:/,
  json: /^(?: {2}|\t)"([^"]+)"\s*:/,
  comments: /(?:\bMARK:\s*-?\s*|#\s*(?:pragma\s+)?region\b\s*)(.*\S)/
}

/** Ink of a character drawn one pixel wide: punctuation light, capitals and digits dark. */
function ink(c: number): number {
  if (c === 46 || c === 44 || c === 39 || c === 96 || c === 58 || c === 59 || c === 45 || c === 95)
    return 0.35
  if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 35 || c === 64 || c === 37 || c === 38) return 0.9
  if (c >= 97 && c <= 122) return 0.7
  return 0.55
}
const BLOCK_INK = 0.6

interface Segment {
  x: number
  w: number
  color: string
  alpha: number
}
/** Columns of a line marked. */
interface Mark {
  line: number
  from: number
  to: number
}
type Severity = 'error' | 'warning' | 'info'

interface Colors {
  text: string
  panel: string
  border: string
  muted: string
  accent: string
  danger: string
  warning: string
}

interface Measured {
  top: number
  height: number
  editorWidth: number
  dpr: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** Lines at the top and bottom of the viewport, and how far down them (0 to 1). */
  firstLine: number
  firstPart: number
  lastLine: number
  lastPart: number
  /** Columns of the wrapped lines, 0 without wrapping. */
  wrap: number
}

class Minimap {
  dom: HTMLDivElement
  canvas: HTMLCanvasElement
  slider: HTMLDivElement
  hidden = true
  opts: MinimapOptions
  /** Line of each row, and the column where the row starts (wrapped lines have several rows). */
  rows: number[] = []
  rowStarts: number[] = []
  rowsDirty = true
  wrap = 0
  /** Drawn segments of lines, by line number. */
  segments = new Map<number, Segment[]>()
  classColors = new Map<string, string>()
  colors: Colors | null = null
  diagnostics = new Map<number, Severity>()
  diagnosticsDirty = true
  searchMarks: Mark[] = []
  searchDirty = true
  selectionMarks: Mark[] = []
  selectionDirty = true
  headers: { line: number; label: string }[] = []
  headersDirty = true
  /** Last drawn layout, for the pointer. */
  layout: { input: MapInput; geometry: MapGeometry } | null = null
  drag: { y: number; scrollTop: number; input: MapInput } | null = null
  observer: MutationObserver
  dark = window.matchMedia('(prefers-color-scheme: dark)')

  constructor(readonly view: EditorView) {
    this.opts = view.state.facet(config)!
    this.dom = document.createElement('div')
    this.dom.className = 'cm-minimap'
    this.dom.setAttribute('aria-hidden', 'true')
    this.dom.style.display = 'none'
    this.canvas = document.createElement('canvas')
    this.slider = document.createElement('div')
    this.slider.className = 'cm-minimap-slider'
    this.dom.append(this.canvas, this.slider)
    view.dom.appendChild(this.dom)

    this.dom.addEventListener('mousedown', (e) => e.preventDefault())
    this.dom.addEventListener('pointerdown', this.onPointerDown)
    this.dom.addEventListener('pointermove', this.onPointerMove)
    this.dom.addEventListener('pointerup', this.onPointerUp)
    this.dom.addEventListener('pointercancel', this.onPointerUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    view.scrollDOM.addEventListener('scroll', this.schedule)
    // Theme changes: the app's theme attribute, VS Code's body classes, the system scheme.
    this.observer = new MutationObserver(this.themeChanged)
    const attributeFilter = ['class', 'style', 'data-theme']
    this.observer.observe(document.documentElement, { attributeFilter })
    this.observer.observe(document.body, { attributeFilter })
    this.dark.addEventListener('change', this.themeChanged)
    this.schedule()
  }

  update(u: ViewUpdate): void {
    const opts = u.state.facet(config)
    if (opts && opts !== u.startState.facet(config)) {
      this.opts = opts
      this.segments.clear()
      this.selectionDirty = this.headersDirty = true
    }
    if (u.docChanged) {
      this.segments.clear()
      this.rowsDirty = this.headersDirty = this.diagnosticsDirty = this.searchDirty = true
    } else if (syntaxTree(u.state) !== syntaxTree(u.startState)) this.segments.clear()
    if (foldedRanges(u.state) !== foldedRanges(u.startState)) this.rowsDirty = true
    if (u.docChanged || u.selectionSet) this.selectionDirty = true
    if (u.transactions.some((tr) => tr.effects.length > 0)) this.diagnosticsDirty = this.searchDirty = true
    this.schedule()
  }

  destroy(): void {
    this.observer.disconnect()
    this.dark.removeEventListener('change', this.themeChanged)
    this.view.scrollDOM.removeEventListener('scroll', this.schedule)
    this.view.scrollDOM.style.marginRight = ''
    this.dom.remove()
  }

  themeChanged = (): void => {
    this.colors = null
    this.classColors.clear()
    this.segments.clear()
    this.schedule()
  }

  schedule = (): void => {
    this.view.requestMeasure({ key: this, read: () => this.measure(), write: (m) => this.draw(m) })
  }

  measure(): Measured {
    const { view } = this
    const s = view.scrollDOM
    const top = s.getBoundingClientRect().top - view.documentTop
    const doc = view.state.doc
    const at = (y: number): [number, number] => {
      const block = view.lineBlockAtHeight(y)
      const part = block.height > 0 ? (y - block.top) / block.height : 0
      return [doc.lineAt(block.from).number, Math.max(0, Math.min(0.999, part))]
    }
    const [firstLine, firstPart] = at(top)
    const [lastLine, lastPart] = at(top + s.clientHeight)
    return {
      top: s.offsetTop,
      height: s.clientHeight,
      editorWidth: view.dom.clientWidth,
      dpr: window.devicePixelRatio || 1,
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      firstLine,
      firstPart,
      lastLine,
      lastPart,
      wrap: view.lineWrapping ? this.wrapWidth() : 0
    }
  }

  /** Columns the editor wraps lines at. */
  wrapWidth(): number {
    const line = this.view.contentDOM.querySelector('.cm-line')
    if (!(line instanceof HTMLElement)) return 0
    const style = getComputedStyle(line)
    const width = line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    return Math.max(1, Math.floor(width / this.view.defaultCharacterWidth))
  }

  // Data, recomputed when drawn after the changes that affect it.

  refresh(state: EditorState): void {
    const doc = state.doc
    if (this.rowsDirty) {
      const hidden: [number, number][] = []
      foldedRanges(state).between(0, doc.length, (from, to) => {
        const first = doc.lineAt(from).number + 1
        const last = doc.lineAt(to).number
        if (last >= first) hidden.push([first, last])
      })
      this.rows = []
      this.rowStarts = []
      for (const line of visibleLines(doc.lines, hidden)) {
        for (const start of wrapColumns(doc.line(line).text, this.wrap, state.tabSize)) {
          this.rows.push(line)
          this.rowStarts.push(start)
        }
      }
      this.rowsDirty = false
    }
    if (this.diagnosticsDirty) {
      this.diagnostics.clear()
      forEachDiagnostic(state, (d, from, to) => {
        const severity: Severity = d.severity === 'error' || d.severity === 'warning' ? d.severity : 'info'
        const last = doc.lineAt(to).number
        for (let line = doc.lineAt(from).number; line <= last; line++) {
          const had = this.diagnostics.get(line)
          if (had !== 'error' && !(had === 'warning' && severity === 'info'))
            this.diagnostics.set(line, severity)
        }
      })
      this.diagnosticsDirty = false
    }
    if (this.searchDirty) {
      const query = searchPanelOpen(state) ? getSearchQuery(state) : null
      this.searchMarks = query?.valid ? marks(state, query.getCursor(state)) : []
      this.searchDirty = false
    }
    if (this.selectionDirty) {
      const sel = state.selection.main
      const text = sel.empty ? '' : state.sliceDoc(sel.from, sel.to)
      this.selectionMarks =
        this.opts.selectionMatches && text.trim() && text.length <= 200 && !text.includes('\n')
          ? marks(state, new SearchCursor(doc, text))
          : []
      this.selectionDirty = false
    }
    if (this.headersDirty) {
      this.headers = []
      const re = HEADERS[this.opts.sections]
      let line = 1
      for (const iter = doc.iterLines(); !iter.next().done; line++) {
        const m = re.exec(iter.value)
        if (m?.[1]) this.headers.push({ line, label: m[1] })
      }
      this.headersDirty = false
    }
  }

  resolveColors(): Colors {
    if (this.colors) return this.colors
    const probe = document.createElement('span')
    this.view.dom.appendChild(probe)
    const css = (v: string): string => {
      probe.style.color = `var(${v})`
      return getComputedStyle(probe).color
    }
    this.colors = {
      text: getComputedStyle(this.view.contentDOM).color,
      panel: css('--panel'),
      border: css('--border'),
      muted: css('--muted'),
      accent: css('--accent'),
      danger: css('--danger'),
      warning: css('--warning')
    }
    probe.remove()
    return this.colors
  }

  /** Color of text with highlight classes, as the editor shows it. */
  classColor(cls: string): string {
    let color = this.classColors.get(cls)
    if (color === undefined) {
      const probe = document.createElement('span')
      probe.className = cls
      this.view.contentDOM.appendChild(probe)
      color = getComputedStyle(probe).color
      probe.remove()
      this.classColors.set(cls, color)
    }
    return color
  }

  lineSegments(state: EditorState, lineNo: number): Segment[] {
    let segs = this.segments.get(lineNo)
    if (segs) return segs
    const line = state.doc.line(lineNo)
    const text = line.text
    const spans: [number, number, string][] = []
    highlightTree(
      syntaxTree(state),
      highlight,
      (from, to, cls) => spans.push([from - line.from, to - line.from, cls]),
      line.from,
      line.to
    )
    const blocks = this.opts.render === 'blocks'
    const tabSize = state.tabSize
    segs = []
    let cur: Segment | null = null
    let col = 0
    let span = 0
    const columns = this.wrap ? Infinity : COLUMNS
    for (let i = 0; i < text.length && col < columns; i++) {
      const c = text.charCodeAt(i)
      if (c === 9 || c === 32) {
        col += c === 9 ? tabSize - (col % tabSize) : 1
        cur = null
        continue
      }
      while (span < spans.length && spans[span]![1] <= i) span++
      const s = spans[span]
      const color = this.classColor(s && s[0] <= i ? s[2] : '')
      const alpha = blocks ? BLOCK_INK : ink(c)
      if (cur && cur.color === color && cur.alpha === alpha) cur.w++
      else segs.push((cur = { x: col, w: 1, color, alpha }))
      col++
    }
    this.segments.set(lineNo, segs)
    return segs
  }

  draw(m: Measured): void {
    const { view } = this
    const hide = m.editorWidth < MIN_EDITOR_WIDTH || m.height <= 0
    if (hide !== this.hidden) {
      this.hidden = hide
      this.dom.style.display = hide ? 'none' : ''
      view.scrollDOM.style.marginRight = hide ? '' : `${WIDTH}px`
    }
    if (hide) {
      this.layout = null
      return
    }
    const state = view.state
    if (m.wrap !== this.wrap) {
      this.wrap = m.wrap
      this.rowsDirty = true
      this.segments.clear()
    }
    this.refresh(state)
    const colors = this.resolveColors()
    const { rows, rowStarts } = this
    const mapHeight = m.height
    this.dom.style.top = `${m.top}px`
    this.dom.style.height = `${mapHeight}px`
    const w = Math.round(WIDTH * m.dpr)
    const h = Math.round(mapHeight * m.dpr)
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0)
    ctx.clearRect(0, 0, WIDTH, mapHeight)

    const input: MapInput = {
      rowCount: rows.length,
      rowHeight: ROW,
      mapHeight,
      firstRow: this.rowIn(m.firstLine, m.firstPart),
      lastRow: this.rowIn(m.lastLine, m.lastPart),
      scrollTop: m.scrollTop,
      scrollHeight: m.scrollHeight,
      clientHeight: m.clientHeight
    }
    const geometry = mapGeometry(input)
    this.layout = { input, geometry }
    const { offset } = geometry
    const startRow = Math.floor(offset / ROW)
    const endRow = Math.min(rows.length, Math.ceil((offset + mapHeight) / ROW))
    const rowY = (row: number): number => row * ROW - offset
    /** Rows of a line in view (none when folded away). */
    const lineRows = (line: number, f: (row: number) => void): void => {
      for (let row = rowOfLine(rows, line); row < endRow && rows[row] === line; row++)
        if (row >= startRow) f(row)
    }
    const fill = (
      color: string,
      alpha: number,
      x: number,
      y: number,
      width: number,
      height: number
    ): void => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.fillRect(x, y, width, height)
    }
    const colX = (col: number): number => PAD + Math.min(col, COLUMNS) * COLUMN
    /** Columns `from` to `to` (Infinity: the end) of a row's line, within the row. */
    const fillColumns = (row: number, from: number, to: number, color: string, alpha: number): void => {
      const start = rowStarts[row]!
      const end = rows[row + 1] === rows[row] ? rowStarts[row + 1]! : Infinity
      const a = Math.max(from, start)
      const b = Math.min(to, end)
      if (b <= a) return
      const x = colX(a - start)
      const right = b === Infinity ? TEXT_WIDTH : colX(b - start)
      fill(color, alpha, x, rowY(row), Math.max(COLUMN, right - x), ROW)
    }

    // Line backgrounds: problems, caret lines, selections.
    for (let row = startRow; row < endRow; row++) {
      const severity = this.diagnostics.get(rows[row]!)
      if (severity)
        fill(
          severity === 'error' ? colors.danger : severity === 'warning' ? colors.warning : colors.accent,
          0.3,
          0,
          rowY(row),
          TEXT_WIDTH,
          ROW
        )
    }
    const doc = state.doc
    const tabSize = state.tabSize
    const column = (pos: number): number => {
      const line = doc.lineAt(pos)
      return countColumn(line.text.slice(0, pos - line.from), tabSize)
    }
    for (const r of state.selection.ranges) {
      lineRows(doc.lineAt(r.head).number, (row) => fill(colors.accent, 0.2, 0, rowY(row), TEXT_WIDTH, ROW))
      if (r.empty) continue
      const first = doc.lineAt(r.from).number
      const last = doc.lineAt(r.to).number
      for (let row = Math.max(startRow, rowOfLine(rows, first)); row < endRow; row++) {
        const line = rows[row]!
        if (line > last) break
        const from = line === first ? column(r.from) : 0
        const to = line === last ? column(r.to) : Infinity
        fillColumns(row, from, to, colors.accent, 0.45)
      }
    }

    // Text.
    for (let row = startRow; row < endRow; row++) {
      const y = rowY(row) + ROW * 0.125
      const start = rowStarts[row]!
      const end = Math.min(rows[row + 1] === rows[row] ? rowStarts[row + 1]! : Infinity, start + COLUMNS)
      for (const s of this.lineSegments(state, rows[row]!)) {
        if (s.x >= end) break
        const a = Math.max(s.x, start)
        const b = Math.min(s.x + s.w, end)
        if (b > a) fill(s.color, s.alpha, PAD + (a - start) * COLUMN, y, (b - a) * COLUMN, ROW * 0.75)
      }
    }

    // Matches, over the text.
    for (const mark of this.selectionMarks)
      lineRows(mark.line, (row) => fillColumns(row, mark.from, mark.to, colors.accent, 0.7))
    for (const mark of this.searchMarks)
      lineRows(mark.line, (row) => fillColumns(row, mark.from, mark.to, colors.warning, 0.9))

    // Section headers: a rule and the name over the lines below it, names kept apart.
    ctx.font = '600 8px system-ui, sans-serif'
    ctx.textBaseline = 'top'
    const headers = this.headers.filter(({ line }) => rows[rowOfLine(rows, line)] === line)
    const places = placeLabels(
      headers.map(({ line }) => rowOfLine(rows, line) * ROW),
      LABEL_HEIGHT
    )
    for (const { line } of headers) {
      const row = rowOfLine(rows, line)
      if (row >= startRow && row < endRow) fill(colors.muted, 0.6, 0, rowY(row), TEXT_WIDTH, 1)
    }
    headers.forEach(({ label }, i) => {
      const at = places[i]
      if (at == null || at + LABEL_HEIGHT <= offset || at >= offset + mapHeight) return
      const y = at - offset
      const width = Math.min(TEXT_WIDTH - PAD, ctx.measureText(label).width + 4)
      fill(colors.panel, 0.85, PAD - 2, y + 1, width, LABEL_HEIGHT - 1)
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.text
      ctx.fillText(label, PAD, y + 2, TEXT_WIDTH - 2 * PAD)
    })

    // Overview ruler: the whole text.
    const rulerY = (line: number): number =>
      rows.length ? (rowOfLine(rows, line) / rows.length) * mapHeight : 0
    fill(colors.border, 1, TEXT_WIDTH, 0, 1, mapHeight)
    const half = (RULER - 1) / 2
    for (const mark of this.selectionMarks)
      fill(colors.accent, 0.8, TEXT_WIDTH + 1, rulerY(mark.line), half, 2)
    for (const mark of this.searchMarks) fill(colors.warning, 0.9, TEXT_WIDTH + 1, rulerY(mark.line), half, 2)
    for (const [line, severity] of this.diagnostics)
      if (severity !== 'info')
        fill(
          severity === 'error' ? colors.danger : colors.warning,
          1,
          TEXT_WIDTH + 1 + half,
          rulerY(line),
          half,
          3
        )
    for (const r of state.selection.ranges)
      fill(colors.text, 0.8, TEXT_WIDTH + 1, rulerY(doc.lineAt(r.head).number), RULER - 1, 2)
    ctx.globalAlpha = 1

    this.slider.style.top = `${geometry.sliderTop}px`
    this.slider.style.height = `${geometry.sliderHeight}px`
  }

  // Pointer: click a line to center it, drag the slider, wheel scrolls the editor.

  /** Row `part` (0 to 1) down a line's rows. */
  rowIn(line: number, part: number): number {
    const first = rowOfLine(this.rows, line)
    if (this.rows[first] !== line) return first
    return first + Math.floor(part * this.rowCount(first))
  }

  rowCount(first: number): number {
    let n = 1
    while (this.rows[first + n] === this.rows[first]) n++
    return n
  }

  centerRow(row: number): void {
    const { view, rows } = this
    const line = rows[row]
    if (line === undefined) return
    const first = rowOfLine(rows, line)
    const s = view.scrollDOM
    const block = view.lineBlockAt(view.state.doc.line(line).from)
    const y = block.top + (block.height * (row - first + 0.5)) / this.rowCount(first)
    const docTop = view.documentTop - s.getBoundingClientRect().top + s.scrollTop
    s.scrollTop = docTop + y - s.clientHeight / 2
  }

  onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.layout) return
    const { input, geometry } = this.layout
    const box = this.dom.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    if (x >= TEXT_WIDTH) {
      this.centerRow(rulerRow(y, input.mapHeight, this.rows.length))
      return
    }
    if (y < geometry.sliderTop || y > geometry.sliderTop + geometry.sliderHeight)
      this.centerRow(rowAt(y, geometry.offset, ROW, this.rows.length))
    this.drag = { y: e.clientY, scrollTop: this.view.scrollDOM.scrollTop, input }
    this.dom.setPointerCapture(e.pointerId)
    this.dom.classList.add('cm-minimap-dragging')
  }

  onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return
    this.view.scrollDOM.scrollTop =
      this.drag.scrollTop + scrollForDrag(this.drag.input, e.clientY - this.drag.y)
  }

  onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return
    this.drag = null
    this.dom.releasePointerCapture(e.pointerId)
    this.dom.classList.remove('cm-minimap-dragging')
  }

  onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const s = this.view.scrollDOM
    const unit = e.deltaMode === 1 ? this.view.defaultLineHeight : e.deltaMode === 2 ? s.clientHeight : 1
    s.scrollTop += e.deltaY * unit
  }
}

/** Columns of matches, at most MAX_MATCHES. */
function marks(state: EditorState, cursor: Iterator<{ from: number; to: number }>): Mark[] {
  const doc = state.doc
  const out: Mark[] = []
  for (let r = cursor.next(); !r.done && out.length < MAX_MATCHES; r = cursor.next()) {
    const { from, to } = r.value
    const line = doc.lineAt(from)
    const start = countColumn(line.text.slice(0, from - line.from), state.tabSize)
    const end = countColumn(line.text.slice(0, Math.min(to, line.to) - line.from), state.tabSize)
    out.push({ line: line.number, from: start, to: Math.max(end, start + 1) })
  }
  return out
}

const plugin = ViewPlugin.fromClass(Minimap)

const theme = EditorView.theme({
  '.cm-minimap': {
    position: 'absolute',
    right: 0,
    width: `${WIDTH}px`,
    backgroundColor: 'var(--panel)',
    cursor: 'default',
    userSelect: 'none',
    touchAction: 'none'
  },
  '.cm-minimap canvas': { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  '.cm-minimap-slider': {
    position: 'absolute',
    left: 0,
    width: `${TEXT_WIDTH}px`,
    backgroundColor: 'color-mix(in srgb, var(--text) 7%, transparent)',
    transition: 'background-color 150ms'
  },
  '.cm-minimap:hover .cm-minimap-slider': {
    backgroundColor: 'color-mix(in srgb, var(--text) 16%, transparent)'
  },
  '.cm-minimap.cm-minimap-dragging .cm-minimap-slider': {
    backgroundColor: 'color-mix(in srgb, var(--text) 24%, transparent)'
  }
})

/** The minimap, on the right of the editor. */
export function minimap(opts: MinimapOptions): Extension {
  return [config.of(opts), plugin, theme]
}
