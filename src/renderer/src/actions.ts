// Editing actions on the active document, shared by commands, menus and panels.
import { align, distribute, sameSize, type AlignMode } from '@/model/align'
import { arrange as arrangeProject, arrangeOptions } from '@/model/autoLayout'
import { copyItems, copyProject, parseClip, pasteClip, type Clip } from '@/model/clipboard'
import {
  addDependencies,
  addDependencyOf,
  type DependencyResult,
  type DependencySource
} from '@/model/dependencies'
import { idlImport, idlProject, parseIdlFiles, readIdlIncludes, type IdlFile } from '@/model/idl'
import { binarySnapshot, settleBinaries } from '@/model/binaries'
import {
  absolutePosition,
  absoluteRect,
  belowContent,
  boundsOf,
  childModules,
  defaultSize,
  findImported,
  findView,
  growAncestors,
  isImportedId,
  LAYOUT_PAD,
  contentBottom,
  contentTop,
  modulePath,
  newId,
  subtreeIds,
  uniqueName
} from '@/model/project'
import { targetAt, type SourceTarget } from '@/components/sourceTarget'
import { targetPath } from '@/model/locate'
import type { ProblemTarget } from '@/model/validate'
import {
  GLOBAL_VIEW,
  type Dependency,
  type Id,
  type Orientation,
  type Project,
  type Rect
} from '@/model/types'
import {
  activeDoc,
  activateDoc,
  patchDoc,
  travelSelection as travel,
  useDocs,
  type DocState
} from '@/store/documents'
import {
  addDependenciesFrom,
  detachDependencyById,
  addModule,
  addNote,
  addPort,
  addSubmodule,
  addView,
  deleteInterface,
  deleteItems,
  deleteLink,
  deleteType,
  getProject,
  placeModuleFrom,
  refreshDependenciesFrom,
  removeDependencyById,
  setHidden,
  setLayouts,
  setLocked,
  update
} from '@/store/project'
import {
  quickPick,
  select,
  setStatus,
  showDialog,
  useUiStore,
  type PickEntry,
  type Selection
} from '@/store/ui'
import { fileName } from '@/fileOps'
import { normalizeFile, relativeFile, resolveRelative, sameFile } from '@/model/sync'
import { formatFromPath, LoadError, loadText, toFile } from '@/model/serialize'
import type { OpenResult } from '@/api'
import { activeCanvas, openEditor, openView, showTool } from '@/shell/controllers'
import { IN_PANEL, IN_VSCODE } from '@/host'
import type { DiagramAction } from '../../../vscode/src/protocol'

// Selection

/** Entities the next copy / delete acts on: the canvas selection, else the inspected entity. */
export function selectedIds(): Id[] {
  const d = activeDoc()
  if (d.selectedIds.length) return d.selectedIds
  const s = d.selection
  return s && 'id' in s ? [s.id] : []
}

export function selectionOf(p: Project, id: Id): Selection {
  if (p.modules.some((m) => m.id === id)) return { kind: 'module', id }
  if (p.notes.some((n) => n.id === id)) return { kind: 'note', id }
  if (p.types.some((t) => t.id === id)) return { kind: 'type', id }
  if (p.interfaces.some((i) => i.id === id)) return { kind: 'interface', id }
  if (p.links.some((l) => l.id === id)) return { kind: 'link', id }
  if (findImported(p, id)) return { kind: 'imported', id }
  return null
}

/** Select several entities; the first one is shown in the inspector. */
export function selectMany(ids: Id[]): void {
  const first = ids[0]
  patchDoc({ selectedIds: ids, selection: first ? selectionOf(getProject(), first) : null })
}

export function selectAll(): void {
  const p = getProject()
  const view = findView(p, activeDoc().activeViewId)
  const scope = view.rootModuleId
  // Top-level entities of the view: selecting them moves their content along.
  selectMany([...childModules(p, scope).map((m) => m.id), ...(scope ? [] : p.notes.map((n) => n.id))])
}

/** Select an entity and bring it into view (zoomed on it with `zoom`). */
export function navigate(target: ProblemTarget, { zoom = false }: { zoom?: boolean } = {}): void {
  const before = activeDoc().selection
  if (target.kind === 'project' || target.kind === 'const') select({ kind: 'project' })
  else
    select(target.kind === 'module' && isImportedId(target.id) ? { kind: 'imported', id: target.id } : target)
  // VS Code side panel: the diagram shows it (installSelectionSync tells it of a new selection).
  if (IN_PANEL) {
    if (!revealing && activeDoc().selection === before) postSelection()
    return
  }
  if (target.kind === 'project') return
  if (target.kind === 'type' || target.kind === 'interface' || target.kind === 'const')
    return showTool('inspector', false)
  const p = getProject()
  const link = target.kind === 'link' ? p.links.find((l) => l.id === target.id) : undefined
  const ids = link ? [link.from.moduleId, link.to.moduleId] : [target.id]
  // Show the module (a link: at least one end) in a view that contains it.
  let view = findView(p, activeDoc().activeViewId)
  const root = view.rootModuleId
  if (root && !ids.some((id) => subtreeIds(p, root).has(id))) {
    openView(GLOBAL_VIEW)
    view = findView(p, GLOBAL_VIEW)
  }
  if (view.hidden.length) {
    const hiddenAncestors = view.hidden.filter((h) => ids.some((id) => subtreeIds(p, h).has(id)))
    if (hiddenAncestors.length) setHidden(view.id, hiddenAncestors, false)
  }
  revealWhenDrawn(ids, zoom)
}

/** Selection shown for the text cursor: not sent back to move it. */
let revealing = false

function isSelected(target: SourceTarget): boolean {
  const s = activeDoc().selection
  const kind = s?.kind === 'imported' ? 'module' : s?.kind
  return kind === target.kind && (s && 'id' in s ? s.id : null) === ('id' in target ? target.id : null)
}

/** Show the entity at a data path of the file, `names` naming its list items (see targetAt). */
export function navigateToPath(path: (string | number)[], names: (string | undefined)[]): void {
  const target = targetAt(getProject(), path, names)
  // Already selected: the view stays where the user left it.
  if (!target || isSelected(target)) return
  revealing = true
  try {
    if (target.kind === 'note') navigateToNote(target.id, { zoom: true })
    else navigate(target, { zoom: true })
  } finally {
    revealing = false
  }
}

/** VS Code: tells the other pages of the document (and the text cursor) of the selection. */
function postSelection(doc: DocState = activeDoc()): void {
  const selection = doc.selection
  if (!selection || selection.kind === 'note') return
  const target: ProblemTarget =
    selection.kind === 'imported' ? { kind: 'module', id: selection.id } : selection
  const p = doc.store.getState().project
  window.api.selected?.(targetPath(toFile(p, { editor: false }), p, target))
}

/** VS Code: the text cursor and the other pages of the document follow the selection. */
export function installSelectionSync(): () => void {
  return useDocs.subscribe((s, prev) => {
    const doc = activeDoc(s)
    if (!revealing && doc.selection !== activeDoc(prev).selection) postSelection(doc)
  })
}

const viewName = (d: DocState): string | null =>
  d.activeViewId === GLOBAL_VIEW
    ? null
    : (d.store.getState().project.views.find((v) => v.id === d.activeViewId)?.name ?? null)

/** VS Code diagram: the side panels follow the view it shows. */
export function installViewSync(): () => void {
  window.api.viewChanged?.(viewName(activeDoc()))
  return useDocs.subscribe((s, prev) => {
    if (activeDoc(s).activeViewId !== activeDoc(prev).activeViewId)
      window.api.viewChanged?.(viewName(activeDoc(s)))
  })
}

/** VS Code side panel: the view the diagram shows, by name (null: global). */
export function showDiagramView(name: string | null): void {
  const view = name === null ? undefined : getProject().views.find((v) => v.name === name)
  patchDoc({ activeViewId: view?.id ?? GLOBAL_VIEW })
}

/** VS Code diagram: an action asked by a side panel (commands: see runCommand). */
export function runDiagramAction(action: Exclude<DiagramAction, { kind: 'command' }>): void {
  const p = getProject()
  if (action.kind === 'openView') {
    const view = action.view === null ? GLOBAL_VIEW : p.views.find((v) => v.name === action.view)?.id
    if (view) openView(view, { split: action.split })
    return
  }
  const target = targetAt(p, action.path, [])
  if (target?.kind === action.editor) openEditor(action.editor, target.id, { split: action.split })
}

/** Select a note and show it (notes are drawn in the global view only). */
export function navigateToNote(id: Id, { zoom = false }: { zoom?: boolean } = {}): void {
  select({ kind: 'note', id })
  if (findView(getProject(), activeDoc().activeViewId).rootModuleId) openView(GLOBAL_VIEW)
  revealWhenDrawn([id], zoom)
}

/** Go back (-1) or forward (1) through the selection history, showing each entity. */
export function travelSelection(delta: -1 | 1): void {
  const p = getProject()
  travel(
    delta,
    (s) => s.kind === 'project' || selectionOf(p, s.id)?.kind === s.kind,
    (s) => {
      if (s.kind === 'note') return navigateToNote(s.id)
      navigate(s.kind === 'imported' ? { kind: 'module', id: s.id } : s)
    }
  )
}

/** Reveal once the canvas shows the nodes (a view just opened or unhidden needs a few frames). */
function revealWhenDrawn(ids: Id[], zoom = false, tries = 10): void {
  requestAnimationFrame(() => {
    const canvas = activeCanvas()
    const show = (): void => (zoom ? canvas?.fit(ids) : canvas?.reveal(ids))
    if (canvas && ids.some((id) => canvas.nodeRect(id))) return show()
    if (tries > 0) revealWhenDrawn(ids, zoom, tries - 1)
    else show()
  })
}

// Clipboard

let memoryClip: Clip | null = null
let pasteKey = ''
let pasteCount = 0

function writeClip(clip: Clip, data?: DataTransfer | null): void {
  memoryClip = clip
  const text = JSON.stringify(clip)
  pasteKey = text
  pasteCount = 0
  if (data) data.setData('text/plain', text)
  else void navigator.clipboard?.writeText(text).catch(() => {})
}

/** Copy the selection. With a clipboard event, writes to it; else to the system clipboard when allowed. */
export function copySelection(data?: DataTransfer | null): boolean {
  const clip = copyItems(getProject(), selectedIds())
  if (!clip) return false
  writeClip(clip, data)
  const n =
    Object.keys(clip.rootParents).length + clip.notes.length + clip.types.length + clip.interfaces.length
  setStatus('info', `Copied ${n} item${n > 1 ? 's' : ''}`)
  return true
}

export function cutSelection(data?: DataTransfer | null): boolean {
  if (!copySelection(data)) return false
  deleteSelection()
  return true
}

/** Paste a clip: next to the originals, or at `at` (absolute) inside `parent`. */
export function pasteItems(clip: Clip, place?: { at: { x: number; y: number }; parent: Id | null }): void {
  const text = JSON.stringify(clip)
  pasteCount = text === pasteKey ? pasteCount + 1 : 1
  pasteKey = text
  let pasted: Id[] = []
  update((d) => {
    pasted = place
      ? pasteClip(d, clip, { parent: place.parent, at: place.at })
      : pasteClip(d, clip, { parent: 'original', offset: 30 * pasteCount })
  })
  selectMany(pasted)
  setStatus('info', `Pasted ${pasted.length} item${pasted.length > 1 ? 's' : ''}`)
}

/** Paste from clipboard event data, else the system clipboard, else the last copy. */
export async function paste(
  data?: DataTransfer | null,
  place?: { at: { x: number; y: number }; parent: Id | null }
): Promise<boolean> {
  let text = data?.getData('text/plain') ?? null
  if (text === null) text = (await navigator.clipboard?.readText().catch(() => null)) ?? null
  const clip = (text !== null ? parseClip(text) : null) ?? (data ? null : memoryClip)
  if (!clip) return false
  pasteItems(clip, place)
  return true
}

export function duplicateSelection(): void {
  const clip = copyItems(getProject(), selectedIds())
  if (!clip) return
  let pasted: Id[] = []
  update((d) => void (pasted = pasteClip(d, clip, { parent: 'original', offset: 30 })))
  selectMany(pasted)
}

// Deletion

export function deleteSelection(): void {
  const p = getProject()
  const ids = selectedIds()
  const sel = activeDoc().selection
  if (sel?.kind === 'link' && !activeDoc().selectedIds.length) {
    deleteLink(sel.id)
    return select(null)
  }
  const blocked: string[] = []
  const canvasIds = ids.filter(
    (id) => p.modules.some((m) => m.id === id) || p.notes.some((n) => n.id === id) || !!findImported(p, id)
  )
  if (canvasIds.length) deleteItems(canvasIds)
  for (const id of ids) {
    const iface = p.interfaces.find((i) => i.id === id)
    if (iface) {
      const reasons = deleteInterface(id)
      if (reasons.length) blocked.push(`${iface.name}: kept by ${reasons.join(', ')}`)
    }
    const type = p.types.find((t) => t.id === id)
    if (type) {
      const usages = deleteType(id)
      if (usages.length) blocked.push(`${type.name}: used by ${usages.join(', ')}`)
    }
  }
  if (blocked.length) showDialog('Some types and interfaces were not deleted', blocked)
  select(null)
}

// Creation

/** Where new modules go in the focused view: its root module, or the top level. */
function viewParent(): Id | null {
  return findView(getProject(), activeDoc().activeViewId).rootModuleId
}

export function addModuleAt(pos?: { x: number; y: number }, parentId: Id | null = viewParent()): Id {
  const p = getProject()
  const c = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  const origin = parentId ? absolutePosition(p, parentId) : { x: 0, y: 0 }
  const size = defaultSize({ ports: [] }, p.orientation)
  const x = Math.round(c.x - origin.x - (pos ? 0 : size.width / 2))
  const y = Math.round(c.y - origin.y - (pos ? 0 : size.height / 2))
  const id = addModule(parentId, x, y)
  select({ kind: 'module', id })
  return id
}

export function addSubmoduleToSelection(): void {
  const sel = activeDoc().selection
  if (sel?.kind !== 'module') return void addModuleAt()
  select({ kind: 'module', id: addSubmodule(sel.id) })
}

export function addPortToSelection(role: 'in' | 'out'): void {
  const sel = activeDoc().selection
  if (sel?.kind === 'module') addPort(sel.id, role)
}

export function addNoteAt(kind: 'note' | 'frame', pos?: { x: number; y: number }): void {
  const c = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  const id = addNote(kind, Math.round(c.x), Math.round(c.y))
  select({ kind: 'note', id })
}

// Dependencies: other projects

/** Another project to depend on or link to: an open document, or a file read without opening it. */
interface OtherProject {
  project: Project
  file: string
}

const SOURCE_FILES = { description: 'Projects and IDL files', extensions: ['yaml', 'yml', 'json', 'idl'] }
const isIdl = (path: string): boolean => /\.idl$/i.test(path)

/** Reads a file IDL files include: by absolute path, else relative to this document. */
async function readInclude(path: string): Promise<string | null> {
  if (/^([\\/]|[A-Za-z]:)/.test(path)) return (await window.api.readFile?.(path)) ?? null
  return (await window.api.readSibling?.(path)) ?? null
}

/**
 * The project a file stands for: a project file, or an IDL file whose includes are read by the
 * host when it can, else looked up among `others` (IDL files by path). Throws when it cannot be read.
 */
async function projectOfFile(
  path: string,
  content: string,
  others: ReadonlyMap<string, string> = new Map()
): Promise<{ project: Project; warnings: string[] }> {
  if (!isIdl(path)) return { project: loadText(content, formatFromPath(path)), warnings: [] }
  let files = new Map([...others, [path, content]])
  const host = !!(window.api.readFile || window.api.readSibling)
  if (host) files = await readIdlIncludes(files, readInclude)
  const { project, warnings, missing } = idlProject(path, files)
  if (missing.length && !host) warnings.push('Pick the included files along with the IDL file to read them.')
  return { project, warnings }
}

const problemsOf = (e: unknown): string[] =>
  e instanceof LoadError ? e.problems : [e instanceof Error ? e.message : String(e)]

/** Picked files as projects, and lines telling what could not be read or was approximated. */
async function readPicked(picked: OpenResult[]): Promise<{ projects: OtherProject[]; lines: string[] }> {
  const here = activeDoc().filePath
  const idl = new Map(picked.filter((f) => isIdl(f.path)).map((f) => [f.path, f.content]))
  const projects: OtherProject[] = []
  const lines: string[] = []
  for (const f of picked) {
    const name = fileName(f.path)
    try {
      const { project, warnings } = await projectOfFile(f.path, f.content, idl)
      projects.push({ project, file: relativeFile(here, f.path) })
      lines.push(...warnings.map((w) => `${name}: ${w}`))
    } catch (e) {
      lines.push(...problemsOf(e).map((x) => `${name}: ${x}`))
    }
  }
  return { projects, lines }
}

/** Name of a few projects, for messages. */
const namesOf = (others: OtherProject[]): string =>
  others.length === 1 ? others[0]!.file : `${others.length} projects`

/** Open documents but this one, as projects to pick. `needFile`: unsaved ones are refused. */
function openProjects(
  needFile = true,
  describe = (p: Project): string => `${p.modules.length} modules`
): { label: string; detail: string; get: () => Promise<OtherProject | null> }[] {
  const { docs, activeId } = useDocs.getState()
  // Dependencies name their file relative to this one.
  const here = activeDoc().filePath
  return docs
    .filter((d) => d.id !== activeId)
    .map((d) => {
      const project = d.store.getState().project
      return {
        label: d.filePath ? fileName(d.filePath) : `${project.name} (unsaved)`,
        detail: `open · ${describe(project)}`,
        get: (): Promise<OtherProject | null> => {
          if (d.filePath || !needFile)
            return Promise.resolve({
              project,
              file: d.filePath ? relativeFile(here, d.filePath) : project.name
            })
          showDialog('Save the other project first', [
            `"${project.name}" has no file yet: links to it need its file name.`
          ])
          return Promise.resolve(null)
        }
      }
    })
}

/** Entry of a project pick reading files: project files and IDL files, several at once. */
const filesEntry = (run: (files: OpenResult[]) => void): PickEntry => ({
  key: 'files',
  label: 'Open files…',
  detail: 'read project files and IDL files, several at once',
  kind: 'P',
  run: () =>
    void window.api.openFiles(SOURCE_FILES).then((files) => {
      if (files.length) run(files)
    })
})

/** Lines telling what a change of dependencies did, when there is more than the change itself. */
function dependencyLines(r: DependencyResult): string[] {
  return [
    ...r.conflicts.map((x) => `Not taken: ${x}`),
    ...r.renamed.map((x) => `Renamed ${x}`),
    ...r.detached.map((x) => `${x}: no longer in its project, kept here`),
    ...r.missing
  ]
}

/** Pick a module of `others` and place it on the canvas at `at`, depending on its project. */
function pickModuleOf(others: OtherProject[], at: { x: number; y: number }, lines: string[] = []): void {
  const entries = others.flatMap((other) =>
    other.project.modules.map((m) => ({
      key: `${other.file}:${m.id}`,
      label: modulePath(other.project, m.id),
      detail: [
        others.length > 1 && other.file,
        m.ports.map((pt) => `${pt.role} ${pt.name}`).join(', ') || 'no ports'
      ]
        .filter(Boolean)
        .join(' · '),
      kind: 'M',
      run: () => {
        if (activeDoc().activeViewId !== GLOBAL_VIEW) openView(GLOBAL_VIEW)
        const { id, result } = placeModuleFrom(other.project, other.file, m.id, at, selfFile())
        if (id) select({ kind: 'imported', id })
        const all = [...lines, ...dependencyLines(result)]
        if (all.length) showDialog(`Linking to ${other.file}`, all)
      }
    }))
  )
  if (!entries.length) {
    if (lines.length) showDialog(`Read ${namesOf(others)}`, lines)
    return setStatus('error', `${namesOf(others)} has no modules`)
  }
  quickPick(`Module of ${namesOf(others)} to link to`, entries)
}

/** The dependencies of this project, read from their files, as projects to pick from. */
function dependencyProjects(): { label: string; detail: string; get: () => Promise<OtherProject | null> }[] {
  return getProject().dependencies.map((x) => ({
    label: x.name,
    detail: `dependency · ${x.file}`,
    get: async (): Promise<OtherProject | null> => {
      const project = await importSource(x.file)
      if (project) return { project, file: x.file }
      showDialog(`Cannot read ${x.file}`, [cannotRead(x.name, x.file)])
      return null
    }
  }))
}

/**
 * Pick a project (this one's dependencies first), then one of its modules: it is placed on the
 * canvas (global view) and its ports can be linked to. The project becomes a dependency: its
 * interfaces and types are used here, not copied.
 */
export function linkOtherProject(pos?: { x: number; y: number }): void {
  const at = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  const deps = getProject().dependencies
  const others = openProjects().filter((o) => !deps.some((x) => sameFile(x.file, o.label)))
  quickPick('Project to link to', [
    ...[...dependencyProjects(), ...others].map((o, i) => ({
      key: String(i),
      label: o.label,
      detail: o.detail,
      kind: 'P',
      run: () =>
        void o.get().then((other) => {
          if (other) pickModuleOf([other], at)
        })
    })),
    filesEntry(
      (files) =>
        void readPicked(files).then(({ projects, lines }) => {
          if (projects.length) pickModuleOf(projects, at, lines)
          else showDialog(`Cannot read ${files.length === 1 ? fileName(files[0]!.path) : 'the files'}`, lines)
        })
    )
  ])
}

/** Pick a module of a dependency and place it on the canvas. */
export function placeDependencyModule(id: Id, pos?: { x: number; y: number }): void {
  const dep = getProject().dependencies.find((x) => x.id === id)
  if (!dep) return
  const at = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  void importSource(dep.file).then((project) => {
    if (project) pickModuleOf([{ project, file: dep.file }], at)
    else showDialog(`Cannot read ${dep.file}`, [cannotRead(dep.name, dep.file)])
  })
}

/** Where imported content goes: the selected module, else the focused view's module. */
function importParent(): Id | null {
  const sel = activeDoc().selection
  return sel?.kind === 'module' ? sel.id : viewParent()
}

/** File of a dependency `n` of `other`, relative to this project. */
const fileOf = (other: OtherProject, n: Dependency): string =>
  normalizeFile(resolveRelative(other.file, n.file))

/** `others` with the ones others depend on first. */
function dependenciesFirst(others: OtherProject[]): OtherProject[] {
  const byFile = new Map(others.map((o) => [normalizeFile(o.file), o]))
  const out: OtherProject[] = []
  const seen = new Set<OtherProject>()
  const visit = (o: OtherProject): void => {
    if (seen.has(o)) return
    seen.add(o)
    for (const n of o.project.dependencies) {
      const used = byFile.get(fileOf(o, n))
      if (used) visit(used)
    }
    out.push(o)
  }
  others.forEach(visit)
  return out
}

/**
 * The projects the dependencies of `roots` use, transitively, that can be read (open, or next to
 * this file): taken from their files rather than from the snapshots `roots` have of them.
 */
async function readableDependencies(roots: OtherProject[]): Promise<DependencySource[]> {
  const seen = new Set(roots.map((r) => normalizeFile(r.file)))
  const out: DependencySource[] = []
  const queue = [...roots]
  for (let r = queue.shift(); r; r = queue.shift())
    for (const n of r.project.dependencies) {
      const file = fileOf(r, n)
      if (seen.has(file)) continue
      seen.add(file)
      const project = await importSource(file)
      if (!project) continue
      const source = { project, file, indirect: true }
      out.push(source)
      queue.push(source)
    }
  return out
}

/**
 * Pick other projects and copy their content into `parent` (a module, or the top level): their
 * modules with their links, their notes (top level only), and the types and interfaces this
 * project lacks (the others are matched by name). Nothing ties the copy to those projects
 * afterwards, but the dependencies they use are used here too. IDL files picked are imported too.
 */
export function importProjectContent(
  parent: Id | null = importParent(),
  pos?: { x: number; y: number }
): void {
  quickPick('Projects to import', [
    ...openProjects(false).map((o, i) => ({
      key: String(i),
      label: o.label,
      detail: o.detail,
      kind: 'P',
      run: () =>
        void o.get().then((other) => {
          if (other) void importProjects([other], parent, pos)
        })
    })),
    filesEntry((files) => {
      const idl = files.filter((f) => isIdl(f.path))
      const projects = files.filter((f) => !isIdl(f.path))
      if (!projects.length) return void importIdlFiles(idl)
      void (async () => {
        // IDL files first, whole, then the projects below them.
        const below = idl.length ? await importIdlFiles(idl, true) : []
        const read = await readPicked(projects)
        await importProjects(read.projects, parent, pos, read.lines, below)
      })()
    })
  ])
}

/**
 * Copy the content of projects (see `importProjectContent`), one below the other (below the
 * modules `below`, when given). Those another one depends on come first: their content stands for
 * that dependency.
 */
async function importProjects(
  others: OtherProject[],
  parent: Id | null,
  pos?: { x: number; y: number },
  lines: string[] = [],
  below: Id[] = []
): Promise<void> {
  if (!others.length) {
    if (lines.length) showDialog('Nothing imported', lines)
    return
  }
  const picked = new Set(others.map((o) => normalizeFile(o.file)))
  const uses = (o: OtherProject): Dependency[] =>
    o.project.dependencies.filter((n) => !n.indirect && !picked.has(fileOf(o, n)))
  // Dependencies read from their files; the others from the snapshots the projects have.
  const direct = new Set(others.flatMap((o) => uses(o).map((n) => fileOf(o, n))))
  const sources = (await readableDependencies(others)).map((s) => ({
    ...s,
    indirect: !direct.has(normalizeFile(s.file))
  }))
  const read = new Set(sources.map((s) => normalizeFile(s.file)))

  const p = getProject()
  let at = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  if (!pos && parent) {
    // Below the module's current content, like a new submodule.
    const origin = absolutePosition(p, parent)
    at = { x: origin.x + LAYOUT_PAD, y: origin.y + belowContent(p, parent) }
  }
  const after = (d: Project, ids: Id[]): void => {
    const modules = ids.filter((id) => d.modules.some((m) => m.id === id))
    if (!modules.length) return
    const b = boundsOf(modules.map((id) => absoluteRect(d, id)))
    at = { x: at.x, y: b.y + b.height + IMPORT_GAP }
  }
  after(p, below)
  const pasted: Id[] = []
  const empty: string[] = []
  let modules = 0
  let defs = 0
  update((d) => {
    // The dependencies of those projects are used here too, not copied.
    if (sources.length) lines.push(...dependencyLines(addDependencies(d, sources, selfFile())))
    for (const o of others)
      for (const n of uses(o))
        if (!read.has(fileOf(o, n)))
          lines.push(...dependencyLines(addDependencyOf(d, o.project, o.file, n.id)))
    for (const o of dependenciesFirst(others)) {
      const content = copyProject(o.project, d, !parent)
      if (!content) {
        empty.push(`${o.file} is empty`)
        continue
      }
      modules += Object.keys(content.rootParents).length
      defs += content.types.length + content.interfaces.length
      const ids = pasteClip(d, content, { parent, at })
      pasted.push(...ids)
      after(d, ids)
    }
  })
  selectMany(pasted)
  lines.push(...empty)
  const what = `Imported ${modules} modules, ${defs} types and interfaces from ${namesOf(others)}`
  if (lines.length) showDialog(what, lines)
  else setStatus('info', what)
}

const IMPORT_GAP = 60

/**
 * Imports IDL files: their interfaces and components (one picked or all, or all with `whole`)
 * with the types they use. Included files are read by the host when it can, else looked up among
 * the picked files. Resolves to the pasted entities (none while picking).
 */
async function importIdlFiles(picked: OpenResult[], whole = false): Promise<Id[]> {
  const label = picked.length === 1 ? fileName(picked[0]!.path) : `${picked.length} IDL files`
  let idl: IdlFile
  try {
    let files = new Map(picked.map((f) => [f.path, f.content]))
    const read = window.api.readFile?.bind(window.api)
    if (read) files = await readIdlIncludes(files, read)
    idl = parseIdlFiles(files)
  } catch (e) {
    showDialog(`Cannot read ${label}`, problemsOf(e))
    return []
  }
  if (!idl.interfaces.length && !idl.types.length && !idl.components.length) {
    setStatus('error', `${label} defines no interfaces, components nor types`)
    return []
  }
  const run = (only?: string[]): Id[] => {
    const p = getProject()
    const { clip, existing, unresolved } = idlImport(idl, p, only)
    const kept = existing.length ? `, ${existing.join(', ')} already defined` : ''
    if (!clip) {
      setStatus('info', `Nothing to import from ${label}${kept}`)
      return []
    }
    const at = clip.modules.length ? (activeCanvas()?.center() ?? { x: 80, y: 80 }) : undefined
    let pasted: Id[] = []
    update((d) => {
      pasted = pasteClip(d, clip, { parent: null, at })
    })
    selectMany(pasted)
    const counts = [
      clip.modules.length && `${clip.modules.length} modules`,
      `${clip.interfaces.length} interfaces`,
      `${clip.types.length} types`
    ].filter(Boolean)
    setStatus('info', `Imported ${counts.join(', ')} from ${label}${kept}`)
    const notes = [
      ...idl.warnings,
      ...unresolved.map((n) => `${n} is defined in none of the files: added empty`),
      ...(idl.missing.length && !window.api.readFile
        ? ['Pick the included files along with the IDL file to read their definitions.']
        : [])
    ]
    if (notes.length) showDialog(`Imported from ${label}`, notes)
    return pasted
  }
  const entries = idl.components.length + idl.interfaces.length
  if (whole || entries < 2) return run()
  quickPick('Component or interface to import', [
    {
      key: '*',
      label: 'All',
      detail: [
        idl.components.length && `${idl.components.length} components`,
        idl.interfaces.length && `${idl.interfaces.length} interfaces`
      ]
        .filter(Boolean)
        .join(', '),
      kind: '*',
      run: () => void run()
    },
    ...idl.components.map((c) => ({
      key: `c:${c.name}`,
      label: c.name,
      detail: `component, ${c.ports.length} ports`,
      kind: 'M',
      run: () => void run([c.name])
    })),
    ...idl.interfaces.map((i) => ({
      key: `i:${i.name}`,
      label: i.name,
      detail: `${i.messages.length} messages`,
      kind: 'I',
      run: () => void run([i.name])
    }))
  ])
  return []
}

/**
 * Project of a dependency: from the open document of the same file name, else (VS Code) from the
 * file next to the document (an IDL file with the files it includes).
 */
async function importSource(file: string): Promise<Project | null> {
  const doc = useDocs
    .getState()
    .docs.find((d) => d.id !== activeDoc().id && d.filePath && fileName(d.filePath) === fileName(file))
  if (doc) return doc.store.getState().project
  const text = await window.api.readSibling?.(file)
  if (!text) return null
  try {
    return (await projectOfFile(file, text)).project
  } catch {
    return null
  }
}

const cannotRead = (name: string, file: string): string =>
  window.api.readSibling
    ? `${name}: cannot read ${file} next to this file`
    : isIdl(file)
      ? `${name}: add ${file} as a dependency again to read it`
      : `${name}: open ${file} in a tab to read it`

/** This project's file name: it cannot depend on itself. */
const selfFile = (): string | null => {
  const path = activeDoc().filePath
  return path ? fileName(path) : null
}

/**
 * Pick other projects (project files or IDL files) and depend on them: their types and interfaces
 * are used here, read-only, with those of the projects they depend on (read from their files when
 * they can be, else as these projects last read them), and their modules can be placed on the
 * canvas to link to. They are refreshed from their files (Refresh, or live while open).
 */
export function pickDependency(): void {
  const deps = getProject().dependencies
  quickPick('Projects to depend on', [
    ...openProjects(
      true,
      (p) => `${p.types.length} types, ${p.interfaces.length} interfaces, ${p.modules.length} modules`
    )
      .filter((o) => !deps.some((x) => !x.indirect && sameFile(x.file, o.label)))
      .map((o, i) => ({
        key: String(i),
        label: o.label,
        detail: o.detail,
        kind: 'P',
        run: () =>
          void o.get().then((other) => {
            if (other) void dependOn([other])
          })
      })),
    filesEntry((files) => void readPicked(files).then(({ projects, lines }) => dependOn(projects, lines)))
  ])
}

async function dependOn(others: OtherProject[], lines: string[] = []): Promise<void> {
  if (!others.length) {
    if (lines.length) showDialog('No dependency added', lines)
    return
  }
  const nested = await readableDependencies(others)
  lines.push(...dependencyLines(addDependenciesFrom([...others, ...nested], selfFile())))
  const what = `Depending on ${namesOf(others)}`
  if (lines.length) return showDialog(what, lines)
  setStatus(
    'info',
    `${what}: ${others.length === 1 ? 'its' : 'their'} types and interfaces are read-only here`
  )
}

/** Read dependencies again from their projects (all, or those of these ids). */
export async function refreshDependencies(ids?: Id[]): Promise<void> {
  const lines: string[] = []
  const sources = new Map<Id, Project>()
  for (const x of getProject().dependencies) {
    if (ids && !ids.includes(x.id)) continue
    const source = await importSource(x.file)
    if (source) sources.set(x.id, source)
    // Indirect dependencies also come with the dependencies using them.
    else if (!x.indirect) lines.push(cannotRead(x.name, x.file))
  }
  if (sources.size) lines.push(...dependencyLines(refreshDependenciesFrom(sources, selfFile())))
  const what = `Refreshed ${sources.size} dependenc${sources.size === 1 ? 'y' : 'ies'}`
  if (lines.length) showDialog(what, lines)
  else setStatus('info', what)
}

/** Stop depending on a project, or explain what keeps it. */
export function removeDependencyAction(id: Id): void {
  const dep = getProject().dependencies.find((x) => x.id === id)
  if (!dep) return
  const blockers = removeDependencyById(id)
  if (blockers.length)
    showDialog(`Dependency ${dep.name} is still used`, [
      ...blockers.map((b) => `Used by: ${b}`),
      'Remove its modules from the canvas, or detach it to keep its types and interfaces here as your own.'
    ])
  else setStatus('info', `No longer depending on ${dep.file}`)
}

/** Make a dependency's types and interfaces this project's own. */
export function detachDependencyAction(id: Id): void {
  const dep = getProject().dependencies.find((x) => x.id === id)
  if (!dep) return
  const blockers = detachDependencyById(id)
  if (blockers.length)
    showDialog(
      `Dependency ${dep.name} is still used`,
      blockers.map((b) => `Used by: ${b}`)
    )
  else setStatus('info', `Types and interfaces of ${dep.name} are now this project's own`)
}

/** Show a dependency's content in the Dependencies panel. */
export function showDependency(id: Id): void {
  useUiStore.setState({ dependency: id })
  // VS Code: the Dependencies panel is a page of the side bar, told which one by name.
  const dep = getProject().dependencies.find((x) => x.id === id)
  if (IN_VSCODE && dep) return window.api.showPanel?.('dependencies', dep.name)
  showTool('dependencies')
}

/** VS Code Dependencies side panel: the dependency another page shows, by name. */
export function showDependencyNamed(name: string): void {
  const dep = getProject().dependencies.find((x) => x.name === name)
  if (dep) useUiStore.setState({ dependency: dep.id })
}

/** Show the project of a dependency in its tab when it is open (VS Code: in its editor). */
export function openImportSource(file: string): void {
  if (window.api.openSibling) return window.api.openSibling(file)
  const doc = useDocs.getState().docs.find((d) => d.filePath && fileName(d.filePath) === fileName(file))
  if (doc) activateDoc(doc.id)
  else setStatus('info', `${file} is not open`)
}

export function startRename(): void {
  const sel = activeDoc().selection
  if (sel?.kind === 'module') useUiStore.setState({ renaming: sel.id })
}

// Locking

/** Selected modules and notes. */
function selectedCanvasItems(): (Project['modules'][number] | Project['notes'][number])[] {
  const p = getProject()
  return selectedIds().flatMap(
    (id) => p.modules.find((m) => m.id === id) ?? p.notes.find((n) => n.id === id) ?? []
  )
}

export function isLocked(id: Id): boolean {
  const p = getProject()
  return !!(p.modules.find((m) => m.id === id) ?? p.notes.find((n) => n.id === id))?.locked
}

export function hasCanvasSelection(): boolean {
  return selectedCanvasItems().length > 0
}

/** True when every selected module / note is locked. */
export function selectionLocked(): boolean {
  const items = selectedCanvasItems()
  return items.length > 0 && items.every((e) => e.locked)
}

/** Lock the selected modules and notes, or unlock them when all are locked. */
export function toggleLockSelection(): void {
  const items = selectedCanvasItems()
  if (!items.length) return
  const lock = !items.every((e) => e.locked)
  setLocked(
    items.map((e) => e.id),
    lock
  )
  setStatus('info', `${lock ? 'Locked' : 'Unlocked'} ${items.length} item${items.length > 1 ? 's' : ''}`)
}

// Arrangement

/** Selected modules and notes with their absolute rects. */
function selectedRects(): Map<Id, Rect> {
  const p = getProject()
  const rects = new Map<Id, Rect>()
  for (const id of selectedIds()) {
    if (p.modules.some((m) => m.id === id)) rects.set(id, absoluteRect(p, id))
    const n = p.notes.find((n) => n.id === id)
    if (n) rects.set(id, { ...n.layout })
  }
  return rects
}

/** Apply absolute rects to modules (converted to parent-relative) and notes. */
function applyAbsolute(rects: Map<Id, Rect>): void {
  const p = getProject()
  const layouts = new Map<Id, Rect>()
  for (const [id, r] of rects) {
    // Locked items stay put: they only serve as references.
    if (isLocked(id)) continue
    const m = p.modules.find((m) => m.id === id)
    const origin = m?.parentId ? absolutePosition(p, m.parentId) : { x: 0, y: 0 }
    layouts.set(id, { ...r, x: Math.round(r.x - origin.x), y: Math.round(r.y - origin.y) })
  }
  setLayouts(layouts)
}

export function alignSelection(mode: AlignMode): void {
  const rects = selectedRects()
  if (rects.size > 1) applyAbsolute(align(rects, mode))
}

export function distributeSelection(axis: 'h' | 'v'): void {
  const rects = selectedRects()
  if (rects.size > 2) applyAbsolute(distribute(rects, axis))
}

export function sameSizeSelection(dim: 'width' | 'height' | 'both'): void {
  const rects = selectedRects()
  if (rects.size > 1) applyAbsolute(sameSize(rects, dim))
}

export function nudgeSelection(dx: number, dy: number): void {
  const p = getProject()
  const layouts = new Map<Id, Partial<Rect>>()
  for (const id of selectedIds()) {
    const e = p.modules.find((m) => m.id === id) ?? p.notes.find((n) => n.id === id)
    if (e && !e.locked) layouts.set(id, { x: e.layout.x + dx, y: e.layout.y + dy })
    const im = findImported(p, id)?.module
    if (im) layouts.set(id, { x: im.position.x + dx, y: im.position.y + dy })
  }
  if (layouts.size) setLayouts(layouts)
}

/** Group sibling modules into a new parent module. */
export function groupSelection(): void {
  const p = getProject()
  const mods = selectedIds().flatMap((id) => p.modules.find((m) => m.id === id) ?? [])
  if (!mods.length) return
  const parentId = mods[0]!.parentId
  if (mods.some((m) => m.parentId !== parentId))
    return showDialog('Cannot group', ['Only modules with the same parent can be grouped.'])
  const box = boundsOf(mods.map((m) => m.layout))
  const groupId = newId()
  const top = contentTop(p.orientation) + LAYOUT_PAD / 2
  update((d) => {
    const before = binarySnapshot(d)
    d.modules.push({
      id: groupId,
      name: uniqueName(
        'Group',
        childModules(d, parentId).map((m) => m.name)
      ),
      description: '',
      parentId,
      metadata: {},
      attributes: [],
      methods: [],
      ports: [],
      layout: {
        x: box.x - LAYOUT_PAD,
        y: box.y - top,
        width: box.width + 2 * LAYOUT_PAD,
        height: box.height + top + contentBottom(p.orientation)
      }
    })
    for (const m of d.modules) {
      if (!mods.some((x) => x.id === m.id)) continue
      m.parentId = groupId
      m.name = uniqueName(
        m.name,
        d.modules.filter((s) => s.parentId === groupId && s.id !== m.id).map((s) => s.name)
      )
      m.layout.x += LAYOUT_PAD - box.x
      m.layout.y += top - box.y
    }
    // Parents must precede children for the canvas.
    const moved = new Set(mods.flatMap((m) => [...subtreeIds(d, m.id)]))
    d.modules = [...d.modules.filter((o) => !moved.has(o.id)), ...d.modules.filter((o) => moved.has(o.id))]
    growAncestors(d, groupId)
    settleBinaries(d, before)
  })
  select({ kind: 'module', id: groupId })
}

let arranging = false

/**
 * Arrange with ELK: the selected container's content, the focused view's root, or everything.
 * A new orientation moves the ports (top / bottom or left / right) and re-arranges everything.
 */
export async function arrangeLayout(
  scope: 'auto' | 'all' = 'auto',
  orientation?: Orientation
): Promise<void> {
  if (arranging) return
  const p = getProject()
  const target = orientation ?? p.orientation
  const sel = activeDoc().selection
  let scopeId: Id | null = viewParent()
  if (scope === 'auto' && sel?.kind === 'module' && childModules(p, sel.id).length) scopeId = sel.id
  if (scope === 'all' || target !== p.orientation) scopeId = null
  arranging = true
  try {
    const arranged = await arrangeProject(p, scopeId, arrangeOptions(target))
    // Edits made meanwhile win.
    if (getProject() !== p) return
    update((d) => {
      d.orientation = arranged.orientation
      for (const m of d.modules) {
        const r = arranged.modules.find((x) => x.id === m.id)?.layout
        // Locked modules keep their place; their size still follows their content.
        if (r) m.layout = m.locked ? { ...r, x: m.layout.x, y: m.layout.y } : { ...r }
      }
      for (const m of d.dependencies.flatMap((x) => x.modules)) {
        const pos = findImported(arranged, m.id)?.module.position
        if (pos) m.position = { ...pos }
      }
      // Hand-set bends do not fit the new layout; attachments do not fit a new orientation.
      const moved = scopeId ? subtreeIds(p, scopeId) : null
      for (const l of d.links) {
        if (!l.route || (moved && !moved.has(l.from.moduleId) && !moved.has(l.to.moduleId))) continue
        if (target !== p.orientation) delete l.route
        else if (l.route.from || l.route.to) l.route.points = []
        else delete l.route
      }
    })
    setStatus('info', `Arranged ${scopeId ? modulePath(p, scopeId) : 'all modules'} ${target}ly`)
    // After React Flow has measured the new sizes.
    setTimeout(() => activeCanvas()?.fit(), 120)
  } catch (e) {
    showDialog('Arrange failed', [String(e)])
  } finally {
    arranging = false
  }
}

// Views

/** Open the content of the selected module in its own view tab. */
export function openModuleView(moduleId?: Id, split = false): void {
  const p = getProject()
  const sel = activeDoc().selection
  const id = moduleId ?? (sel?.kind === 'module' ? sel.id : null)
  if (!id) return
  const existing = p.views.find((v) => v.rootModuleId === id && !v.hidden.length)
  const viewId = existing?.id ?? addView(p.modules.find((m) => m.id === id)?.name ?? 'View', id)
  openView(viewId, { split })
}

export function newView(): void {
  openView(addView('View', null))
}

/** Hide the selected modules in the focused view (a stored copy of the global view is made first). */
export function hideSelection(): void {
  const p = getProject()
  const ids = selectedIds().filter((id) => p.modules.some((m) => m.id === id))
  if (!ids.length) return
  let viewId = activeDoc().activeViewId
  if (viewId === GLOBAL_VIEW) {
    viewId = addView('Filtered', null)
    openView(viewId)
  }
  setHidden(viewId, ids, true)
  select(null)
}

export function showAllInView(): void {
  const p = getProject()
  const view = findView(p, activeDoc().activeViewId)
  if (view.hidden.length) setHidden(view.id, view.hidden, false)
}

export async function exportImage(format: 'png' | 'svg'): Promise<void> {
  const canvas = activeCanvas()
  if (!canvas) return showDialog('Nothing to export', ['Open a diagram view first.'])
  await canvas.exportImage(format)
}
