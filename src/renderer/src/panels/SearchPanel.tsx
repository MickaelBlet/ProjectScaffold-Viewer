// Search over the active document: its entities (names, descriptions, metadata), then its templates and
// generated files (names and content, edits in open tabs included), each line opened at the match.
import { useDeferredValue, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { searchLines, searchProject, type LineHit, type TextSpot } from '@/model/search'
import { useProjectStore } from '@/store/project'
import { activeDoc, useDocs, type DocState } from '@/store/documents'
import { readTextFile, textFileKey, useTextFiles } from '@/store/textFiles'
import { navigate } from '@/actions'
import { codegenListeners } from '@/generateCode'
import { codegenFiles, type CodegenFile } from '@/generationFiles'
import { openTextFile } from '@/textFileOps'
import { LANGUAGE_BADGES, languageOf } from '@/components/codeLanguages'
import { onListKeyDown } from '@/components/listKeys'

/** Lines listed at most, over all the files. */
const MAX_LINES = 1000

interface FileText extends CodegenFile {
  /** As read; empty when it could not be. */
  text: string
}

interface FileHit {
  file: CodegenFile
  lines: LineHit[]
}

async function readFiles(doc: DocState): Promise<FileText[]> {
  const files = await codegenFiles(doc)
  const texts = await Promise.all(files.map((f) => readTextFile(doc, f.ref).catch(() => null)))
  return files.map((f, i) => ({ ...f, text: texts[i] ?? '' }))
}

function Mark({ text, query }: { text: string; query: string }): ReactNode {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0 || !query) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

/** A line from a little before its match, so that the match shows in a narrow panel. */
function snippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  return i > 24 ? `…${text.slice(i - 16)}` : text
}

/** Templates and generated files of the active document, read while searching. */
function useFiles(searching: boolean): FileText[] | null {
  const docId = useDocs((s) => s.activeId)
  const [files, setFiles] = useState<FileText[] | null>(null)
  // Generated again or other templates: read again.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const changed = (): void => setVersion((v) => v + 1)
    codegenListeners.add(changed)
    return () => void codegenListeners.delete(changed)
  }, [])
  useEffect(() => {
    if (!searching) return
    let current = true
    void readFiles(activeDoc()).then((f) => current && setFiles(f))
    return () => {
      current = false
      setFiles(null)
    }
  }, [searching, docId, version])
  return files
}

export function SearchPanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const docId = useDocs((s) => s.activeId)
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const hits = useMemo(() => searchProject(project, deferred), [project, deferred])
  const files = useFiles(deferred !== '')
  const open = useTextFiles((s) => s.files)
  const fileHits = useMemo((): FileHit[] => {
    if (!files || !deferred) return []
    const q = deferred.toLowerCase()
    let left = MAX_LINES
    return files.flatMap((f) => {
      // The text edited in its tab, else as read.
      const edited = open[textFileKey(docId, f.ref)]
      const lines = searchLines(edited && edited.saved !== null ? edited.text : f.text, deferred, left)
      left -= lines.length
      return lines.length || f.name.toLowerCase().includes(q) ? [{ file: f, lines }] : []
    })
  }, [files, deferred, open, docId])
  const lineCount = fileHits.reduce((n, h) => n + h.lines.length, 0)

  const openAt = (file: CodegenFile, at: TextSpot | undefined, e: MouseEvent): void =>
    void openTextFile(file.ref, { at, split: e.altKey })
  let row = 0
  const tabIndex = (): number => (row++ === 0 ? 0 : -1)

  return (
    <div className="search-panel">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Search names, descriptions, metadata, files"
          aria-label="Search the project and its templates and generated files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {deferred && (
        <p className="muted count" role="status">
          {hits.length} in the project
          {files
            ? ` · ${lineCount} lines in ${fileHits.length} files${lineCount >= MAX_LINES ? ' (first ones)' : ''}`
            : ' · reading the files…'}
        </p>
      )}
      <ul className="results" role="listbox" aria-label="Search results" onKeyDown={onListKeyDown}>
        {hits.map((h, i) => (
          <li
            key={i}
            data-item
            role="option"
            aria-selected={false}
            tabIndex={tabIndex()}
            onClick={() => navigate(h.target)}
          >
            <span className={`kind-badge ${h.target.kind === 'module' ? 'mod' : h.target.kind}`}>
              {h.target.kind[0]!.toUpperCase()}
            </span>
            <span className="result-label">{h.label}</span>
            <small>{h.field}</small>
            {h.text !== h.label.split(/[.:]/).pop() && (
              <span className="result-text">
                <Mark text={h.text} query={deferred} />
              </span>
            )}
          </li>
        ))}
        {fileHits.flatMap(({ file, lines }) => {
          const slash = file.name.lastIndexOf('/')
          const { id } = languageOf(file.name)
          const key = `${file.ref.source}:${file.ref.path}`
          return [
            <li
              key={key}
              data-item
              role="option"
              aria-selected={false}
              tabIndex={tabIndex()}
              className="file-hit"
              title={`${file.name} (Alt+click: to the side)`}
              onClick={(e) => openAt(file, undefined, e)}
            >
              <span className={`file-badge file-${id}`}>{LANGUAGE_BADGES[id]}</span>
              <span className="result-label">
                <Mark text={file.name.slice(slash + 1)} query={deferred} />
              </span>
              <small>
                {slash > 0 ? `${file.name.slice(0, slash)} · ` : ''}
                {file.kind}
              </small>
              {lines.length ? <span className="hit-count">{lines.length}</span> : null}
            </li>,
            ...lines.map((l) => (
              <li
                key={`${key}:${l.line}`}
                data-item
                role="option"
                aria-selected={false}
                tabIndex={tabIndex()}
                className="line-hit"
                title={`${file.name}:${l.line}`}
                onClick={(e) => openAt(file, l, e)}
              >
                <small className="line-number">{l.line}</small>
                <span className="result-line">
                  <Mark text={snippet(l.text, deferred)} query={deferred} />
                </span>
              </li>
            ))
          ]
        })}
      </ul>
    </div>
  )
}
