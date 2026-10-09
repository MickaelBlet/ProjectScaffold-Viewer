// A text file edited beside the document: IDL file (store/textFiles.ts).
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { setDiagnostics } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { CodeEditor, goToLine, selectSpot } from '@/components/CodeEditor'
import { languageOf } from '@/components/codeLanguages'
import { idlProblems, type TextProblem } from '@/components/fileDiagnostics'
import { useDoc } from '@/store/documents'
import {
  addTextFile,
  checkTextFile,
  editTextFile,
  fileBaseName,
  isFileDirty,
  loadTextFile,
  saveTextFile,
  textFileKey,
  useTextFiles,
  useTextReveals,
  type TextFile,
  type TextFileRef
} from '@/store/textFiles'

const SOURCE_LABELS: Record<TextFileRef['source'], string> = {
  file: 'File'
}

function problemsOf(ref: TextFileRef, text: string): TextProblem[] {
  if (languageOf(ref.path).id === 'idl') return idlProblems(text, fileBaseName(ref.path))
  return []
}

function Banners({
  file,
  docId,
  fileRef: ref
}: {
  file: TextFile
  docId: string
  fileRef: TextFileRef
}): ReactNode {
  return (
    <>
      {file.error ? (
        <p className="source-stale error">
          {file.error}{' '}
          <button type="button" className="link" onClick={() => void loadTextFile(docId, ref)}>
            Read again
          </button>
        </p>
      ) : null}
      {file.stale ? (
        <p className="source-stale">
          The file changed on disk since these edits: <em>Reload</em> takes it, <em>Save</em> overwrites it.
        </p>
      ) : null}
    </>
  )
}

export function FilePanel({ api, params }: IDockviewPanelProps<TextFileRef>): ReactNode {
  const docId = useDoc((d) => d.id)
  const { source, path } = params
  const ref = useMemo((): TextFileRef => ({ source, path }), [source, path])
  const key = textFileKey(docId, ref)
  const file = useTextFiles((s) => s.files[key])
  const dirty = isFileDirty(file)
  const [view, setView] = useState<EditorView | null>(null)
  const reveal = useTextReveals((s) => s[key])
  const loaded = file?.saved != null
  const text = useDeferredValue(file?.text ?? '')
  const problems = useMemo(
    () => (file?.saved === null ? [] : problemsOf(ref, text)),
    [ref, text, file?.saved]
  )

  // A tab restored with the document, or whose file was dropped: read it.
  useEffect(() => {
    if (useTextFiles.getState().files[key]) return
    addTextFile(docId, ref)
    void loadTextFile(docId, ref)
  }, [key, docId, ref])
  useEffect(() => api.setTitle(`${fileBaseName(path)}${dirty ? ' ●' : ''}`), [api, path, dirty])
  // Changed elsewhere (another editor): checked when shown again.
  useEffect(() => {
    const check = (): void => void checkTextFile(docId, ref)
    const d = api.onDidActiveChange((e) => e.isActive && check())
    window.addEventListener('focus', check)
    return () => {
      d.dispose()
      window.removeEventListener('focus', check)
    }
  }, [api, docId, ref])
  // Text to select (a search result): once the editor holds the file.
  useEffect(() => {
    if (!view || !reveal || !loaded) return
    selectSpot(view, reveal)
    useTextReveals.setState((s) => {
      const rest = { ...s }
      delete rest[key]
      return rest
    }, true)
  }, [view, reveal, loaded, key])
  useEffect(() => {
    if (!view) return
    const doc = view.state.doc
    const diagnostics = problems.flatMap((p) => {
      if (p.line === null || p.line > doc.lines) return []
      const line = doc.line(p.line)
      return [{ from: line.from, to: line.to, severity: p.severity, message: p.message }]
    })
    view.dispatch(setDiagnostics(view.state, diagnostics))
  }, [view, problems])

  if (!file) return null
  return (
    <section className="source-editor file-editor">
      <header>
        <span className="file-path" title={`${SOURCE_LABELS[source]}: ${path}`}>
          <span className="muted">{SOURCE_LABELS[source]} ›</span> {path}
        </span>
        <span className="spacer" />
        {problems.some((p) => p.severity === 'error') ? (
          <span className="source-state error">Errors</span>
        ) : null}
        <button type="button" onClick={() => void loadTextFile(docId, ref)} title="Read the file again">
          Reload
        </button>
        <button
          type="button"
          className={dirty ? 'primary' : ''}
          disabled={!dirty}
          onClick={() => void saveTextFile(docId, ref)}
        >
          Save
        </button>
      </header>
      <Banners file={file} docId={docId} fileRef={ref} />
      <CodeEditor
        value={file.text}
        fileName={path}
        label={fileBaseName(path)}
        readOnly={file.saved === null}
        onChange={(t) => editTextFile(docId, ref, t)}
        onView={setView}
      />
      {problems.length ? (
        <ul className="source-problems" role="alert">
          {problems.map((p, i) => (
            <li key={i} className={p.severity}>
              {p.line !== null ? (
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
