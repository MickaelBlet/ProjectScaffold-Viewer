// Open documents (tabs). Each one has its own project store, undo history and editor state.
import { create } from 'zustand'
import { emptyProject, newId } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Project } from '@/model/types'
import { createProjectStore, type ProjectStore } from './projectStore'

export type Selection =
  | { kind: 'project' }
  | { kind: 'module'; id: Id }
  | { kind: 'link'; id: Id }
  | { kind: 'type'; id: Id }
  | { kind: 'interface'; id: Id }
  | { kind: 'note'; id: Id }
  | { kind: 'imported'; id: Id }
  | null

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface DocState {
  id: Id
  store: ProjectStore
  filePath: string | null
  /** Project as last saved/loaded; the document is dirty when it differs. */
  savedProject: Project | null
  /** Entity shown in the inspector. */
  selection: Selection
  /** Modules and notes selected on the canvas. */
  selectedIds: Id[]
  /** View of the focused canvas. */
  activeViewId: Id
  viewports: Record<Id, Viewport>
  /** Serialized editor area (open views and editor tabs). */
  layout: unknown
  /** Bumped to re-fit the canvases (after loading). */
  viewEpoch: number
  /** Past inspector selections (Alt+Left / Alt+Right), oldest first. */
  selectionHistory: NonNullable<Selection>[]
  /** Position of the current selection in `selectionHistory`. */
  historyIndex: number
}

interface DocsState {
  docs: DocState[]
  activeId: Id
}

/** Called after any change to a document's project (see sync.ts). */
export const projectListeners = new Set<(docId: Id, prev: Project, next: Project) => void>()

export function createDoc(project: Project = emptyProject(), filePath: string | null = null): DocState {
  const id = newId()
  const store = createProjectStore(project)
  // Undo, delete...: the selection drops entities that no longer exist.
  store.subscribe((state, prevState) => {
    if (state.project !== prevState.project)
      for (const listener of projectListeners) listener(id, prevState.project, state.project)
  })
  store.subscribe(({ project: p }) => {
    const doc = findDoc(id)
    if (!doc) return
    const exists = (x: Id): boolean =>
      p.modules.some((m) => m.id === x) ||
      p.notes.some((n) => n.id === x) ||
      p.types.some((t) => t.id === x) ||
      p.interfaces.some((i) => i.id === x) ||
      p.links.some((l) => l.id === x) ||
      p.imports.some((i) => i.modules.some((m) => m.id === x))
    const selectedIds = doc.selectedIds.filter(exists)
    const selection =
      doc.selection && 'id' in doc.selection && !exists(doc.selection.id) ? null : doc.selection
    if (selectedIds.length !== doc.selectedIds.length || selection !== doc.selection)
      patchDoc({ selectedIds, selection }, id)
  })
  return {
    id,
    store,
    filePath,
    savedProject: project,
    selection: null,
    selectedIds: [],
    activeViewId: GLOBAL_VIEW,
    viewports: {},
    layout: null,
    viewEpoch: 1,
    selectionHistory: [],
    historyIndex: -1
  }
}

const initial = createDoc()
export const useDocs = create<DocsState>(() => ({ docs: [initial], activeId: initial.id }))

export function activeDoc(s: DocsState = useDocs.getState()): DocState {
  return s.docs.find((d) => d.id === s.activeId) ?? s.docs[0]!
}

/** Select from the active document. The selector must return a stable value. */
export function useDoc<T>(selector: (d: DocState) => T): T {
  return useDocs((s) => selector(activeDoc(s)))
}

export function findDoc(id: Id): DocState | undefined {
  return useDocs.getState().docs.find((d) => d.id === id)
}

const HISTORY_MAX = 100
let travelling = false

const sameSelection = (a: Selection, b: Selection): boolean =>
  a?.kind === b?.kind && (a && 'id' in a ? a.id : null) === (b && 'id' in b ? b.id : null)

/** Record a single selection (not a clear or a multi-selection being built) in the history. */
function recordSelection(d: DocState): DocState {
  const s = d.selection
  if (travelling || !s || d.selectedIds.length > 1) return d
  if (sameSelection(s, d.selectionHistory[d.historyIndex] ?? null)) return d
  const selectionHistory = [...d.selectionHistory.slice(0, d.historyIndex + 1), s].slice(-HISTORY_MAX)
  return { ...d, selectionHistory, historyIndex: selectionHistory.length - 1 }
}

export function patchDoc(
  patch: Partial<DocState> | ((d: DocState) => Partial<DocState>),
  id: Id = useDocs.getState().activeId
): void {
  useDocs.setState((s) => ({
    docs: s.docs.map((d) => {
      if (d.id !== id) return d
      const p = typeof patch === 'function' ? patch(d) : patch
      const next = { ...d, ...p }
      return 'selection' in p && !sameSelection(p.selection ?? null, d.selection)
        ? recordSelection(next)
        : next
    })
  }))
}

/**
 * Step `delta` entries through the selection history of the active document, skipping entities
 * that no longer exist. `apply` shows the entry; it does not record a new one.
 */
export function travelSelection(
  delta: -1 | 1,
  exists: (s: NonNullable<Selection>) => boolean,
  apply: (s: NonNullable<Selection>) => void
): boolean {
  const d = activeDoc()
  // Back from a cleared or unrecorded selection returns to the last recorded one first.
  const away = !sameSelection(d.selection, d.selectionHistory[d.historyIndex] ?? null)
  let i = d.historyIndex + (away && delta < 0 ? 0 : delta)
  while (i >= 0 && i < d.selectionHistory.length && !exists(d.selectionHistory[i]!)) i += delta
  const target = d.selectionHistory[i]
  if (!target) return false
  patchDoc({ historyIndex: i })
  travelling = true
  try {
    apply(target)
  } finally {
    travelling = false
  }
  return true
}

export function isDocDirty(d: DocState): boolean {
  return d.savedProject !== d.store.getState().project
}

/** Untitled, unmodified and empty: replaced rather than kept when a file is opened. */
export function isPristine(d: DocState): boolean {
  const p = d.store.getState().project
  return !d.filePath && !isDocDirty(d) && !p.modules.length && !p.types.length && !p.interfaces.length
}

export function addDoc(doc: DocState, activate = true): void {
  useDocs.setState((s) => ({ docs: [...s.docs, doc], activeId: activate ? doc.id : s.activeId }))
}

/** Replace a document in place (same tab position). */
export function replaceDoc(id: Id, doc: DocState): void {
  useDocs.setState((s) => ({
    docs: s.docs.map((d) => (d.id === id ? doc : d)),
    activeId: s.activeId === id ? doc.id : s.activeId
  }))
}

export function removeDoc(id: Id): void {
  useDocs.setState((s) => {
    const i = s.docs.findIndex((d) => d.id === id)
    if (i < 0) return s
    let docs = s.docs.filter((d) => d.id !== id)
    if (!docs.length) docs = [createDoc()]
    const activeId = s.activeId === id ? docs[Math.min(i, docs.length - 1)]!.id : s.activeId
    return { docs, activeId }
  })
}

export function activateDoc(id: Id): void {
  if (findDoc(id)) useDocs.setState({ activeId: id })
}

/** Activate the document `delta` tabs away (wrapping). */
export function cycleDoc(delta: number): void {
  const { docs, activeId } = useDocs.getState()
  const i = docs.findIndex((d) => d.id === activeId)
  const next = docs[(i + delta + docs.length) % docs.length]
  if (next) activateDoc(next.id)
}

export function moveDoc(id: Id, toIndex: number): void {
  useDocs.setState((s) => {
    const doc = s.docs.find((d) => d.id === id)
    if (!doc) return s
    const docs = s.docs.filter((d) => d.id !== id)
    docs.splice(Math.max(0, Math.min(toIndex, docs.length)), 0, doc)
    return { docs }
  })
}
