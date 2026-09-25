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
}

interface DocsState {
  docs: DocState[]
  activeId: Id
}

export function createDoc(project: Project = emptyProject(), filePath: string | null = null): DocState {
  const id = newId()
  const store = createProjectStore(project)
  // Undo, delete...: the selection drops entities that no longer exist.
  store.subscribe(({ project: p }) => {
    const doc = findDoc(id)
    if (!doc) return
    const exists = (x: Id): boolean =>
      p.modules.some((m) => m.id === x) ||
      p.notes.some((n) => n.id === x) ||
      p.types.some((t) => t.id === x) ||
      p.interfaces.some((i) => i.id === x) ||
      p.links.some((l) => l.id === x)
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
    viewEpoch: 1
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

export function patchDoc(
  patch: Partial<DocState> | ((d: DocState) => Partial<DocState>),
  id: Id = useDocs.getState().activeId
): void {
  useDocs.setState((s) => ({
    docs: s.docs.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d))
  }))
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
