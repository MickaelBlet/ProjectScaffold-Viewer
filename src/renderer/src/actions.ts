// Editing actions on the active document, shared by commands, menus and panels.
import { align, distribute, sameSize, type AlignMode } from '@/model/align'
import { arrange as arrangeProject, arrangeOptions } from '@/model/autoLayout'
import { copyItems, copyProject, parseClip, pasteClip, type Clip } from '@/model/clipboard'
import {
  absolutePosition,
  absoluteRect,
  boundsOf,
  childModules,
  defaultSize,
  findImported,
  findView,
  isImportedId,
  LAYOUT_PAD,
  contentBottom,
  contentTop,
  modulePath,
  newId,
  subtreeIds,
  uniqueName
} from '@/model/project'
import type { ProblemTarget } from '@/model/validate'
import { GLOBAL_VIEW, type Id, type Orientation, type Project, type Rect } from '@/model/types'
import { activeDoc, activateDoc, patchDoc, travelSelection as travel, useDocs } from '@/store/documents'
import {
  addImportedModule,
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
  growAncestors,
  refreshImportFrom,
  setHidden,
  setLayouts,
  setLocked,
  update
} from '@/store/project'
import { quickPick, select, setStatus, showDialog, useUiStore, type Selection } from '@/store/ui'
import { fileName } from '@/fileOps'
import { formatFromPath, LoadError, loadText } from '@/model/serialize'
import { activeCanvas, openView, showTool } from '@/shell/controllers'

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

/** Select an entity and bring it into view. */
export function navigate(target: ProblemTarget): void {
  if (target.kind === 'project') return select({ kind: 'project' })
  select(target.kind === 'module' && isImportedId(target.id) ? { kind: 'imported', id: target.id } : target)
  if (target.kind === 'type' || target.kind === 'interface') return showTool('inspector', false)
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
  revealWhenDrawn(ids)
}

/** Select a note and show it (notes are drawn in the global view only). */
export function navigateToNote(id: Id): void {
  select({ kind: 'note', id })
  if (findView(getProject(), activeDoc().activeViewId).rootModuleId) openView(GLOBAL_VIEW)
  revealWhenDrawn([id])
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
function revealWhenDrawn(ids: Id[], tries = 10): void {
  requestAnimationFrame(() => {
    const canvas = activeCanvas()
    if (canvas && ids.some((id) => canvas.nodeRect(id))) return canvas.reveal(ids)
    if (tries > 0) revealWhenDrawn(ids, tries - 1)
    else canvas?.reveal(ids)
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
    if (p.interfaces.some((i) => i.id === id)) deleteInterface(id)
    const type = p.types.find((t) => t.id === id)
    if (type) {
      const usages = deleteType(id)
      if (usages.length) blocked.push(`${type.name}: used by ${usages.join(', ')}`)
    }
  }
  if (blocked.length) showDialog('Some types were not deleted', blocked)
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

// Links to other projects

/** Another project to link to: an open document, or a file read without opening it. */
interface OtherProject {
  project: Project
  file: string
}

function otherProjects(
  needFile = true
): { label: string; detail: string; get: () => Promise<OtherProject | null> }[] {
  const { docs, activeId } = useDocs.getState()
  const open = docs
    .filter((d) => d.id !== activeId)
    .map((d) => {
      const project = d.store.getState().project
      return {
        label: d.filePath ? fileName(d.filePath) : `${project.name} (unsaved)`,
        detail: `open · ${project.modules.length} modules`,
        get: async (): Promise<OtherProject | null> => {
          if (d.filePath || !needFile)
            return { project, file: d.filePath ? fileName(d.filePath) : project.name }
          showDialog('Save the other project first', [
            `"${project.name}" has no file yet: links to it need its file name.`
          ])
          return null
        }
      }
    })
  return [
    ...open,
    {
      label: 'Open file…',
      detail: 'read a project file',
      get: async (): Promise<OtherProject | null> => {
        const f = await window.api.openFile()
        if (!f) return null
        try {
          return { project: loadText(f.content, formatFromPath(f.path)), file: fileName(f.path) }
        } catch (e) {
          showDialog(`Cannot read ${f.path}`, e instanceof LoadError ? e.problems : [String(e)])
          return null
        }
      }
    }
  ]
}

/**
 * Pick another project, then one of its modules: it is placed on the canvas (global view) and its
 * ports can be linked to. Interfaces it uses that this project lacks are copied (matched by name).
 */
export function linkOtherProject(pos?: { x: number; y: number }): void {
  const at = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
  quickPick(
    'Project to link to',
    otherProjects().map((o, i) => ({
      key: String(i),
      label: o.label,
      detail: o.detail,
      kind: 'P',
      run: () =>
        void o.get().then((other) => {
          if (!other) return
          const src = other.project
          if (!src.modules.length) return setStatus('error', `${other.file} has no modules`)
          quickPick(
            `Module of ${other.file} to link to`,
            src.modules.map((m) => ({
              key: m.id,
              label: modulePath(src, m.id),
              detail: m.ports.map((pt) => `${pt.role} ${pt.name}`).join(', ') || 'no ports',
              kind: 'M',
              run: () => {
                if (activeDoc().activeViewId !== GLOBAL_VIEW) openView(GLOBAL_VIEW)
                const id = addImportedModule(src, other.file, m.id, at)
                if (id) select({ kind: 'imported', id })
              }
            }))
          )
        })
    }))
  )
}

/** Where imported content goes: the selected module, else the focused view's module. */
function importParent(): Id | null {
  const sel = activeDoc().selection
  return sel?.kind === 'module' ? sel.id : viewParent()
}

/**
 * Pick another project and copy its content into `parent` (a module, or the top level): its
 * modules with their links, its notes (top level only), and the types and interfaces this project
 * lacks (the others are matched by name). Nothing ties the copy to that project afterwards.
 */
export function importProjectContent(
  parent: Id | null = importParent(),
  pos?: { x: number; y: number }
): void {
  quickPick(
    'Project to import',
    otherProjects(false).map((o, i) => ({
      key: String(i),
      label: o.label,
      detail: o.detail,
      kind: 'P',
      run: () =>
        void o.get().then((other) => {
          if (!other) return
          const p = getProject()
          const clip = copyProject(other.project, p, !parent)
          if (!clip) return setStatus('error', `${other.file} is empty`)
          let at = pos ?? activeCanvas()?.center() ?? { x: 80, y: 80 }
          if (!pos && parent) {
            // Below the module's current content, like a new submodule.
            const origin = absolutePosition(p, parent)
            const top = contentTop(p.orientation) + LAYOUT_PAD
            const bottom = Math.max(
              top,
              ...childModules(p, parent).map((c) => c.layout.y + c.layout.height + LAYOUT_PAD)
            )
            at = { x: origin.x + LAYOUT_PAD, y: origin.y + bottom }
          }
          let pasted: Id[] = []
          update((d) => void (pasted = pasteClip(d, clip, { parent, at })))
          selectMany(pasted)
          const modules = Object.keys(clip.rootParents).length
          const defs = clip.types.length + clip.interfaces.length
          setStatus('info', `Imported ${modules} modules, ${defs} types and interfaces from ${other.file}`)
        })
    }))
  )
}

/** Open documents holding the project of an import (same file name). */
function importSource(file: string): Project | null {
  const doc = useDocs
    .getState()
    .docs.find((d) => d.id !== activeDoc().id && d.filePath && fileName(d.filePath) === fileName(file))
  return doc ? doc.store.getState().project : null
}

/** Read the ports of imported modules again from their projects, when these are open. */
export function refreshImports(importIds?: Id[]): void {
  const p = getProject()
  const lines: string[] = []
  let refreshed = 0
  for (const imp of p.imports) {
    if (importIds && !importIds.includes(imp.id)) continue
    const source = importSource(imp.file)
    if (!source) {
      lines.push(`${imp.name}: open ${imp.file} in a tab to refresh it`)
      continue
    }
    refreshed++
    const { missing, renamed } = refreshImportFrom(imp.id, source)
    for (const r of renamed) lines.push(`${imp.name}: ${r}`)
    for (const path of missing) lines.push(`${imp.name}: module '${path}' no longer exists in ${imp.file}`)
  }
  if (lines.length) showDialog(`Refreshed ${refreshed} linked project${refreshed === 1 ? '' : 's'}`, lines)
  else setStatus('info', `Refreshed ${refreshed} linked project${refreshed === 1 ? '' : 's'}`)
}

/** Show the project of an import in its tab when it is open. */
export function openImportSource(file: string): void {
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
    d.modules.push({
      id: groupId,
      name: uniqueName(
        'Group',
        childModules(d, parentId).map((m) => m.name)
      ),
      description: '',
      parentId,
      metadata: {},
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
      for (const m of d.imports.flatMap((i) => i.modules)) {
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
  const id =
    moduleId ?? (activeDoc().selection?.kind === 'module' ? (activeDoc().selection as { id: Id }).id : null)
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
