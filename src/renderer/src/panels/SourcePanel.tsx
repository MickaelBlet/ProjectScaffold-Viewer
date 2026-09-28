// The project as file text, edited in place: valid edits replace the project (one undo step each),
// and changes made elsewhere (canvas, inspector, undo, file changed on disk) rewrite the text.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { FileProjectSchema } from '@/model/schema'
import { modulePaths } from '@/model/project'
import { LoadError, reloadText, sameContent, saveText, type Format, type LoadIssue } from '@/model/serialize'
import type { Project } from '@/model/types'
import { useDoc } from '@/store/documents'
import { setSetting, useSettings } from '@/store/settings'
import { highlightNodes } from '@/components/highlight'
import { navigate, navigateToNote } from '@/actions'
import { targetAt } from '@/components/sourceTarget'
import {
  complete,
  filterItems,
  structureAt,
  type Completion,
  type JsonSchema,
  type ProjectNames
} from '@/components/completion'

/** Delay after the last keystroke before the text is applied. */
const APPLY_MS = 400
/** Delay after the last caret move before the element under it is shown. */
const FOLLOW_MS = 250

const INDENT = '  '

let schema: JsonSchema | null = null
/** JSON Schema of the file, the source of completions. */
function fileSchema(): JsonSchema {
  schema ??= z.toJSONSchema(FileProjectSchema, { target: 'draft-2020-12', io: 'input' }) as JsonSchema
  return schema
}

function projectNames(p: Project): ProjectNames {
  const paths = modulePaths(p)
  return {
    interfaces: p.interfaces.map((i) => i.name),
    modules: p.modules.map((m) => paths.get(m.id)!),
    types: p.types.map((t) => t.name)
  }
}

/** Editing actions, on the text field set up by the effect. */
interface Actions {
  /** Apply the text now if it has changes waiting. */
  flush(): void
  /** Replace the text with the project. */
  revert(): void
  suggest(force: boolean): void
  goToLine(line: number): void
}

const noop = (): void => {}

interface Menu {
  items: Completion[]
  index: number
  from: number
  to: number
  x: number
  y: number
}

export function SourcePanel({ format }: { format: Format }): ReactNode {
  const store = useDoc((d) => d.store)
  const [editorData, setEditorData] = useState(false)
  const [issues, setIssues] = useState<LoadIssue[]>([])
  /** The project changed elsewhere while the text holds edits it cannot take. */
  const [stale, setStale] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  /** Colored copy of the text, drawn under the transparent text of the text field. */
  const code = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const actions = useRef<Actions>({ flush: noop, revert: noop, suggest: noop, goToLine: noop })
  const checkId = useId()
  const wsId = useId()
  const followId = useId()
  const whitespace = useSettings((s) => s.sourceWhitespace)
  const followCaret = useSettings((s) => s.sourceFollow)

  useLayoutEffect(() => {
    const el = area.current
    const pre = code.current
    const numbers = gutter.current
    if (!el || !pre || !numbers) return
    /** Lines (from 1) of the problems of the text, marked in the gutter and the text. */
    let errorLines = new Set<number>()
    const scroll = (): void => {
      pre.scrollTop = numbers.scrollTop = el.scrollTop
      pre.scrollLeft = el.scrollLeft
    }
    const mark = (): void => {
      for (const parent of [pre, numbers])
        for (const [i, row] of [...parent.children].entries())
          row.classList.toggle('error', errorLines.has(i + 1))
    }
    const paint = (): void => {
      pre.replaceChildren(highlightNodes(el.value, format))
      const count = pre.children.length
      if (numbers.children.length !== count) {
        numbers.replaceChildren(
          ...Array.from({ length: count }, (_, i) => {
            const n = document.createElement('div')
            n.textContent = String(i + 1)
            return n
          })
        )
        el.parentElement!.style.setProperty('--gutter', `${String(count).length + 2}ch`)
      }
      mark()
      scroll()
    }
    const report = (list: LoadIssue[]): void => {
      errorLines = new Set(list.flatMap((i) => (i.line ? [i.line] : [])))
      mark()
      setIssues(list)
    }
    /** Project the text stands for. */
    let shown = store.getState().project
    let invalid = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = (): void => {
      clearTimeout(timer)
      timer = undefined
    }
    const show = (): void => {
      cancel()
      shown = store.getState().project
      invalid = false
      el.value = saveText(shown, format, { editor: editorData })
      paint()
      report([])
      setStale(false)
    }
    const apply = (): void => {
      cancel()
      const current = store.getState().project
      try {
        const next = reloadText(el.value, format, current)
        invalid = false
        report([])
        setStale(false)
        // Layout-only or formatting edits that change nothing are no undo step.
        shown = sameContent(next, current) ? current : next
        if (shown !== current) store.setState({ project: next })
      } catch (e) {
        invalid = true
        report(e instanceof LoadError ? e.issues : [{ message: String(e) }])
      }
    }

    // Caret position in pixels, from the monospace character size.
    const style = getComputedStyle(el)
    const context = document.createElement('canvas').getContext('2d')
    if (context) context.font = style.font
    const charWidth = (context?.measureText('0'.repeat(20)).width ?? 144) / 20
    const lineHeight = parseFloat(style.lineHeight) || 18
    const padLeft = parseFloat(style.paddingLeft) || 0
    const padTop = parseFloat(style.paddingTop) || 0
    /** Show the completions at the caret: typed words and values; any key when forced. */
    const suggest = (force: boolean): void => {
      const pos = el.selectionStart
      if (format !== 'yaml' || pos !== el.selectionEnd) return setMenu(null)
      const result = complete(el.value, pos, fileSchema(), projectNames(store.getState().project))
      const items = result ? filterItems(result) : []
      if (!result || !items.length || (!force && !result.value && !result.prefix)) return setMenu(null)
      const before = el.value.slice(0, result.from)
      const line = before.split('\n').length - 1
      const col = result.from - (before.lastIndexOf('\n') + 1)
      setMenu({
        items,
        index: 0,
        from: result.from,
        to: result.to,
        x: el.offsetLeft + padLeft + col * charWidth - el.scrollLeft,
        y: el.offsetTop + padTop + (line + 1) * lineHeight - el.scrollTop
      })
      scrolled = { x: el.scrollLeft, y: el.scrollTop }
    }
    const goToLine = (line: number): void => {
      const lines = el.value.split('\n')
      const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
      el.focus()
      el.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0))
      el.scrollTop = Math.max(0, (line - 1) * lineHeight - el.clientHeight / 3)
      scroll()
    }

    // The element under the caret is selected and zoomed to, once per element.
    let followed = ''
    let followTimer: ReturnType<typeof setTimeout> | undefined
    const follow = (): void => {
      clearTimeout(followTimer)
      if (document.activeElement !== el || format !== 'yaml' || !useSettings.getState().sourceFollow) return
      followTimer = setTimeout(() => {
        const { path, names } = structureAt(el.value, el.selectionStart)
        const target = targetAt(store.getState().project, path, names)
        const key = target ? `${target.kind}:${'id' in target ? target.id : ''}` : ''
        if (!target || key === followed) return
        followed = key
        if (target.kind === 'note') navigateToNote(target.id, { zoom: true })
        else navigate(target, { zoom: true })
        // Showing it may activate a view: typing goes on here.
        if (document.activeElement !== el) el.focus()
      }, FOLLOW_MS)
    }
    // Back from elsewhere, the element under the caret is shown again.
    const onFocus = (): void => void (followed = '')

    const onInput = (): void => {
      paint()
      cancel()
      timer = setTimeout(apply, APPLY_MS)
      suggest(false)
    }
    // The completions follow the text.
    let scrolled = { x: el.scrollLeft, y: el.scrollTop }
    const onScroll = (): void => {
      scroll()
      const dx = el.scrollLeft - scrolled.x
      const dy = el.scrollTop - scrolled.y
      scrolled = { x: el.scrollLeft, y: el.scrollTop }
      setMenu((m) => m && { ...m, x: m.x - dx, y: m.y - dy })
    }
    show()
    el.addEventListener('input', onInput)
    el.addEventListener('scroll', onScroll)
    el.addEventListener('focus', onFocus)
    document.addEventListener('selectionchange', follow)
    const off = store.subscribe(({ project }) => {
      if (project === shown) return
      if (invalid || timer !== undefined) setStale(true)
      else show()
    })
    actions.current = { flush: () => void (timer !== undefined && apply()), revert: show, suggest, goToLine }
    return () => {
      off()
      el.removeEventListener('input', onInput)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('focus', onFocus)
      document.removeEventListener('selectionchange', follow)
      clearTimeout(followTimer)
      if (timer !== undefined) apply()
    }
  }, [store, format, editorData])

  // Keep the chosen completion in sight.
  useLayoutEffect(() => {
    list.current?.children[menu?.index ?? 0]?.scrollIntoView({ block: 'nearest' })
  }, [menu])

  const accept = (item: Completion): void => {
    const el = area.current
    if (!el || !menu) return
    setMenu(null)
    el.focus()
    el.setSelectionRange(menu.from, menu.to)
    // Kept in the text field's own undo history; the input event applies the text.
    document.execCommand('insertText', false, item.insert)
    // A nested object or list: go on with its keys.
    if (item.insert.includes('\n')) actions.current.suggest(true)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    if (menu) {
      const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (move && plain) {
        e.preventDefault()
        const n = menu.items.length
        return setMenu({ ...menu, index: (menu.index + move + n) % n })
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && plain) {
        e.preventDefault()
        return accept(menu.items[menu.index]!)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return setMenu(null)
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) setMenu(null)
    }
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault()
      return actions.current.suggest(true)
    }
    // Shortcuts (save, export...) see the text as typed.
    if (e.ctrlKey || e.metaKey) actions.current.flush()
    if (e.key === 'Tab' && plain) {
      e.preventDefault()
      document.execCommand('insertText', false, INDENT)
    }
  }

  return (
    <section className="source-editor">
      <header>
        <label htmlFor={checkId} title="Layout, views, notes and styles (kept when hidden)">
          <input
            id={checkId}
            type="checkbox"
            checked={editorData}
            onChange={(e) => setEditorData(e.target.checked)}
          />{' '}
          Editor data
        </label>
        <label htmlFor={wsId} title="Indentation, trailing spaces and tabs">
          <input
            id={wsId}
            type="checkbox"
            checked={whitespace}
            onChange={(e) => setSetting('sourceWhitespace', e.target.checked)}
          />{' '}
          Whitespace
        </label>
        {format === 'yaml' ? (
          <label htmlFor={followId} title="Select and zoom to the element under the cursor">
            <input
              id={followId}
              type="checkbox"
              checked={followCaret}
              onChange={(e) => setSetting('sourceFollow', e.target.checked)}
            />{' '}
            Follow cursor
          </label>
        ) : null}
        <span className="spacer" />
        {issues.length ? <span className="source-state error">Not applied</span> : null}
        {stale || issues.length ? (
          <button type="button" onClick={() => actions.current.revert()}>
            Discard edits
          </button>
        ) : null}
      </header>
      {stale ? <p className="source-stale">The project changed elsewhere since these edits.</p> : null}
      <div className={`source-code ${whitespace ? 'show-ws' : ''}`}>
        <div ref={gutter} className="source-gutter" aria-hidden="true" />
        <pre ref={code} aria-hidden="true" />
        <textarea
          ref={area}
          aria-label={`Project ${format.toUpperCase()}`}
          aria-autocomplete="list"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          onKeyDown={onKeyDown}
          onClick={() => setMenu(null)}
          onBlur={() => {
            setMenu(null)
            actions.current.flush()
          }}
        />
        {menu ? (
          <ul
            ref={list}
            className="completion"
            role="listbox"
            style={{ left: menu.x, top: menu.y }}
            // Keeps the focus (and the caret) in the text field.
            onMouseDown={(e) => e.preventDefault()}
          >
            {menu.items.map((item, i) => (
              <li
                key={item.label}
                role="option"
                aria-selected={i === menu.index}
                className={i === menu.index ? 'active' : ''}
                onClick={() => accept(item)}
                onMouseMove={() => i !== menu.index && setMenu({ ...menu, index: i })}
              >
                <span>{item.label}</span>
                {item.detail ? <small>{item.detail}</small> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {issues.length ? (
        <ul className="source-problems" role="alert">
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.line ? (
                <button type="button" className="link" onClick={() => actions.current.goToLine(issue.line!)}>
                  Line {issue.line}
                </button>
              ) : null}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
