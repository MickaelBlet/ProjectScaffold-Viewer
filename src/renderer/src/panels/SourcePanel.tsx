// The project as file text, edited in place: valid edits replace the project (one undo step each),
// and changes made elsewhere (canvas, inspector, undo, file changed on disk) rewrite the text.
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { insertCompletionText, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { FileProjectSchema } from '@/model/schema'
import { modulePaths } from '@/model/project'
import { LoadError, reloadText, sameContent, saveText, type Format, type LoadIssue } from '@/model/serialize'
import type { Project } from '@/model/types'
import { useDoc } from '@/store/documents'
import { setSetting, useSettings } from '@/store/settings'
import { CodeEditor, goToLine, setText } from '@/components/CodeEditor'
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

/** Problems of the text as editor diagnostics, on their lines. */
function diagnostics(state: EditorState, issues: LoadIssue[]): Diagnostic[] {
  return issues.flatMap((i) => {
    if (!i.line || i.line > state.doc.lines) return []
    const line = state.doc.line(i.line)
    return [{ from: line.from, to: line.to, severity: 'error' as const, message: i.message }]
  })
}

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

export function SourcePanel({ format }: { format: Format }): ReactNode {
  const store = useDoc((d) => d.store)
  const [editorData, setEditorData] = useState(false)
  const [issues, setIssues] = useState<LoadIssue[]>([])
  /** The project changed elsewhere while the text holds edits it cannot take. */
  const [stale, setStale] = useState(false)
  const [view, setView] = useState<EditorView | null>(null)
  const handlers = useRef<Handlers>({ flush: noop, revert: noop, input: noop, caret: noop, focus: noop })
  const checkId = useId()
  const wsId = useId()
  const followId = useId()
  const whitespace = useSettings((s) => s.sourceWhitespace)
  const followCaret = useSettings((s) => s.sourceFollow)

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
    const report = (list: LoadIssue[]): void => {
      view.dispatch(setDiagnostics(view.state, diagnostics(view.state, list)))
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
      setText(view, saveText(shown, format, { editor: editorData }))
      report([])
      setStale(false)
    }
    const apply = (): void => {
      cancel()
      const current = store.getState().project
      try {
        const next = reloadText(view.state.doc.toString(), format, current)
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
        if (target.kind === 'note') navigateToNote(target.id, { zoom: true })
        else navigate(target, { zoom: true })
        // Showing it may activate a view: typing goes on here.
        if (!v.hasFocus) v.focus()
      }, FOLLOW_MS)
    }

    show()
    const off = store.subscribe(({ project }) => {
      if (project === shown) return
      if (invalid || timer !== undefined) setStale(true)
      else show()
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
      clearTimeout(followTimer)
      if (timer !== undefined) apply()
      handlers.current = { flush: noop, revert: noop, input: noop, caret: noop, focus: noop }
    }
  }, [view, store, format, editorData])

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
        onChange={() => handlers.current.input()}
        // Shortcuts (save, export...) see the text as typed.
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && handlers.current.flush()}
        onFocus={() => handlers.current.focus()}
        onBlur={() => handlers.current.flush()}
        onCaret={(v) => handlers.current.caret(v)}
        onView={setView}
      />
      {issues.length ? (
        <ul className="source-problems" role="alert">
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.line ? (
                <button type="button" className="link" onClick={() => view && goToLine(view, issue.line!)}>
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
