// Code generation of the active document: the templates generating it and the files generated, each
// opened in an editor tab (in its own VS Code editor in VS Code). Sections fold and reorder (drag their header,
// Alt+Up / Alt+Down, right click); the order is kept in the settings. Files show as a list or a folder tree.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode
} from 'react'
import { generatedFiles, LOCAL_TEMPLATES } from '@/codegen/run'
import { MANIFEST, parseManifest, templateFiles } from '@/codegen/templateSet'
import { LANGUAGE_BADGES, languageOf } from '@/components/codeLanguages'
import { FoldSection, placed, sectionOrder } from '@/components/FoldSection'
import { Icon, type IconName } from '@/components/Icon'
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

/** Folder of the tree view: its subfolders and files (paths from the listing root). */
interface Folder {
  name: string
  path: string
  folders: Folder[]
  files: string[]
}

/** Folder tree of `files`, in their order; a folder holding only one folder is one row (`a/b`). */
function fileTree(files: string[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [] }
  for (const f of files) {
    const parts = f.split('/')
    let node = root
    parts.slice(0, -1).forEach((name, i) => {
      let child = node.folders.find((c) => c.name === name)
      if (!child)
        node.folders.push((child = { name, path: parts.slice(0, i + 1).join('/'), folders: [], files: [] }))
      node = child
    })
    node.files.push(f)
  }
  const compact = (folder: Folder): Folder => {
    let f = folder
    while (!f.files.length && f.folders.length === 1)
      f = { ...f.folders[0]!, name: `${f.name}/${f.folders[0]!.name}` }
    return { ...f, folders: f.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) }
  }
  return { ...root, folders: root.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) }
}

type Row = { folder: Folder; depth: number; open: boolean } | { file: string; depth: number }

/** Rows of the tree, folders before files; every folder open while `allOpen`. */
function treeRows(root: Folder, collapsed: ReadonlySet<string>, allOpen: boolean): Row[] {
  const rows: Row[] = []
  const walk = (folder: Folder, depth: number): void => {
    for (const f of folder.folders) {
      const open = allOpen || !collapsed.has(f.path)
      rows.push({ folder: f, depth, open })
      if (open) walk(f, depth + 1)
    }
    for (const file of folder.files) rows.push({ file, depth })
  }
  walk(root, 0)
  return rows
}

const indent = (depth: number): CSSProperties => ({ paddingLeft: 6 + depth * 14 })

/** A file: its name, then its folder in the list view; indented by its `depth` in the tree view. */
function FileItem(props: {
  path: string
  first: boolean
  depth?: number
  open: (path: string, e: MouseEvent) => void
}): ReactNode {
  const { path, depth } = props
  const slash = path.lastIndexOf('/')
  const tree = depth !== undefined
  return (
    <li
      data-item
      role={tree ? 'treeitem' : 'option'}
      aria-selected={false}
      tabIndex={props.first ? 0 : -1}
      title={`${path} (Alt+click: to the side)`}
      style={tree ? indent(depth) : undefined}
      onClick={(e) => props.open(path, e)}
    >
      {tree ? <span className="chevron" aria-hidden /> : null}
      <span className={`kind-badge file-${languageOf(path).id}`}>{LANGUAGE_BADGES[languageOf(path).id]}</span>
      <span className="result-label">{path.slice(slash + 1)}</span>
      {!tree && slash > 0 ? <small>{path.slice(0, slash)}</small> : null}
    </li>
  )
}

/** Paths of the folders of `files` in the tree view. */
const folderPaths = (files: string[]): string[] =>
  treeRows(fileTree(files), new Set(), true).flatMap((row) => ('folder' in row ? [row.folder.path] : []))

function FileList(props: {
  listing: Listing
  filter: string
  tree: boolean
  collapsed: ReadonlySet<string>
  toggle: (folder: string) => void
}): ReactNode {
  const { listing, filter, collapsed, toggle } = props
  const files = listing.files.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
  const open = (path: string, e: MouseEvent): void =>
    void openTextFile({ source: listing.source, path: listing.prefix + path }, { split: e.altKey })
  if (!files.length) return <p className="muted empty">{filter ? 'No match' : 'No files'}</p>
  if (!props.tree)
    return (
      <ul className="results file-list" role="listbox" onKeyDown={onListKeyDown}>
        {files.map((f, i) => (
          <FileItem key={f} path={f} first={i === 0} open={open} />
        ))}
      </ul>
    )
  // While filtering, every folder holding a match is open.
  return (
    <ul className="results file-list" role="tree" onKeyDown={onListKeyDown}>
      {treeRows(fileTree(files), collapsed, !!filter).map((row, i) =>
        'file' in row ? (
          <FileItem key={row.file} path={row.file} first={i === 0} depth={row.depth} open={open} />
        ) : (
          <li
            key={`${row.folder.path}/`}
            data-item
            role="treeitem"
            aria-expanded={row.open}
            aria-selected={false}
            tabIndex={i === 0 ? 0 : -1}
            title={row.folder.path}
            style={indent(row.depth)}
            onClick={() => !filter && toggle(row.folder.path)}
            onKeyDown={(e) => {
              // Right opens, Left closes, as in the Explorer.
              if (filter || e.key !== (row.open ? 'ArrowLeft' : 'ArrowRight')) return
              e.preventDefault()
              toggle(row.folder.path)
            }}
          >
            <span className="chevron" aria-hidden>
              <Icon name={row.open ? 'chevron-down' : 'chevron-right'} />
            </span>
            <span className="file-folder" aria-hidden>
              <Icon name="folder" />
            </span>
            <span className="result-label">{row.folder.name}</span>
          </li>
        )
      )}
    </ul>
  )
}

function Section(props: {
  id: SectionId
  stack: { index: number; count: number }
  title: string
  loaded: Loaded | null
  empty: ReactNode
  filter: string
  tree: boolean
  collapsed: ReadonlySet<string>
  toggle: (folder: string) => void
  retry: () => void
}): ReactNode {
  const { id, loaded } = props
  return (
    <FoldSection
      id={id}
      dragType={SECTION_DRAG}
      className="generation-section"
      stack={props.stack}
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
        <FileList
          listing={loaded.listing}
          filter={props.filter}
          tree={props.tree}
          collapsed={props.collapsed}
          toggle={props.toggle}
        />
      ) : (
        props.empty
      )}
    </FoldSection>
  )
}

function ActionButton(props: {
  icon: IconName
  title: string
  pressed?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`icon ${props.pressed ? 'active' : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
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
  const tree = useSettings((s) => s.generationTree)
  const order = useMemo(() => sectionOrder(savedOrder, SECTIONS), [savedOrder])
  // Folded folders of the tree view, per section.
  const [collapsed, setCollapsed] = useState<Record<SectionId, ReadonlySet<string>>>({
    templates: new Set(),
    generated: new Set()
  })
  const toggle = (id: SectionId, folder: string): void => {
    const next = new Set(collapsed[id])
    if (!next.delete(folder)) next.add(folder)
    setCollapsed({ ...collapsed, [id]: next })
  }
  const folders = (l: Loaded | null): string[] =>
    l && 'listing' in l && l.listing ? folderPaths(l.listing.files) : []
  const allFolders: Record<SectionId, string[]> = {
    templates: folders(templates),
    generated: folders(generated)
  }
  const someOpen = SECTIONS.some((id) => allFolders[id].some((f) => !collapsed[id].has(f)))
  const foldAll = (): void =>
    setCollapsed({
      templates: new Set(someOpen ? allFolders.templates : []),
      generated: new Set(someOpen ? allFolders.generated : [])
    })

  const refresh = useCallback((): void => {
    const doc = activeDoc()
    void load(() => templateListing(doc)).then((l) => activeDoc().id === doc.id && setTemplates(l))
    void load(() => generatedListing(doc)).then((l) => activeDoc().id === doc.id && setGenerated(l))
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
          <ActionButton icon="templates" title="Change templates…" onClick={() => void chooseTemplates()} />
          {canGenerate() ? (
            <ActionButton icon="play" title="Generate" onClick={() => void generateCode(false)} />
          ) : null}
          <ActionButton icon="refresh" title="Refresh: list the files again" onClick={refresh} />
          <span className="spacer" />
          {tree && SECTIONS.some((id) => allFolders[id].length) ? (
            <ActionButton
              icon={someOpen ? 'collapse-all' : 'expand-all'}
              title={someOpen ? 'Fold all folders' : 'Unfold all folders'}
              onClick={foldAll}
            />
          ) : null}
          <ActionButton
            icon="tree"
            title="Files in folders"
            pressed={tree}
            onClick={() => setSetting('generationTree', !tree)}
          />
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
      <div className="stacked-sections">
        {order.map((id, index) =>
          id === 'templates' ? (
            <Section
              key={id}
              id={id}
              stack={{ index, count: order.length }}
              title="Templates"
              loaded={templates}
              filter={filter}
              tree={tree}
              collapsed={collapsed[id]}
              toggle={(folder) => toggle(id, folder)}
              retry={refresh}
              empty={null}
            />
          ) : (
            <Section
              key={id}
              id={id}
              stack={{ index, count: order.length }}
              title="Generated"
              loaded={generated}
              filter={filter}
              tree={tree}
              collapsed={collapsed[id]}
              toggle={(folder) => toggle(id, folder)}
              retry={refresh}
              empty={<p className="muted empty">No code generated yet for this document.</p>}
            />
          )
        )}
      </div>
    </div>
  )
}
