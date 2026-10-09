// The project as file text, edited in place: valid edits replace the project (one undo step each),
// and changes made elsewhere (canvas, inspector, undo, file changed on disk) rewrite the text.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { insertCompletionText, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { getChunks, unifiedMergeView } from '@codemirror/merge'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { FileProjectSchema } from '@/model/schema'
import { modulePaths, notePath } from '@/model/project'
import { locateValidation, targetPath } from '@/model/locate'
import {
  LoadError,
  lineOfPath,
  parseText,
  reloadText,
  sameContent,
  saveText,
  type Format,
  type LoadIssue
} from '@/model/serialize'
import type { Project } from '@/model/types'
import { useDoc, useDocs, type Selection } from '@/store/documents'
import { setSetting, useSettings } from '@/store/settings'
import { IN_VSCODE } from '@/host'
import { CodeEditor, goToLine, revealLine, setText } from '@/components/CodeEditor'
import type { TextProblem } from '@/components/fileDiagnostics'
import { Icon } from '@/components/Icon'
import { problemsOf } from '@/panels/ProblemsPanel'
import { navigate, navigateToNote } from '@/actions'
import { targetAt } from '@/components/sourceTarget'
import {
  complete,
  filterItems,
  structureAt,
  type JsonSchema,
  type ProjectNames
} from '@/components/completion'

/** Delay after the last keystroke before the text is applied. */
const APPLY_MS = 400
/** Delay after the last caret move before the element under it is shown. */
const FOLLOW_MS = 250

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

/** Problems of the text as editor diagnostics, on their lines (from the first non-blank character). */
function diagnostics(state: EditorState, problems: TextProblem[]): Diagnostic[] {
  return problems.flatMap((p) => {
    if (!p.line || p.line > state.doc.lines) return []
    const line = state.doc.line(p.line)
    const from = line.from + /^\s*/.exec(line.text)![0].length
    return [{ from, to: Math.max(from, line.to), severity: p.severity, message: p.message }]
  })
}

/** Validation problems of the project shown by the text, on their lines. */
function validationProblems(text: string, format: Format, project: Project): TextProblem[] {
  try {
    return locateValidation(text, format, project, problemsOf(project))
  } catch {
    return []
  }
}

/** Per-chunk button of the changes view: revert only, accepting would hide a change not saved yet. */
function revertButton(type: 'accept' | 'reject', action: (e: MouseEvent) => void): HTMLElement {
  const button = document.createElement('button')
  if (type === 'accept') {
    button.hidden = true
    return button
  }
  button.type = 'button'
  button.name = 'reject'
  button.textContent = 'Revert'
  button.title = 'Revert to the saved text'
  button.onmousedown = action
  return button
}

/** Moves the caret to the start of the next (1) or previous (-1) change, around at the ends. */
function goToChange(view: EditorView, dir: 1 | -1): boolean {
  const chunks = getChunks(view.state)?.chunks
  if (!chunks?.length) return false
  const head = view.state.selection.main.head
  const n = chunks.length
  // Next: the first change starting after the caret; previous: the last one starting before it.
  const next = chunks.findIndex((c) => c.fromB > head)
  const before = chunks.filter((c) => c.fromB < head).length
  const i = dir > 0 ? (next < 0 ? 0 : next) : (before - 1 + n) % n
  const from = chunks[i]!.fromB
  view.dispatch({
    selection: { anchor: from },
    userEvent: 'select.byChunk',
    effects: EditorView.scrollIntoView(from, { y: 'center' })
  })
  return true
}

/** Alt+F5 / Shift+Alt+F5: next / previous change, as in VS Code. */
const changeKeys = Prec.high(
  keymap.of([
    { key: 'Alt-F5', run: (v) => goToChange(v, 1) },
    { key: 'Shift-Alt-F5', run: (v) => goToChange(v, -1) }
  ])
)

const NO_EXTENSIONS: Extension = []

/** Handlers of the editor, set up by the effect binding it to the project. */
interface Handlers {
  /** Apply the text now if it has changes waiting. */
  flush(): void
  /** Replace the text with the project. */
  revert(): void
  input(): void
  caret(view: EditorView): void
  focus(): void
}

const noop = (): void => {}

/** Option of the header: a pill, muted when off, accent when on. */
function Toggle(props: {
  label: string
  title: string
  on: boolean
  onChange: (on: boolean) => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`qualifier ${props.on ? 'on' : ''}`}
      aria-pressed={props.on}
      title={props.title}
      onClick={() => props.onChange(!props.on)}
    >
      {props.label}
    </button>
  )
}

export function SourcePanel({ format }: { format: Format }): ReactNode {
  const store = useDoc((d) => d.store)
  const [problems, setProblems] = useState<TextProblem[]>([])
  /** The text cannot be read: the problems are its load errors. */
  const [unreadable, setUnreadable] = useState(false)
  const [listOpen, setListOpen] = useState(true)
  /** The project changed elsewhere while the text holds edits it cannot take. */
  const [stale, setStale] = useState(false)
  const [view, setView] = useState<EditorView | null>(null)
  const handlers = useRef<Handlers>({ flush: noop, revert: noop, input: noop, caret: noop, focus: noop })
  const followCaret = useSettings((s) => s.sourceFollow)
  const changesOn = useSettings((s) => s.sourceChanges)
  const savedProject = useDoc((d) => d.savedProject)
  /** Text as last saved: what the changes are shown against (none before the first save). */
  const savedText = useMemo(
    () => (savedProject ? saveText(savedProject, format, { editor: true }) : null),
    [savedProject, format]
  )
  // VS Code shows the changes of its documents itself, and the page's saved project is the text's.
  const showChanges = changesOn && !IN_VSCODE && savedText !== null
  const [changeCount, setChangeCount] = useState(0)
  const changes = useMemo(
    (): Extension =>
      showChanges
        ? [
            unifiedMergeView({ original: savedText, mergeControls: revertButton, gutter: true }),
            changeKeys,
            EditorView.updateListener.of((u) => setChangeCount(getChunks(u.state)?.chunks.length ?? 0))
          ]
        : NO_EXTENSIONS,
    [showChanges, savedText]
  )

  /** Keys and values the schema allows at the caret, and names of the project. */
  const completion = useMemo((): CompletionSource | undefined => {
    if (format !== 'yaml') return undefined
    return (context) => {
      const { state, pos, explicit } = context
      if (!state.selection.main.empty) return null
      const result = complete(state.doc.toString(), pos, fileSchema(), projectNames(store.getState().project))
      const items = result ? filterItems(result) : []
      if (!result || !items.length || (!explicit && !result.value && !result.prefix)) return null
      return {
        from: result.from,
        to: result.to,
        filter: false,
        options: items.map((item) => ({
          label: item.label,
          detail: item.detail,
          apply: (v: EditorView, _c: unknown, from: number, to: number) => {
            v.dispatch(insertCompletionText(v.state, item.insert, from, to))
            // A nested object or list: go on with its keys.
            if (item.insert.includes('\n')) startCompletion(v)
          }
        }))
      }
    }
  }, [format, store])

  useLayoutEffect(() => {
    if (!view) return
    const report = (list: TextProblem[], loadErrors = false): void => {
      view.dispatch(setDiagnostics(view.state, diagnostics(view.state, list)))
      setProblems(list)
      setUnreadable(loadErrors)
      if (loadErrors) setListOpen(true)
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
      const text = saveText(shown, format, { editor: true })
      setText(view, text)
      report(validationProblems(text, format, shown))
      setStale(false)
    }
    const apply = (): void => {
      cancel()
      const current = store.getState().project
      const text = view.state.doc.toString()
      try {
        const next = reloadText(text, format, current)
        invalid = false
        setStale(false)
        // Layout-only or formatting edits that change nothing are no undo step.
        shown = sameContent(next, current) ? current : next
        report(validationProblems(text, format, shown))
        if (shown !== current) store.setState({ project: next })
      } catch (e) {
        invalid = true
        const issues: LoadIssue[] = e instanceof LoadError ? e.issues : [{ message: String(e) }]
        report(
          issues.map((i) => ({ line: i.line ?? null, message: i.message, severity: 'error' as const })),
          true
        )
      }
    }

    // The element under the caret is selected and zoomed to, once per element.
    let followed = ''
    let followTimer: ReturnType<typeof setTimeout> | undefined
    const caret = (v: EditorView): void => {
      clearTimeout(followTimer)
      if (format !== 'yaml' || !useSettings.getState().sourceFollow) return
      followTimer = setTimeout(() => {
        const { path, names } = structureAt(v.state.doc.toString(), v.state.selection.main.head)
        const target = targetAt(store.getState().project, path, names)
        const key = target ? `${target.kind}:${'id' in target ? target.id : ''}` : ''
        if (!target || key === followed) return
        followed = key
        // The views stay as they are: the entity is shown where drawn.
        if (target.kind === 'note') navigateToNote(target.id, { zoom: true, stay: true })
        else navigate(target, { zoom: true, stay: true })
        // Showing it may activate a view: typing goes on here.
        if (!v.hasFocus) v.focus()
      }, FOLLOW_MS)
    }

    // The caret goes to the entity selected elsewhere (canvas, lists...).
    const reveal = (selection: Selection): void => {
      if (format !== 'yaml' || !selection || view.hasFocus || !useSettings.getState().sourceFollow) return
      const p = store.getState().project
      const text = view.state.doc.toString()
      let data: unknown
      try {
        data = parseText(text, format)
      } catch {
        return
      }
      let path: (string | number)[]
      if (selection.kind === 'note') {
        const at = notePath(p, selection.id)
        if (!at) return
        path = at
      } else {
        const target =
          selection.kind === 'imported' ? { kind: 'module' as const, id: selection.id } : selection
        path = targetPath(data, p, target)
      }
      const line = lineOfPath(text, path)
      if (line !== undefined) revealLine(view, line)
    }
    const selectionOf = (s: ReturnType<typeof useDocs.getState>): Selection =>
      s.docs.find((d) => d.store === store)?.selection ?? null

    show()
    reveal(selectionOf(useDocs.getState()))
    const off = store.subscribe(({ project }) => {
      if (project === shown) return
      if (invalid || timer !== undefined) setStale(true)
      else show()
    })
    const offSelection = useDocs.subscribe((s, prev) => {
      const selection = selectionOf(s)
      if (selection !== selectionOf(prev)) reveal(selection)
    })
    handlers.current = {
      flush: () => void (timer !== undefined && apply()),
      revert: show,
      input: () => {
        cancel()
        timer = setTimeout(apply, APPLY_MS)
      },
      caret,
      // Back from elsewhere, the element under the caret is shown again.
      focus: () => void (followed = '')
    }
    return () => {
      off()
      offSelection()
      clearTimeout(followTimer)
      if (timer !== undefined) apply()
      handlers.current = { flush: noop, revert: noop, input: noop, caret: noop, focus: noop }
    }
  }, [view, store, format])

  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  const changesTitle =
    savedText === null
      ? 'Not saved yet: no changes to show'
      : 'Show the changes since the last save, each with a button to revert it'

  return (
    <section className="source-editor">
      <header>
        {format === 'yaml' ? (
          <Toggle
            label="Sync selection"
            title="Select the element under the cursor, move the cursor to the selected element"
            on={followCaret}
            onChange={(on) => setSetting('sourceFollow', on)}
          />
        ) : null}
        {IN_VSCODE ? null : (
          // One pill: the toggle, then previous / next change while there are some.
          <span className="source-changes">
            <button
              type="button"
              className={`qualifier ${showChanges ? 'on' : ''}`}
              aria-pressed={showChanges}
              disabled={savedText === null}
              title={changesTitle}
              onClick={() => setSetting('sourceChanges', !changesOn)}
            >
              Changes{showChanges ? ` ${changeCount}` : ''}
            </button>
            {showChanges && changeCount ? (
              <>
                <button
                  type="button"
                  className="qualifier on"
                  title="Previous change (Shift+Alt+F5)"
                  aria-label="Previous change"
                  onClick={() => view && (view.focus(), goToChange(view, -1))}
                >
                  <Icon name="arrow-up" />
                </button>
                <button
                  type="button"
                  className="qualifier on"
                  title="Next change (Alt+F5)"
                  aria-label="Next change"
                  onClick={() => view && (view.focus(), goToChange(view, 1))}
                >
                  <Icon name="arrow-down" />
                </button>
              </>
            ) : null}
          </span>
        )}
        <span className="spacer" />
        {unreadable ? <span className="source-state error">Not applied</span> : null}
        {problems.length ? (
          <button
            type="button"
            className={`source-counts ${listOpen ? 'on' : ''}`}
            aria-pressed={listOpen}
            title={listOpen ? 'Hide the problems' : 'Show the problems'}
            onClick={() => setListOpen((o) => !o)}
          >
            <span className={`error ${errors ? '' : 'zero'}`}>
              <Icon name="error" /> {errors}
            </span>
            <span className={`warning ${warnings ? '' : 'zero'}`}>
              <Icon name="warning" /> {warnings}
            </span>
          </button>
        ) : null}
        {stale || unreadable ? (
          <button type="button" onClick={() => handlers.current.revert()}>
            Discard edits
          </button>
        ) : null}
      </header>
      {stale ? <p className="source-stale">The project changed elsewhere since these edits.</p> : null}
      <CodeEditor
        fileName={`project.${format}`}
        label={`Project ${format.toUpperCase()}`}
        completion={completion}
        extensions={changes}
        onChange={() => handlers.current.input()}
        // Shortcuts (save, export...) see the text as typed.
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && handlers.current.flush()}
        onFocus={() => handlers.current.focus()}
        onBlur={() => handlers.current.flush()}
        onCaret={(v) => handlers.current.caret(v)}
        onView={setView}
      />
      {problems.length && listOpen ? (
        <ul className="source-problems with-icons" role={unreadable ? 'alert' : undefined}>
          {problems.map((p, i) => (
            <li key={i} className={p.severity}>
              <Icon name={p.severity} title={p.severity} />
              {p.line ? (
                <button type="button" className="link" onClick={() => view && goToLine(view, p.line!)}>
                  Line {p.line}
                </button>
              ) : null}
              {p.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
