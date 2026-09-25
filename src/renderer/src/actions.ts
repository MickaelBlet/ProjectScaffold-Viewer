// Editing actions on the active document, shared by commands, menus and panels.
import { align, distribute, sameSize, type AlignMode } from '@/model/align'
import { arrange as arrangeProject, type ArrangeOptions } from '@/model/autoLayout'
import { copyItems, parseClip, pasteClip, type Clip } from '@/model/clipboard'
import {
  absolutePosition,
  absoluteRect,
  boundsOf,
  childModules,
  defaultLayout,
  findView,
  LAYOUT_PAD,
  leafHeight,
  modulePath,
  newId,
  subtreeIds,
  uniqueName
} from '@/model/project'
import type { ProblemTarget } from '@/model/validate'
import { GLOBAL_VIEW, type Id, type Project, type Rect } from '@/model/types'
import { activeDoc, patchDoc } from '@/store/documents'
import {
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
  setHidden,
  setLayouts,
  update
} from '@/store/project'
import { select, setStatus, showDialog, useUiStore, type Selection } from '@/store/ui'
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
  select(target)
  if (target.kind === 'type' || target.kind === 'interface') return showTool('inspector', false)
  const p = getProject()
  const moduleId = target.kind === 'link' ? p.links.find((l) => l.id === target.id)?.from.moduleId : target.id
  if (!moduleId) return
  // Show the module in a view that contains it.
  const view = findView(p, activeDoc().activeViewId)
  if (view.rootModuleId && !subtreeIds(p, view.rootModuleId).has(moduleId)) openView(GLOBAL_VIEW)
  if (view.hidden.length) {
    const hiddenAncestors = view.hidden.filter((h) => subtreeIds(p, h).has(moduleId))
    if (hiddenAncestors.length) setHidden(view.id, hiddenAncestors, false)
  }
  requestAnimationFrame(() => activeCanvas()?.reveal(moduleId))
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
  const canvasIds = ids.filter((id) => p.modules.some((m) => m.id === id) || p.notes.some((n) => n.id === id))
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
  const size = defaultLayout(0, 0)
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

export function startRename(): void {
  const sel = activeDoc().selection
  if (sel?.kind === 'module') useUiStore.setState({ renaming: sel.id })
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
    const r = p.modules.find((m) => m.id === id)?.layout ?? p.notes.find((n) => n.id === id)?.layout
    if (r) layouts.set(id, { x: r.x + dx, y: r.y + dy })
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
  const top = leafHeight(0) + LAYOUT_PAD / 2
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
        height: box.height + top + LAYOUT_PAD
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

/** Arrange with ELK: the selected container's content, the focused view's root, or everything. */
export async function arrangeLayout(scope: 'auto' | 'all' = 'auto', options?: ArrangeOptions): Promise<void> {
  if (arranging) return
  const p = getProject()
  const sel = activeDoc().selection
  let scopeId: Id | null = viewParent()
  if (scope === 'auto' && sel?.kind === 'module' && childModules(p, sel.id).length) scopeId = sel.id
  if (scope === 'all') scopeId = null
  arranging = true
  try {
    const arranged = await arrangeProject(p, scopeId, options)
    // Edits made meanwhile win.
    if (getProject() !== p) return
    update((d) => {
      for (const m of d.modules) {
        const r = arranged.modules.find((x) => x.id === m.id)?.layout
        if (r) m.layout = { ...r }
      }
    })
    setStatus('info', `Arranged ${scopeId ? modulePath(p, scopeId) : 'all modules'}`)
    requestAnimationFrame(() => activeCanvas()?.fit())
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
