// Handles on the mounted UI (dock layouts and canvases), for commands that run outside React.
import {
  Orientation,
  type Direction,
  type DockviewApi,
  type IDockviewGroupPanel,
  type SerializedDockview
} from 'dockview-react'
import { findView, isolatedModuleId, isolatedViewId, modulePath } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Project, type Rect } from '@/model/types'
import { activeDoc, patchDoc } from '@/store/documents'
import { getProject } from '@/store/project'
import { storage } from '@/storage'
import { useSettings } from '@/store/settings'
import { FULL_LAYOUT, IN_PANEL, INTEGRATED } from '@/host'
import { sendToDiagram } from '@/fileOps'
import { fileBaseName, type TextFileRef } from '@/store/textFiles'
import { targetPath } from '@/model/locate'
import { toFile } from '@/model/serialize'
import type { SidePanel, ViewRef } from '../../../../vscode/src/protocol'

export interface CanvasController {
  viewId: Id
  /** Fit the given modules / notes / links, or everything when empty. */
  fit(ids?: Id[]): void
  /** Flow position of the middle of the visible area. */
  center(): { x: number; y: number }
  /** Pan to modules / notes / links without changing the zoom much, zooming out if they do not fit. */
  reveal(ids: Id[]): void
  zoomBy(factor: number): void
  zoomTo(zoom: number): void
  exportImage(format: 'png' | 'svg'): Promise<void>
  /** Absolute flow rect of a module / note (or its stand-in) or a link as drawn. */
  rect(id: Id): Rect | null
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

export type ToolId =
  | 'explorer'
  | 'generation'
  | 'inspector'
  | 'problems'
  | 'output'
  | 'search'
  | 'settings'

export const TOOL_TITLES: Record<ToolId, string> = {
  explorer: 'Explorer',
  generation: 'Code generation',
  inspector: 'Inspector',
  problems: 'Problems',
  output: 'Output',
  search: 'Search',
  settings: 'Settings'
}

/** Width of the side tools, height of the bottom ones, when first opened. */
const TOOL_SIZES: Record<ToolId, number> = {
  explorer: 300,
  generation: 300,
  inspector: 440,
  settings: 440,
  problems: 170,
  output: 170,
  search: 300
}

let outer: DockviewApi | null = null
let editor: DockviewApi | null = null

export const setOuterApi = (api: DockviewApi | null): void => void (outer = api)
export const setEditorApi = (api: DockviewApi | null): void => void (editor = api)
export const editorApi = (): DockviewApi | null => editor

export const EDITOR_AREA = 'editor-area'
/** VS Code diagrams (full editor and preview alike) have layouts of their own: the side tools are in
 *  its side bar, but in the full layout. */
const LAYOUT_KEY = FULL_LAYOUT
  ? 'project-scaffold:layout:vscode-full'
  : INTEGRATED
    ? 'project-scaffold:layout:vscode'
    : 'project-scaffold:layout'

/** Tools of the VS Code side bar (see vscode/package.json). */
const SIDE_TOOLS = new Set<ToolId>(['explorer', 'generation'])
const inSideBar = (id: ToolId): id is SidePanel => INTEGRATED && SIDE_TOOLS.has(id)

/**
 * Tool panels around the editor area. In VS Code: the Inspector and Settings (the side tools are in its
 * side bar), all of them in the full layout.
 */
export function buildDefaultLayout(api: DockviewApi): void {
  api.clear()
  api.addPanel({ id: EDITOR_AREA, component: 'editorArea', title: 'Editor' })
  if (INTEGRATED) {
    api.addPanel({
      id: 'inspector',
      component: 'inspector',
      title: TOOL_TITLES.inspector,
      initialWidth: TOOL_SIZES.inspector,
      position: { referencePanel: EDITOR_AREA, direction: 'right' }
    })
    api.addPanel({
      id: 'settings',
      component: 'settings',
      title: TOOL_TITLES.settings,
      inactive: true,
      position: { referencePanel: 'inspector', direction: 'within' }
    })
    return lockEditorArea(api)
  }
  api.addPanel({
    id: 'explorer',
    component: 'explorer',
    title: TOOL_TITLES.explorer,
    initialWidth: TOOL_SIZES.explorer,
    position: { referencePanel: EDITOR_AREA, direction: 'left' }
  })
  for (const id of ['generation', 'search'] as const)
    api.addPanel({
      id,
      component: id,
      title: TOOL_TITLES[id],
      inactive: true,
      position: { referencePanel: 'explorer', direction: 'within' }
    })
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: TOOL_TITLES.inspector,
    initialWidth: TOOL_SIZES.inspector,
    position: { referencePanel: EDITOR_AREA, direction: 'right' }
  })
  api.addPanel({
    id: 'settings',
    component: 'settings',
    title: TOOL_TITLES.settings,
    inactive: true,
    position: { referencePanel: 'inspector', direction: 'within' }
  })
  api.addPanel({
    id: 'problems',
    component: 'problems',
    title: TOOL_TITLES.problems,
    initialHeight: TOOL_SIZES.problems,
    position: { referencePanel: EDITOR_AREA, direction: 'below' }
  })
  api.addPanel({
    id: 'output',
    component: 'output',
    title: TOOL_TITLES.output,
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
  if (outer) storage.setItem(LAYOUT_KEY, JSON.stringify(outer.toJSON()))
}

export function loadOuterLayout(api: DockviewApi): void {
  try {
    const saved = storage.getItem(LAYOUT_KEY)
    const layout = saved && (JSON.parse(saved) as SerializedDockview)
    // A layout with panels no longer there (removed tools) is dropped for the default one.
    if (layout && Object.keys(layout.panels).every((id) => id === EDITOR_AREA || id in TOOL_TITLES)) {
      api.fromJSON(layout)
      // Tools now in the VS Code side bar (Code generation was docked before).
      if (INTEGRATED) for (const id of SIDE_TOOLS) api.getPanel(id)?.api.close()
      if (api.getPanel(EDITOR_AREA)) return lockEditorArea(api)
    }
  } catch {
    // Unreadable or incompatible layout: fall back to the default one.
  }
  buildDefaultLayout(api)
}

type GridNode = SerializedDockview['grid']['root']
type GroupState = Extract<GridNode['data'], { id: string }>

/** Dockview's default minimum group width and height. */
const MIN_GROUP_SIZE = 100

const leafIds = (node: GridNode): string[] =>
  node.type === 'leaf' ? [(node.data as GroupState).id] : (node.data as GridNode[]).flatMap(leafIds)

/** Children of the branch directly holding the group, with the branch orientation. */
function findParent(
  node: GridNode,
  orientation: Orientation,
  id: string
): { children: GridNode[]; orientation: Orientation } | null {
  if (node.type === 'leaf') return null
  const children = node.data as GridNode[]
  if (children.some((c) => c.type === 'leaf' && (c.data as GroupState).id === id))
    return { children, orientation }
  const inner = orientation === Orientation.HORIZONTAL ? Orientation.VERTICAL : Orientation.HORIZONTAL
  for (const c of children) {
    const found = findParent(c, inner, id)
    if (found) return found
  }
  return null
}

type Size = { width: number; height: number }

/** Size of each tool's group when last seen, to reopen it as it was. */
const lastToolSizes = new Map<ToolId, Size>()
/** Size asked by `showTool` for the group it is adding. */
let requestedSize: Partial<Size> | null = null

const isTool = (id: string): id is ToolId => id in TOOL_TITLES

/**
 * Dockview shares the space of an added or removed group equally between its siblings, which
 * resizes the side bars. Take it from / give it to the sibling holding the editor area instead
 * (else the previous one on removal), by pinning the other siblings to their former size for one
 * layout pass.
 */
export function keepSizes(api: DockviewApi): void {
  let before: { grid: SerializedDockview['grid']; editorGroup?: string; sizes: Map<string, Size> } | null =
    null
  api.onWillMutateLayout((e) => {
    before = null
    if (e.kind !== 'add' && e.kind !== 'remove') return
    const sizes = new Map(api.groups.map((g) => [g.id, { width: g.width, height: g.height }]))
    for (const p of api.panels) {
      const size = sizes.get(p.group.id)
      if (isTool(p.id) && size) lastToolSizes.set(p.id, size)
    }
    before = { grid: api.toJSON().grid, editorGroup: api.getPanel(EDITOR_AREA)?.group.id, sizes }
  })
  api.onDidMutateLayout(() => {
    const requested = requestedSize
    requestedSize = null
    if (!before) return
    const { grid, editorGroup, sizes } = before
    before = null
    const removed = leafIds(grid.root).filter((id) => !api.getGroup(id))
    const added = api.groups.filter((g) => !sizes.has(g.id))
    let found: { children: GridNode[]; orientation: Orientation } | null = null
    let changed: string | undefined
    if (removed.length === 1 && !added.length) {
      changed = removed[0]
      found = findParent(grid.root, grid.orientation, changed!)
      // With a single sibling left, dockview collapses the branch and keeps the sizes itself.
      if (found && found.children.length < 3) return
    } else if (added.length === 1 && !removed.length) {
      changed = added[0]!.id
      const now = api.toJSON().grid
      found = findParent(now.root, now.orientation, changed)
    }
    if (!found || !changed) return
    const index = found.children.findIndex((c) => leafIds(c).includes(changed))
    const rest = found.children.filter((_, i) => i !== index)
    let grower = editorGroup ? rest.findIndex((c) => leafIds(c).includes(editorGroup)) : -1
    // An added group splits its neighbour when away from the editor area.
    if (grower < 0 && !removed.length) return
    if (grower < 0) grower = Math.max(index - 1, 0)
    const axis = found.orientation === Orientation.HORIZONTAL ? 'width' : 'height'
    // A leaf, or the leaves of a cross branch, span the whole size of their sibling.
    const pins: [IDockviewGroupPanel, number][] = []
    for (const [i, c] of rest.entries()) {
      if (i === grower) continue
      const leaves = c.type === 'leaf' ? [c] : (c.data as GridNode[]).filter((n) => n.type === 'leaf')
      for (const leaf of leaves) {
        const id = (leaf.data as GroupState).id
        const group = api.getGroup(id)
        const size = sizes.get(id)?.[axis]
        if (group && size) pins.push([group, size])
      }
    }
    const group = api.getGroup(changed)
    const size = requested?.[axis]
    if (group && size) pins.push([group, size])
    const constrain = (group: IDockviewGroupPanel, min: number, max: number): void =>
      group.api.setConstraints(
        axis === 'width'
          ? { minimumWidth: min, maximumWidth: max }
          : { minimumHeight: min, maximumHeight: max }
      )
    for (const [group, size] of pins) constrain(group, size, size)
    for (const [group] of pins) constrain(group, MIN_GROUP_SIZE, Number.MAX_SAFE_INTEGER)
  })
}

export function resetLayout(): void {
  if (IN_PANEL) return sendToDiagram({ kind: 'command', id: 'window.resetLayout' })
  if (outer) buildDefaultLayout(outer)
}

type Place = [ref: string, direction: Direction] | [ref: null, direction: Exclude<Direction, 'within'>]

/** Where a closed tool goes back: beside the first open reference, else on an edge of the window. */
const TOOL_PLACES: Record<ToolId, Place[]> = {
  explorer: [
    ['generation', 'within'],
    ['search', 'within'],
    [null, 'left']
  ],
  generation: [
    ['explorer', 'within'],
    ['search', 'within'],
    [null, 'left']
  ],
  search: [
    ['explorer', 'within'],
    ['generation', 'within'],
    [null, 'left']
  ],
  inspector: [
    ['settings', 'within'],
    [null, 'right']
  ],
  settings: [
    ['inspector', 'within'],
    [null, 'right']
  ],
  problems: [
    ['output', 'within'],
    [EDITOR_AREA, 'below']
  ],
  output: [
    ['problems', 'within'],
    [EDITOR_AREA, 'below']
  ]
}

/** Show a tool panel, re-adding it where it belongs when it was closed. */
export function showTool(id: ToolId, focus = true): void {
  if (inSideBar(id)) return window.api.showPanel?.(id)
  // A VS Code side panel has no dock: the diagram shows the tool.
  if (IN_PANEL) return sendToDiagram({ kind: 'command', id: `window.${id}` })
  if (!outer) return
  const existing = outer.getPanel(id)
  if (existing) {
    existing.api.setActive()
    if (focus) focusPanel(id)
    return
  }
  const [ref, direction] = TOOL_PLACES[id].find(([ref]) => !ref || outer?.getPanel(ref)) ?? [null, 'right']
  // Split an open neighbour, else take back the former size beside the editor area.
  requestedSize = null
  if (!ref || ref === EDITOR_AREA) {
    const axis = direction === 'left' || direction === 'right' ? 'width' : 'height'
    requestedSize = { [axis]: lastToolSizes.get(id)?.[axis] ?? TOOL_SIZES[id] }
  }
  outer.addPanel({
    id,
    component: id,
    title: TOOL_TITLES[id],
    position: ref ? { referencePanel: ref, direction } : { direction },
    initialWidth: requestedSize?.width,
    initialHeight: requestedSize?.height
  })
  if (focus) focusPanel(id)
}

export function toggleTool(id: ToolId): void {
  if (inSideBar(id)) return window.api.showPanel?.(id)
  const panel = outer?.getPanel(id)
  if (panel) panel.api.close()
  else showTool(id)
}

/** After a selection on the canvas or in the Explorer: bring the Inspector to the front (setting). */
export function revealInspector(): void {
  if (IN_PANEL || !useSettings.getState().revealInspector) return
  showTool('inspector', false)
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

/** A view for another page of the document, where ids differ (see ViewRef). */
export function viewRef(p: Project, viewId: Id): ViewRef {
  const moduleId = isolatedModuleId(viewId)
  if (moduleId) return p.modules.some((m) => m.id === moduleId) ? { module: modulePath(p, moduleId) } : null
  return p.views.find((v) => v.id === viewId)?.name ?? null
}

/** Id of a view given by another page; undefined when it is not found. */
export function viewOfRef(p: Project, ref: ViewRef): Id | undefined {
  if (ref === null) return GLOBAL_VIEW
  if (typeof ref === 'string') return p.views.find((v) => v.name === ref)?.id
  const m = p.modules.find((m) => modulePath(p, m.id) === ref.module)
  return m && isolatedViewId(m.id)
}

export function openView(viewId: Id = GLOBAL_VIEW, options: { split?: boolean } = {}): void {
  patchDoc({ activeViewId: viewId })
  if (IN_PANEL)
    return sendToDiagram({ kind: 'openView', view: viewRef(getProject(), viewId), split: options.split })
  if (!editor) return
  const id = viewPanelId(viewId)
  const existing = editor.getPanel(id)
  if (existing) return existing.api.setActive()
  const active = editor.activePanel
  addViewPanel(
    viewId,
    active ? { referencePanel: active.id, direction: options.split ? 'right' : 'within' } : undefined
  )
}

function addViewPanel(
  viewId: Id,
  position?: { referencePanel: string; direction: 'right' | 'within' }
): void {
  editor?.addPanel({
    id: viewPanelId(viewId),
    component: 'canvas',
    tabComponent: 'view',
    title: findView(getProject(), viewId).name,
    params: { viewId },
    position
  })
}

/** Show another view in place of a view's tab (e.g. a temporary view once stored). */
export function replaceView(oldId: Id, newId: Id): void {
  const old = editor?.getPanel(viewPanelId(oldId))
  if (!editor || !old || editor.getPanel(viewPanelId(newId))) return openView(newId)
  patchDoc({ activeViewId: newId })
  addViewPanel(newId, { referencePanel: old.id, direction: 'within' })
  old.api.close()
}

export function closeView(viewId: Id): void {
  editor?.getPanel(viewPanelId(viewId))?.api.close()
}

export const SOURCE_PANEL = 'source'

/** Open the project as file text, beside the focused view by default. */
export function openSource(options: { split?: boolean } = { split: true }): void {
  if (!editor) return
  const existing = editor.getPanel(SOURCE_PANEL)
  if (existing) return existing.api.setActive()
  const active = editor.activePanel
  editor.addPanel({
    id: SOURCE_PANEL,
    component: 'source',
    tabComponent: 'entity',
    title: 'Source',
    params: { kind: 'source' },
    position: active
      ? { referencePanel: active.id, direction: options.split ? 'right' : 'within' }
      : undefined
  })
}

/** Tab of a text file (template, generated file, IDL file), see store/textFiles.ts. */
export const filePanelId = (ref: TextFileRef): string => `file:${ref.source}:${ref.path}`

/** Open a text file in a tab of the editor area, beside the focused one with `split`. */
export function openFilePanel(ref: TextFileRef, options: { split?: boolean } = {}): void {
  if (!editor) return
  const id = filePanelId(ref)
  const existing = editor.getPanel(id)
  if (existing) return existing.api.setActive()
  const active = editor.activePanel
  editor.addPanel({
    id,
    component: 'file',
    tabComponent: 'file',
    title: fileBaseName(ref.path),
    params: { source: ref.source, path: ref.path },
    position: active
      ? { referencePanel: active.id, direction: options.split ? 'right' : 'within' }
      : undefined
  })
}

/** The text file of the active editor tab, if it is one. */
export function activeFilePanel(): TextFileRef | null {
  const params = editor?.activePanel?.params as Partial<TextFileRef> | undefined
  return editor?.activePanel?.id.startsWith('file:') && params?.source && params.path
    ? { source: params.source, path: params.path }
    : null
}

/** Open an entity editor as a tab of the editor area. */
export function openEditor(kind: EditorKind, id: Id, options: { split?: boolean } = {}): void {
  if (IN_PANEL) {
    const p = getProject()
    const path = targetPath(toFile(p, { editor: false }), p, { kind, id })
    return sendToDiagram({ kind: 'openEditor', editor: kind, path, split: options.split })
  }
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
