// A text file edited beside the document: template, generated file or IDL file (store/textFiles.ts).
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { setDiagnostics } from '@codemirror/lint'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'
import { CodeEditor, goToLine } from '@/components/CodeEditor'
import { languageOf } from '@/components/codeLanguages'
import { idlProblems, liquidProblems, userSections, type TextProblem } from '@/components/fileDiagnostics'
import { ORPHANS } from '@/codegen/run'
import { chooseTemplates } from '@/generateCode'
import { useDoc } from '@/store/documents'
import {
  addTextFile,
  checkTextFile,
  editTextFile,
  fileBaseName,
  isFileDirty,
  isReadOnly,
  loadTextFile,
  saveTextFile,
  textFileKey,
  useTextFiles,
  type TextFile,
  type TextFileRef
} from '@/store/textFiles'

const SOURCE_LABELS: Record<TextFileRef['source'], string> = {
  templates: 'Template folder',
  output: 'Output directory',
  builtin: 'Built-in templates',
  file: 'File'
}

const userLine = Decoration.line({ class: 'cm-userSection' })
const markerLine = Decoration.line({ class: 'cm-userMarker' })

function sectionDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  for (const s of userSections(doc.toString()).sections)
    for (let i = s.start; i <= s.end && i < doc.lines; i++)
      builder.add(
        doc.line(i + 1).from,
        doc.line(i + 1).from,
        i === s.start || i === s.end ? markerLine : userLine
      )
  return builder.finish()
}

/** Shades the user sections of a generated file: the code kept when it is generated again. */
const userSectionShading: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = sectionDecorations(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged) this.decorations = sectionDecorations(u.view)
    }
  },
  { decorations: (p) => p.decorations }
)

const NONE: Extension = []

/** Generated files, but the `.orphans` ones: user sections are what regeneration keeps. */
const isGenerated = (ref: TextFileRef): boolean => ref.source === 'output' && !ref.path.endsWith(ORPHANS)

function problemsOf(ref: TextFileRef, text: string): TextProblem[] {
  const lang = languageOf(ref.path)
  if (lang.id === 'liquid') return liquidProblems(text)
  if (lang.id === 'idl') return idlProblems(text, fileBaseName(ref.path))
  if (isGenerated(ref)) return userSections(text).problems
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
      {ref.source === 'builtin' ? (
        <p className="source-note">
          Built-in templates are read-only.{' '}
          <button type="button" className="link" onClick={() => void chooseTemplates()}>
            Copy them into a folder…
          </button>{' '}
          to edit them.
        </p>
      ) : null}
      {isGenerated(ref) ? (
        <p className="source-note">
          Shaded lines are user sections, kept when the code is generated again; edits elsewhere are reported
          as conflicts.
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
  const readOnly = isReadOnly(ref)
  const [view, setView] = useState<EditorView | null>(null)
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
  // Changed elsewhere (generated again, another editor): checked when shown again.
  useEffect(() => {
    const check = (): void => void checkTextFile(docId, ref)
    const d = api.onDidActiveChange((e) => e.isActive && check())
    window.addEventListener('focus', check)
    return () => {
      d.dispose()
      window.removeEventListener('focus', check)
    }
  }, [api, docId, ref])
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
        {readOnly ? null : (
          <>
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
          </>
        )}
      </header>
      <Banners file={file} docId={docId} fileRef={ref} />
      <CodeEditor
        value={file.text}
        fileName={path}
        label={fileBaseName(path)}
        readOnly={readOnly || file.saved === null}
        extensions={isGenerated(ref) ? userSectionShading : NONE}
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
