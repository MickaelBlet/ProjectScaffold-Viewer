// Code generation of the active document: the templates generating it and the files generated, each
// opened in an editor tab (in its own VS Code editor in VS Code).
import { useCallback, useDeferredValue, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { generatedFiles, LOCAL_TEMPLATES } from '@/codegen/run'
import { MANIFEST, parseManifest, templateFiles } from '@/codegen/templateSet'
import { LANGUAGE_BADGES, languageOf } from '@/components/codeLanguages'
import { onListKeyDown } from '@/components/listKeys'
import {
  builtinTemplates,
  canChooseTemplates,
  canGenerate,
  chooseTemplates,
  codegenListeners,
  generateCode,
  knownOutputDir,
  templateFolder
} from '@/generateCode'
import { activeDoc, useDocs, type DocState } from '@/store/documents'
import type { TextSource } from '@/store/textFiles'
import { openTextFile } from '@/textFileOps'

/** Files of a folder, opened from `source` under `prefix`. */
interface Listing {
  label: string
  source: TextSource
  prefix: string
  files: string[]
}

/** A listing, or why it could not be read (folder access not granted yet: `retry` asks for it). */
type Loaded = { listing: Listing | null } | { error: string }

const sorted = (files: string[]): string[] => [MANIFEST, ...files.filter((f) => f !== MANIFEST).sort()]

/** Templates generating the document: its template folder, else the output directory's, else built-in. */
async function templateListing(doc: DocState): Promise<Listing> {
  const folder = await templateFolder(doc)
  if (folder) {
    const manifest = await folder.read(MANIFEST)
    return {
      label: folder.label,
      source: 'templates',
      prefix: '',
      files: manifest === null ? [] : sorted(templateFiles(parseManifest(manifest)))
    }
  }
  const out = await knownOutputDir(doc)
  const local = out && (await out.read(`${LOCAL_TEMPLATES}/${MANIFEST}`))
  if (out && local)
    return {
      label: `${out.label}/${LOCAL_TEMPLATES}`,
      source: 'output',
      prefix: `${LOCAL_TEMPLATES}/`,
      files: sorted(templateFiles(parseManifest(local)))
    }
  const builtin = builtinTemplates().manifest
  return {
    label: `built-in ${builtin.name}`,
    source: 'builtin',
    prefix: '',
    files: sorted(templateFiles(builtin))
  }
}

async function generatedListing(doc: DocState): Promise<Listing | null> {
  const out = await knownOutputDir(doc)
  return out && { label: out.label, source: 'output', prefix: '', files: await generatedFiles(out) }
}

async function load<T extends Listing | null>(read: () => Promise<T>): Promise<Loaded> {
  try {
    return { listing: await read() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function FileList({ listing, filter }: { listing: Listing; filter: string }): ReactNode {
  const files = listing.files.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
  const open = (path: string, e?: MouseEvent): void =>
    void openTextFile({ source: listing.source, path: listing.prefix + path }, { split: e?.altKey })
  if (!files.length) return <p className="muted empty">{filter ? 'No match' : 'No files'}</p>
  return (
    <ul className="results file-list" role="listbox" onKeyDown={onListKeyDown}>
      {files.map((f, i) => {
        const slash = f.lastIndexOf('/')
        return (
          <li
            key={f}
            data-item
            role="option"
            aria-selected={false}
            tabIndex={i === 0 ? 0 : -1}
            title={`${f} (Alt+click: to the side)`}
            onClick={(e) => open(f, e)}
          >
            <span className={`kind-badge file-${languageOf(f).id}`}>{LANGUAGE_BADGES[languageOf(f).id]}</span>
            <span className="result-label">{f.slice(slash + 1)}</span>
            {slash > 0 ? <small>{f.slice(0, slash)}</small> : null}
          </li>
        )
      })}
    </ul>
  )
}

function Section(props: {
  title: string
  loaded: Loaded | null
  empty: ReactNode
  actions: ReactNode
  filter: string
  retry: () => void
}): ReactNode {
  const { loaded } = props
  return (
    <section className="explorer-section generation-section">
      <header>
        <span>{props.title}</span>
        {loaded && 'listing' in loaded && loaded.listing ? <small>{loaded.listing.label}</small> : null}
        <span className="spacer" />
        {props.actions}
      </header>
      {!loaded ? (
        <p className="muted empty">Reading…</p>
      ) : 'error' in loaded ? (
        <p className="muted empty">
          {loaded.error}{' '}
          <button type="button" className="link" onClick={props.retry}>
            Read again
          </button>
        </p>
      ) : loaded.listing ? (
        <FileList listing={loaded.listing} filter={props.filter} />
      ) : (
        props.empty
      )}
    </section>
  )
}

export function GenerationPanel(): ReactNode {
  const docId = useDocs((s) => s.activeId)
  const [templates, setTemplates] = useState<Loaded | null>(null)
  const [generated, setGenerated] = useState<Loaded | null>(null)
  const [query, setQuery] = useState('')
  const filter = useDeferredValue(query.trim())

  const refresh = useCallback((): void => {
    const doc = activeDoc()
    void load(() => templateListing(doc)).then((l) => activeDoc() === doc && setTemplates(l))
    void load(() => generatedListing(doc)).then((l) => activeDoc() === doc && setGenerated(l))
  }, [])
  useEffect(() => {
    refresh()
    codegenListeners.add(refresh)
    return () => void codegenListeners.delete(refresh)
  }, [docId, refresh])

  return (
    <div className="generation-panel">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter files"
          aria-label="Filter the templates and generated files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Section
        title="Templates"
        loaded={templates}
        filter={filter}
        retry={refresh}
        empty={null}
        actions={
          canChooseTemplates() ? (
            <button type="button" className="link" onClick={() => void chooseTemplates()}>
              Change…
            </button>
          ) : null
        }
      />
      <Section
        title="Generated"
        loaded={generated}
        filter={filter}
        retry={refresh}
        empty={<p className="muted empty">No code generated yet for this document.</p>}
        actions={
          <>
            {canGenerate() ? (
              <button type="button" className="link" onClick={() => void generateCode(false)}>
                Generate
              </button>
            ) : null}
            <button type="button" className="link" onClick={refresh} title="List the files again">
              Refresh
            </button>
          </>
        }
      />
    </div>
  )
}
