// Code generation of the active document: the templates generating it and the files generated, each
// opened in an editor tab (in its own VS Code editor in VS Code). Sections fold and reorder (drag their header,
// Alt+Up / Alt+Down, right click); the order is kept in the settings.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import { generatedFiles, LOCAL_TEMPLATES } from '@/codegen/run'
import { MANIFEST, parseManifest, templateFiles } from '@/codegen/templateSet'
import { LANGUAGE_BADGES, languageOf } from '@/components/codeLanguages'
import { FoldSection, placed, sectionOrder } from '@/components/FoldSection'
import { onListKeyDown } from '@/components/listKeys'
import {
  builtinTemplates,
  canGenerate,
  chooseTemplates,
  codegenListeners,
  generateCode,
  knownOutputDir,
  projectTemplateSet,
  templateFolder
} from '@/generateCode'
import { activeDoc, useDocs, type DocState } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { setSetting, useSettings } from '@/store/settings'
import { openContextMenu } from '@/store/ui'
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

const SECTIONS = ['templates', 'generated'] as const
type SectionId = (typeof SECTIONS)[number]
const SECTION_DRAG = 'application/x-generation-section'

const isSection = (s: string): s is SectionId => (SECTIONS as readonly string[]).includes(s)

function placeSection(id: SectionId, target: SectionId, after: boolean): void {
  const order = sectionOrder(useSettings.getState().generationOrder, SECTIONS)
  if (id !== target) setSetting('generationOrder', placed(order, id, target, after))
}

/** Moves a section past its neighbor above (-1) or below (1). */
function stepSection(id: SectionId, step: -1 | 1): void {
  const order = sectionOrder(useSettings.getState().generationOrder, SECTIONS)
  const target = order[order.indexOf(id) + step]
  if (target) placeSection(id, target, step > 0)
}

function sectionMenu(e: MouseEvent, id: SectionId): void {
  e.preventDefault()
  const order = sectionOrder(useSettings.getState().generationOrder, SECTIONS)
  const i = order.indexOf(id)
  openContextMenu(e, [
    { label: 'Move up', keys: 'Alt+Up', disabled: i <= 0, run: () => stepSection(id, -1) },
    { label: 'Move down', keys: 'Alt+Down', disabled: i >= order.length - 1, run: () => stepSection(id, 1) }
  ])
}

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
  const set = projectTemplateSet(doc.store.getState().project)
  const builtin = builtinTemplates(set).manifest
  return {
    label: `built-in ${builtin.name}`,
    source: 'builtin',
    prefix: `${set}/`,
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
  id: SectionId
  title: string
  loaded: Loaded | null
  empty: ReactNode
  filter: string
  retry: () => void
}): ReactNode {
  const { id, loaded } = props
  return (
    <FoldSection
      id={id}
      dragType={SECTION_DRAG}
      className="generation-section"
      title={
        <>
          <span className="explorer-title">{props.title}</span>
          <small>{loaded && 'listing' in loaded && loaded.listing ? loaded.listing.label : null}</small>
        </>
      }
      onPlace={(from, after) => isSection(from) && placeSection(from, id, after)}
      onStep={(step) => stepSection(id, step)}
      onContextMenu={(e) => sectionMenu(e, id)}
      revealOnClick
    >
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
    </FoldSection>
  )
}

export function GenerationPanel(): ReactNode {
  const docId = useDocs((s) => s.activeId)
  const templateSet = useProjectStore((s) => s.project.templates)
  const [templates, setTemplates] = useState<Loaded | null>(null)
  const [generated, setGenerated] = useState<Loaded | null>(null)
  const [query, setQuery] = useState('')
  const filter = useDeferredValue(query.trim())
  const savedOrder = useSettings((s) => s.generationOrder)
  const order = useMemo(() => sectionOrder(savedOrder, SECTIONS), [savedOrder])

  const refresh = useCallback((): void => {
    const doc = activeDoc()
    void load(() => templateListing(doc)).then((l) => activeDoc() === doc && setTemplates(l))
    void load(() => generatedListing(doc)).then((l) => activeDoc() === doc && setGenerated(l))
  }, [])
  useEffect(() => {
    refresh()
    codegenListeners.add(refresh)
    return () => void codegenListeners.delete(refresh)
  }, [docId, templateSet, refresh])

  return (
    <div className="generation-panel">
      <div className="panel-filter">
        <div className="generation-actions">
          <button type="button" className="link" onClick={() => void chooseTemplates()}>
            Change templates…
          </button>
          {canGenerate() ? (
            <button type="button" className="link" onClick={() => void generateCode(false)}>
              Generate
            </button>
          ) : null}
          <button type="button" className="link" onClick={refresh} title="List the files again">
            Refresh
          </button>
        </div>
        <input
          data-autofocus
          type="search"
          placeholder="Filter files"
          aria-label="Filter the templates and generated files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="generation-sections">
        {order.map((id) =>
          id === 'templates' ? (
            <Section
              key={id}
              id={id}
              title="Templates"
              loaded={templates}
              filter={filter}
              retry={refresh}
              empty={null}
            />
          ) : (
            <Section
              key={id}
              id={id}
              title="Generated"
              loaded={generated}
              filter={filter}
              retry={refresh}
              empty={<p className="muted empty">No code generated yet for this document.</p>}
            />
          )
        )}
      </div>
    </div>
  )
}
