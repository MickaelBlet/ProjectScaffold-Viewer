// Find / replace widget of the code editor, floating at its top right like VS Code's: match case,
// whole word and regexp toggles in the find field, match count, replace row folded behind a chevron.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  selectMatches,
  setSearchQuery
} from '@codemirror/search'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  runScopeHandlers,
  type Command,
  type KeyBinding,
  type Panel,
  type ViewUpdate
} from '@codemirror/view'

/** Matches counted at most; more shows as `9999+`. */
const MAX_COUNT = 9999

/** Stroked outlines on a 16×16 grid, as `Icon.tsx`. */
const PATHS = {
  chevron: 'M6 4l4 4-4 4',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  close: 'M4 4l8 8M12 4l-8 8',
  selectAll: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h7',
  replace: 'M2.5 3.5h5v4h-5zM8.5 8.5h5v4h-5zM10 3.5h1.5a2 2 0 0 1 2 2v1M12 5l1.5 1.5L15 5',
  replaceAll: 'M2 2.5h4v3H2zM2 7h4v3H2zM8.5 9.5h5.5v4H8.5zM8 3.5h3a2 2 0 0 1 2 2v2M11.5 6l1.5 1.5L14.5 6'
} as const

const SVG = 'http://www.w3.org/2000/svg'

function icon(name: keyof typeof PATHS): SVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', PATHS[name])
  svg.appendChild(path)
  return svg
}

function button(cls: string, title: string, content: Node, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `cm-find-btn ${cls}`
  b.title = title
  b.setAttribute('aria-label', title)
  b.appendChild(content)
  // Keeps the focus in the field.
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', onClick)
  return b
}

function input(name: string, label: string): HTMLInputElement {
  const el = document.createElement('input')
  el.className = 'cm-find-input'
  el.name = name
  el.placeholder = label
  el.setAttribute('aria-label', label)
  el.spellcheck = false
  el.autocomplete = 'off'
  return el
}

/** A field and its buttons; the fields of both rows line up (`.cm-find-rows` grid). */
function row(box: HTMLElement, ...actions: HTMLElement[]): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-find-row'
  const end = document.createElement('div')
  end.className = 'cm-find-actions'
  end.append(...actions)
  el.append(box, end)
  return el
}

/** Whether the replace row is shown; kept across closing and reopening. */
const showReplace = StateEffect.define<boolean>()
const replaceOpen = StateField.define<boolean>({
  create: () => false,
  update: (open, tr) => tr.effects.reduce((v, e) => (e.is(showReplace) ? e.value : v), open)
})

/** Total matches of the query and the one at the main selection (1-based, 0: none). */
function count(state: EditorState, query: SearchQuery): { total: number; current: number } {
  const { from, to } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let current = 0
  for (let r = cursor.next(); !r.done && total <= MAX_COUNT; r = cursor.next()) {
    total++
    if (r.value.from === from && r.value.to === to) current = total
  }
  return { total, current }
}

class FindWidget implements Panel {
  dom: HTMLElement
  top = true
  private query: SearchQuery
  private readonly find = input('search', 'Find')
  private readonly replace = input('replace', 'Replace')
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regexp', HTMLButtonElement>
  private readonly counter = document.createElement('div')
  private readonly chevron: HTMLButtonElement
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly replaceRow: HTMLElement

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state)
    this.find.setAttribute('main-field', 'true')
    for (const field of [this.find, this.replace]) field.addEventListener('input', () => this.commit())

    const toggle = (label: string, title: string, key: keyof FindWidget['toggles']): HTMLButtonElement => {
      const span = document.createElement('span')
      span.className = `cm-find-toggle-label cm-find-${key}`
      span.textContent = label
      return button('cm-find-toggle', title, span, () => this.flip(key))
    }
    this.toggles = {
      caseSensitive: toggle('Aa', 'Match Case (Alt+C)', 'caseSensitive'),
      wholeWord: toggle('ab', 'Match Whole Word (Alt+W)', 'wholeWord'),
      regexp: toggle('.*', 'Use Regular Expression (Alt+R)', 'regexp')
    }
    const findBox = document.createElement('div')
    findBox.className = 'cm-find-box'
    findBox.append(this.find, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp)

    this.counter.className = 'cm-find-count'
    this.counter.setAttribute('aria-live', 'polite')
    this.prev = button('', 'Previous Match (Shift+Enter)', icon('up'), () => findPrevious(view))
    this.next = button('', 'Next Match (Enter)', icon('down'), () => findNext(view))
    const findRow = row(
      findBox,
      this.counter,
      this.prev,
      this.next,
      button('', 'Select All Matches (Alt+Enter)', icon('selectAll'), () => selectMatches(view)),
      button('cm-find-close', 'Close (Escape)', icon('close'), () => closeSearchPanel(view))
    )

    const replaceBox = document.createElement('div')
    replaceBox.className = 'cm-find-box'
    replaceBox.append(this.replace)
    this.replaceRow = row(
      replaceBox,
      button('', 'Replace (Enter)', icon('replace'), () => replaceNext(view)),
      button('', 'Replace All (Ctrl+Alt+Enter)', icon('replaceAll'), () => replaceAll(view))
    )

    this.chevron = button('cm-find-chevron', 'Toggle Replace', icon('chevron'), () =>
      view.dispatch({ effects: showReplace.of(!view.state.field(replaceOpen)) })
    )
    const rows = document.createElement('div')
    rows.className = 'cm-find-rows'
    rows.append(findRow, this.replaceRow)

    this.dom = document.createElement('div')
    this.dom.className = 'cm-find-widget'
    this.dom.setAttribute('role', 'search')
    this.dom.append(this.chevron, rows)
    this.dom.addEventListener('keydown', (e) => this.keydown(e))
    this.setQuery(this.query)
    this.refresh(view.state)
  }

  mount(): void {
    this.find.select()
    this.measure()
  }

  update(u: ViewUpdate): void {
    let queryChanged = false
    for (const tr of u.transactions)
      for (const e of tr.effects)
        if (e.is(setSearchQuery)) {
          queryChanged = true
          if (!e.value.eq(this.query)) this.setQuery(e.value)
        }
    if (
      queryChanged ||
      u.docChanged ||
      u.selectionSet ||
      u.startState.readOnly !== u.state.readOnly ||
      u.startState.field(replaceOpen) !== u.state.field(replaceOpen)
    )
      this.refresh(u.state)
    if (u.geometryChanged) this.measure()
  }

  /** Clear of the editor's vertical scrollbar. */
  private measure(): void {
    const s = this.view.scrollDOM
    this.view.requestMeasure({
      read: () => s.offsetWidth - s.clientWidth,
      write: (w) => (this.dom.style.marginRight = `${w}px`)
    })
  }

  private commit(next: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}): void {
    const query = new SearchQuery({
      search: this.find.value,
      replace: this.replace.value,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
      ...next
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  private flip(key: keyof FindWidget['toggles']): void {
    this.commit({ [key]: !this.query[key] })
    this.syncToggles()
  }

  private setQuery(query: SearchQuery): void {
    this.query = query
    this.find.value = query.search
    this.replace.value = query.replace
    this.syncToggles()
  }

  private syncToggles(): void {
    for (const key of ['caseSensitive', 'wholeWord', 'regexp'] as const) {
      const on = this.query[key]
      this.toggles[key].classList.toggle('cm-find-on', on)
      this.toggles[key].setAttribute('aria-pressed', String(on))
    }
  }

  private refresh(state: EditorState): void {
    const editable = !state.readOnly
    const open = editable && state.field(replaceOpen)
    this.chevron.style.display = editable ? '' : 'none'
    this.chevron.classList.toggle('cm-find-on', open)
    this.chevron.setAttribute('aria-expanded', String(open))
    this.replaceRow.style.display = open ? '' : 'none'
    this.dom.classList.toggle('cm-find-readonly', !editable)

    const q = this.query
    const invalid = !!q.search && q.regexp && !q.valid
    const { total, current } = q.valid ? count(state, q) : { total: 0, current: 0 }
    const none = !!q.search && total === 0
    this.find.classList.toggle('cm-find-error', invalid || none)
    this.counter.classList.toggle('cm-find-none', none)
    this.counter.textContent = !q.search
      ? 'No results'
      : invalid
        ? 'Invalid pattern'
        : total === 0
          ? 'No results'
          : total > MAX_COUNT
            ? `${current || '?'} of ${MAX_COUNT}+`
            : `${current || '?'} of ${total}`
    this.prev.disabled = this.next.disabled = total === 0
  }

  private keydown(e: KeyboardEvent): void {
    const view = this.view
    const mod = e.ctrlKey || e.metaKey
    let done = true
    if (runScopeHandlers(view, e, 'search-panel')) {
      // search keymap: Escape, F3, Mod-g, Mod-f
    } else if (e.altKey && !mod && e.code === 'KeyC') this.flip('caseSensitive')
    else if (e.altKey && !mod && e.code === 'KeyW') this.flip('wholeWord')
    else if (e.altKey && !mod && e.code === 'KeyR') this.flip('regexp')
    else if (e.key === 'Enter' && e.target === this.find) {
      if (e.altKey) selectMatches(view)
      else (e.shiftKey ? findPrevious : findNext)(view)
    } else if (e.key === 'Enter' && e.target === this.replace) {
      if (mod && e.altKey) replaceAll(view)
      else replaceNext(view)
    } else done = false
    if (done) e.preventDefault()
  }
}

/** Opens the widget with its replace row, the replace field focused. */
export const openReplacePanel: Command = (view) => {
  if (view.state.readOnly) return openSearchPanel(view)
  view.dispatch({ effects: showReplace.of(true) })
  openSearchPanel(view)
  const field = view.dom.querySelector<HTMLInputElement>('.cm-find-widget input[name=replace]')
  if (field && field !== view.root.activeElement) {
    field.focus()
    field.select()
  }
  return true
}

export const replaceKeymap: readonly KeyBinding[] = [
  { key: 'Mod-h', run: openReplacePanel, scope: 'editor search-panel', preventDefault: true }
]

const theme = EditorView.theme({
  // Over the text (and the minimap) instead of above it.
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
    border: 'none',
    pointerEvents: 'none'
  },
  '@keyframes cm-find-in': { from: { transform: 'translateY(-100%)' }, to: { transform: 'none' } },
  '.cm-find-widget': {
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    boxSizing: 'border-box',
    width: '440px',
    maxWidth: 'calc(100% - 28px)',
    marginRight: '14px',
    padding: '4px 4px 4px 2px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '12px',
    color: 'var(--text)',
    backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderTop: 'none',
    borderRadius: '0 0 4px 4px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
    animation: 'cm-find-in 120ms ease-out'
  },
  '.cm-find-widget.cm-find-readonly': { paddingLeft: '4px' },
  '.cm-find-rows': {
    flex: 1,
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '4px'
  },
  '.cm-find-row': { display: 'contents' },
  '.cm-find-actions': { display: 'flex', alignItems: 'center', gap: '2px' },
  '.cm-find-box': {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    paddingRight: '2px',
    backgroundColor: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: '3px'
  },
  '.cm-find-box:focus-within': { borderColor: 'var(--accent)' },
  '.cm-find-box:has(.cm-find-error)': { borderColor: 'var(--danger)' },
  '.cm-find-input, .cm-find-input:focus': {
    flex: 1,
    minWidth: '40px',
    height: '22px',
    padding: '0 6px',
    font: 'inherit',
    color: 'inherit',
    background: 'transparent',
    border: 'none',
    outline: 'none'
  },
  '.cm-find-btn': {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    padding: 0,
    color: 'inherit',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '3px',
    cursor: 'pointer'
  },
  '.cm-find-btn:hover:not(:disabled)': {
    borderColor: 'transparent',
    backgroundColor: 'color-mix(in srgb, var(--text) 12%, transparent)'
  },
  '.cm-find-btn:disabled': { opacity: 0.4, cursor: 'default' },
  '.cm-find-btn:focus-visible': { outline: '1px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-find-toggle': { width: '20px', height: '18px', color: 'var(--muted)' },
  '.cm-find-toggle.cm-find-on, .cm-find-toggle.cm-find-on:hover:not(:disabled)': {
    color: 'var(--text)',
    borderColor: 'var(--accent)',
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)'
  },
  '.cm-find-toggle-label': { fontSize: '11px', lineHeight: 1, fontWeight: '600' },
  '.cm-find-wholeWord': { textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-find-regexp': { fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace", letterSpacing: '-1px' },
  '.cm-find-chevron': { alignSelf: 'stretch', width: '16px', height: 'auto' },
  '.cm-find-chevron .ico': { transition: 'transform 120ms' },
  '.cm-find-chevron.cm-find-on .ico': { transform: 'rotate(90deg)' },
  '.cm-find-count': {
    flex: 'none',
    minWidth: '56px',
    padding: '0 4px',
    whiteSpace: 'nowrap',
    color: 'var(--muted)'
  },
  '.cm-find-count.cm-find-none': { color: 'var(--danger)' },
  '.cm-find-close': { marginLeft: '2px' }
})

/** Search state with the find widget; with `searchKeymap` and `replaceKeymap`. */
export function findWidget(): Extension {
  return [search({ top: true, createPanel: (view) => new FindWidget(view) }), replaceOpen, theme]
}
