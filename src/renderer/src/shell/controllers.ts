// Handles on the mounted UI (dock layouts and canvases), for commands that run outside React.
import type { DockviewApi } from 'dockview-react'
import { findView } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Rect } from '@/model/types'
import { activeDoc, patchDoc } from '@/store/documents'
import { getProject } from '@/store/project'

export interface CanvasController {
  viewId: Id
  /** Fit the given modules / notes, or everything when empty. */
  fit(ids?: Id[]): void
  /** Flow position of the middle of the visible area. */
  center(): { x: number; y: number }
  /** Pan to a module or note without changing the zoom much. */
  reveal(id: Id): void
  zoomBy(factor: number): void
  zoomTo(zoom: number): void
  exportImage(format: 'png' | 'svg'): Promise<void>
  /** Absolute flow rect of a node as drawn. */
  nodeRect(id: Id): Rect | null
}

const canvases = new Map<Id, CanvasController>()

export function registerCanvas(c: CanvasController): () => void {
  canvases.set(c.viewId, c)
  return () => {
    if (canvases.get(c.viewId) === c) canvases.delete(c.viewId)
  }
}

/** Canvas of the focused view, else any open canvas. */
export function activeCanvas(): CanvasController | undefined {
  return canvases.get(activeDoc().activeViewId) ?? canvases.values().next().value
}

// Dock layouts

export type ToolId = 'explorer' | 'outline' | 'inspector' | 'problems' | 'search' | 'settings'

export const TOOL_TITLES: Record<ToolId, string> = {
  explorer: 'Explorer',
  outline: 'Outline',
  inspector: 'Inspector',
  problems: 'Problems',
  search: 'Search',
  settings: 'Settings'
}

let outer: DockviewApi | null = null
let editor: DockviewApi | null = null

export const setOuterApi = (api: DockviewApi | null): void => void (outer = api)
export const setEditorApi = (api: DockviewApi | null): void => void (editor = api)
export const editorApi = (): DockviewApi | null => editor

export const EDITOR_AREA = 'editor-area'
const LAYOUT_KEY = 'project-scaffold:layout'

/** Tool panels around the editor area. */
export function buildDefaultLayout(api: DockviewApi): void {
  api.clear()
  api.addPanel({ id: EDITOR_AREA, component: 'editorArea', title: 'Editor' })
  api.addPanel({
    id: 'explorer',
    component: 'explorer',
    title: TOOL_TITLES.explorer,
    initialWidth: 250,
    position: { referencePanel: EDITOR_AREA, direction: 'left' }
  })
  api.addPanel({
    id: 'outline',
    component: 'outline',
    title: TOOL_TITLES.outline,
    position: { referencePanel: 'explorer', direction: 'below' }
  })
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: TOOL_TITLES.inspector,
    initialWidth: 380,
    position: { referencePanel: EDITOR_AREA, direction: 'right' }
  })
  api.addPanel({
    id: 'problems',
    component: 'problems',
    title: TOOL_TITLES.problems,
    initialHeight: 170,
    position: { referencePanel: EDITOR_AREA, direction: 'below' }
  })
  api.addPanel({
    id: 'search',
    component: 'search',
    title: TOOL_TITLES.search,
    inactive: true,
    position: { referencePanel: 'problems', direction: 'within' }
  })
  api.getPanel('explorer')?.api.setActive()
  lockEditorArea(api)
}

/** The editor area has no tab strip and accepts no panels (its documents have their own tabs). */
export function lockEditorArea(api: DockviewApi): void {
  const group = api.getPanel(EDITOR_AREA)?.group
  if (!group) return
  group.header.hidden = true
  group.locked = 'no-drop-target'
}

export function saveOuterLayout(): void {
  if (!outer) return
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(outer.toJSON()))
  } catch {
    // Storage unavailable: the layout lasts for the session.
  }
}

export function loadOuterLayout(api: DockviewApi): void {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) {
      api.fromJSON(JSON.parse(saved))
      if (api.getPanel(EDITOR_AREA)) return lockEditorArea(api)
    }
  } catch {
    // Unreadable or incompatible layout: fall back to the default one.
  }
  buildDefaultLayout(api)
}

export function resetLayout(): void {
  if (outer) buildDefaultLayout(outer)
}

/** Show a tool panel, re-adding it where it belongs when it was closed. */
export function showTool(id: ToolId, focus = true): void {
  if (!outer) return
  const existing = outer.getPanel(id)
  if (existing) {
    existing.api.setActive()
    if (focus) focusPanel(id)
    return
  }
  const beside: Record<ToolId, [string, 'left' | 'right' | 'below' | 'within']> = {
    explorer: [EDITOR_AREA, 'left'],
    outline: ['explorer', 'below'],
    inspector: [EDITOR_AREA, 'right'],
    problems: [EDITOR_AREA, 'below'],
    search: ['problems', 'within'],
    settings: ['inspector', 'within']
  }
  let [ref, direction] = beside[id]
  if (!outer.getPanel(ref))
    [ref, direction] = [EDITOR_AREA, id === 'problems' || id === 'search' ? 'below' : 'right']
  outer.addPanel({
    id,
    component: id,
    title: TOOL_TITLES[id],
    position: { referencePanel: ref, direction: direction === 'within' ? 'within' : direction }
  })
  if (focus) focusPanel(id)
}

export function toggleTool(id: ToolId): void {
  const panel = outer?.getPanel(id)
  if (panel) panel.api.close()
  else showTool(id)
}

export const isToolOpen = (id: ToolId): boolean => !!outer?.getPanel(id)

function focusPanel(id: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-panel="${id}"] [data-autofocus]`)
    el?.focus()
  })
}

// Editor area: views and editors of the active document

export type EditorKind = 'type' | 'interface' | 'module' | 'link'

export function viewPanelId(viewId: Id): string {
  return `view:${viewId}`
}

export function openView(viewId: Id = GLOBAL_VIEW, options: { split?: boolean } = {}): void {
  patchDoc({ activeViewId: viewId })
  if (!editor) return
  const id = viewPanelId(viewId)
  const existing = editor.getPanel(id)
  if (existing) return existing.api.setActive()
  const active = editor.activePanel
  editor.addPanel({
    id,
    component: 'canvas',
    tabComponent: 'view',
    title: findView(getProject(), viewId).name,
    params: { viewId },
    position: active
      ? { referencePanel: active.id, direction: options.split ? 'right' : 'within' }
      : undefined
  })
}

export function closeView(viewId: Id): void {
  editor?.getPanel(viewPanelId(viewId))?.api.close()
}

/** Open an entity editor as a tab of the editor area. */
export function openEditor(kind: EditorKind, id: Id, options: { split?: boolean } = {}): void {
  if (!editor) return
  const panelId = `${kind}:${id}`
  const existing = editor.getPanel(panelId)
  if (existing) return existing.api.setActive()
  const active = editor.activePanel
  editor.addPanel({
    id: panelId,
    component: 'entity',
    tabComponent: 'entity',
    title: kind,
    params: { kind, id },
    position: active
      ? { referencePanel: active.id, direction: options.split ? 'right' : 'within' }
      : undefined
  })
}
