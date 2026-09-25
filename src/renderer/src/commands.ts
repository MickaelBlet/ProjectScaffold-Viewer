// Command registry: toolbar menus, context menus, the command palette and keyboard shortcuts
// all run the same commands.
import {
  addModuleAt,
  addNoteAt,
  addPortToSelection,
  addSubmoduleToSelection,
  alignSelection,
  arrangeLayout,
  copySelection,
  cutSelection,
  deleteSelection,
  distributeSelection,
  duplicateSelection,
  exportImage,
  groupSelection,
  hideSelection,
  newView,
  nudgeSelection,
  openModuleView,
  paste,
  sameSizeSelection,
  selectAll,
  selectedIds,
  showAllInView,
  startRename
} from './actions'
import { closeDocument, exportProject, newProject, openProject, saveAll, saveProject } from './fileOps'
import { activeDoc, cycleDoc, patchDoc, useDocs, activateDoc } from './store/documents'
import { redo, undo } from './store/project'
import { applyTheme, setSetting, useSettings, type Theme } from './store/settings'
import { useUiStore, type MenuItem } from './store/ui'
import { activeCanvas, openView, resetLayout, showTool, toggleTool, type ToolId } from './shell/controllers'
import { GLOBAL_VIEW } from './model/types'

export type Category = 'File' | 'Edit' | 'Insert' | 'View' | 'Arrange' | 'Window' | 'Help'

export interface Command {
  id: string
  title: string
  category: Category
  /** Shortcuts, e.g. `Ctrl+Shift+S`, `Alt+1`, `Delete`. Ctrl also matches Cmd. */
  keys?: string[]
  /** Also runs while typing in a text field. */
  global?: boolean
  /** Not listed in menus / palette (shortcut only). */
  hidden?: boolean
  enabled?: () => boolean
  checked?: () => boolean
  run: () => void
}

export function isEditable(el: Element | null): boolean {
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      (el as HTMLElement).isContentEditable)
  )
}

const hasSelection = (): boolean => selectedIds().length > 0
const multi = (n: number) => (): boolean => selectedIds().length >= n
const moduleSelected = (): boolean => activeDoc().selection?.kind === 'module'
const setting =
  <K extends 'snapToGrid' | 'guides' | 'minimap' | 'edgeBadges' | 'autoOrientLinks'>(key: K) =>
  (): boolean =>
    useSettings.getState()[key]
const toggle = (key: 'snapToGrid' | 'guides' | 'minimap' | 'edgeBadges' | 'autoOrientLinks') => (): void =>
  setSetting(key, !useSettings.getState()[key])
const theme = (t: Theme) => (): void => {
  setSetting('theme', t)
  applyTheme(t)
}
const tool = (id: ToolId) => (): void => showTool(id)

const docCommands: Command[] = Array.from({ length: 9 }, (_, i) => ({
  id: `doc.${i + 1}`,
  title: `Go to document ${i + 1}`,
  category: 'Window' as const,
  keys: [`Alt+${i + 1}`],
  global: true,
  hidden: true,
  run: () => {
    const doc = useDocs.getState().docs[i]
    if (doc) activateDoc(doc.id)
  }
}))

export const commands: Command[] = [
  // File
  { id: 'file.new', title: 'New project', category: 'File', keys: ['Alt+N'], global: true, run: newProject },
  {
    id: 'file.open',
    title: 'Open…',
    category: 'File',
    keys: ['Ctrl+O'],
    global: true,
    run: () => void openProject()
  },
  {
    id: 'file.save',
    title: 'Save',
    category: 'File',
    keys: ['Ctrl+S'],
    global: true,
    run: () => void saveProject()
  },
  {
    id: 'file.saveAs',
    title: 'Save as…',
    category: 'File',
    keys: ['Ctrl+Shift+S'],
    global: true,
    run: () => void saveProject(true)
  },
  {
    id: 'file.saveAll',
    title: 'Save all',
    category: 'File',
    keys: ['Ctrl+Alt+S'],
    global: true,
    run: () => void saveAll()
  },
  {
    id: 'file.close',
    title: 'Close document',
    category: 'File',
    keys: ['Alt+W'],
    global: true,
    run: () => closeDocument()
  },
  {
    id: 'file.exportYaml',
    title: 'Export YAML…',
    category: 'File',
    keys: ['Ctrl+E'],
    global: true,
    run: () => void exportProject('yaml')
  },
  {
    id: 'file.exportJson',
    title: 'Export JSON…',
    category: 'File',
    keys: ['Ctrl+Shift+E'],
    global: true,
    run: () => void exportProject('json')
  },
  {
    id: 'file.exportPng',
    title: 'Export diagram as PNG',
    category: 'File',
    run: () => void exportImage('png')
  },
  {
    id: 'file.exportSvg',
    title: 'Export diagram as SVG',
    category: 'File',
    run: () => void exportImage('svg')
  },

  // Edit
  {
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    keys: ['Ctrl+Z'],
    global: true,
    // Inside a text field, undo the typing instead of the model.
    run: () => (isEditable(document.activeElement) ? document.execCommand('undo') : undo())
  },
  {
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    global: true,
    run: () => (isEditable(document.activeElement) ? document.execCommand('redo') : redo())
  },
  // Ctrl+X / C / V go through the clipboard events (see installClipboard); listed for menus.
  {
    id: 'edit.cut',
    title: 'Cut',
    category: 'Edit',
    keys: ['Ctrl+X'],
    enabled: hasSelection,
    run: () => void cutSelection()
  },
  {
    id: 'edit.copy',
    title: 'Copy',
    category: 'Edit',
    keys: ['Ctrl+C'],
    enabled: hasSelection,
    run: () => void copySelection()
  },
  { id: 'edit.paste', title: 'Paste', category: 'Edit', keys: ['Ctrl+V'], run: () => void paste() },
  {
    id: 'edit.duplicate',
    title: 'Duplicate',
    category: 'Edit',
    keys: ['Ctrl+D'],
    enabled: hasSelection,
    run: duplicateSelection
  },
  {
    id: 'edit.delete',
    title: 'Delete',
    category: 'Edit',
    keys: ['Delete', 'Backspace'],
    enabled: () => hasSelection() || activeDoc().selection?.kind === 'link',
    run: deleteSelection
  },
  { id: 'edit.selectAll', title: 'Select all', category: 'Edit', keys: ['Ctrl+A'], run: selectAll },
  {
    id: 'edit.deselect',
    title: 'Clear selection',
    category: 'Edit',
    keys: ['Escape'],
    hidden: true,
    run: () => patchDoc({ selectedIds: [], selection: null })
  },
  {
    id: 'edit.rename',
    title: 'Rename module',
    category: 'Edit',
    keys: ['F2'],
    enabled: moduleSelected,
    run: startRename
  },
  ...(
    [
      ['Up', 0, -1],
      ['Down', 0, 1],
      ['Left', -1, 0],
      ['Right', 1, 0]
    ] as const
  ).flatMap(([dir, dx, dy]) => [
    {
      id: `edit.nudge${dir}`,
      title: `Move selection ${dir.toLowerCase()}`,
      category: 'Edit' as const,
      keys: [`Arrow${dir}`],
      hidden: true,
      run: () => nudgeSelection(dx * 2, dy * 2)
    },
    {
      id: `edit.nudge${dir}Far`,
      title: `Move selection ${dir.toLowerCase()} (far)`,
      category: 'Edit' as const,
      keys: [`Shift+Arrow${dir}`],
      hidden: true,
      run: () => nudgeSelection(dx * 20, dy * 20)
    }
  ]),

  // Insert
  {
    id: 'insert.module',
    title: 'Add module',
    category: 'Insert',
    keys: ['Ctrl+M'],
    global: true,
    run: () => void addModuleAt()
  },
  {
    id: 'insert.submodule',
    title: 'Add submodule',
    category: 'Insert',
    keys: ['Alt+M'],
    enabled: moduleSelected,
    run: addSubmoduleToSelection
  },
  {
    id: 'insert.inPort',
    title: 'Add in port',
    category: 'Insert',
    keys: ['Alt+I'],
    enabled: moduleSelected,
    run: () => addPortToSelection('in')
  },
  {
    id: 'insert.outPort',
    title: 'Add out port',
    category: 'Insert',
    keys: ['Alt+O'],
    enabled: moduleSelected,
    run: () => addPortToSelection('out')
  },
  { id: 'insert.note', title: 'Add note', category: 'Insert', run: () => addNoteAt('note') },
  { id: 'insert.frame', title: 'Add frame', category: 'Insert', run: () => addNoteAt('frame') },

  // View
  {
    id: 'view.palette',
    title: 'Command palette…',
    category: 'View',
    keys: ['Ctrl+Shift+P', 'F1'],
    global: true,
    run: () => useUiStore.setState({ palette: { query: '>' } })
  },
  {
    id: 'view.goto',
    title: 'Go to…',
    category: 'View',
    keys: ['Ctrl+P'],
    global: true,
    run: () => useUiStore.setState({ palette: { query: '' } })
  },
  {
    id: 'view.fit',
    title: 'Fit selection',
    category: 'View',
    keys: ['F'],
    run: () => activeCanvas()?.fit(selectedIds())
  },
  {
    id: 'view.fitAll',
    title: 'Fit all',
    category: 'View',
    keys: ['Shift+F'],
    run: () => activeCanvas()?.fit()
  },
  {
    id: 'view.zoomIn',
    title: 'Zoom in',
    category: 'View',
    keys: ['+', '='],
    run: () => activeCanvas()?.zoomBy(1.25)
  },
  {
    id: 'view.zoomOut',
    title: 'Zoom out',
    category: 'View',
    keys: ['-'],
    run: () => activeCanvas()?.zoomBy(0.8)
  },
  {
    id: 'view.zoomReset',
    title: 'Zoom 100%',
    category: 'View',
    keys: ['Ctrl+0'],
    run: () => activeCanvas()?.zoomTo(1)
  },
  {
    id: 'view.global',
    title: 'Open global view',
    category: 'View',
    keys: ['Alt+G'],
    run: () => openView(GLOBAL_VIEW)
  },
  {
    id: 'view.openModule',
    title: 'Open module in its own view',
    category: 'View',
    keys: ['Alt+Enter'],
    enabled: moduleSelected,
    run: () => openModuleView()
  },
  {
    id: 'view.openModuleSplit',
    title: 'Open module view to the side',
    category: 'View',
    enabled: moduleSelected,
    run: () => openModuleView(undefined, true)
  },
  { id: 'view.new', title: 'New view', category: 'View', run: newView },
  {
    id: 'view.hide',
    title: 'Hide selection in view',
    category: 'View',
    keys: ['H'],
    enabled: hasSelection,
    run: hideSelection
  },
  {
    id: 'view.showAll',
    title: 'Show hidden modules',
    category: 'View',
    keys: ['Shift+H'],
    run: showAllInView
  },
  {
    id: 'view.minimap',
    title: 'Minimap',
    category: 'View',
    checked: setting('minimap'),
    run: toggle('minimap')
  },
  {
    id: 'view.badges',
    title: 'Link badges',
    category: 'View',
    checked: setting('edgeBadges'),
    run: toggle('edgeBadges')
  },
  {
    id: 'view.autoOrient',
    title: 'Auto-orient link ends',
    category: 'View',
    checked: setting('autoOrientLinks'),
    run: toggle('autoOrientLinks')
  },
  {
    id: 'view.themeSystem',
    title: 'Theme: system',
    category: 'View',
    checked: () => useSettings.getState().theme === 'system',
    run: theme('system')
  },
  {
    id: 'view.themeLight',
    title: 'Theme: light',
    category: 'View',
    checked: () => useSettings.getState().theme === 'light',
    run: theme('light')
  },
  {
    id: 'view.themeDark',
    title: 'Theme: dark',
    category: 'View',
    checked: () => useSettings.getState().theme === 'dark',
    run: theme('dark')
  },

  // Arrange
  {
    id: 'arrange.auto',
    title: 'Auto-arrange (selection content / view)',
    category: 'Arrange',
    keys: ['Ctrl+Alt+L'],
    run: () => void arrangeLayout('auto')
  },
  {
    id: 'arrange.all',
    title: 'Auto-arrange everything',
    category: 'Arrange',
    run: () => void arrangeLayout('all')
  },
  {
    id: 'arrange.group',
    title: 'Group into a module',
    category: 'Arrange',
    keys: ['Ctrl+G'],
    enabled: hasSelection,
    run: groupSelection
  },
  {
    id: 'arrange.left',
    title: 'Align left',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('left')
  },
  {
    id: 'arrange.hcenter',
    title: 'Align centers horizontally',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('hcenter')
  },
  {
    id: 'arrange.right',
    title: 'Align right',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('right')
  },
  {
    id: 'arrange.top',
    title: 'Align top',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('top')
  },
  {
    id: 'arrange.vcenter',
    title: 'Align middles vertically',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('vcenter')
  },
  {
    id: 'arrange.bottom',
    title: 'Align bottom',
    category: 'Arrange',
    enabled: multi(2),
    run: () => alignSelection('bottom')
  },
  {
    id: 'arrange.distH',
    title: 'Distribute horizontally',
    category: 'Arrange',
    enabled: multi(3),
    run: () => distributeSelection('h')
  },
  {
    id: 'arrange.distV',
    title: 'Distribute vertically',
    category: 'Arrange',
    enabled: multi(3),
    run: () => distributeSelection('v')
  },
  {
    id: 'arrange.sameSize',
    title: 'Same size',
    category: 'Arrange',
    enabled: multi(2),
    run: () => sameSizeSelection('both')
  },
  {
    id: 'arrange.snap',
    title: 'Snap to grid',
    category: 'Arrange',
    checked: setting('snapToGrid'),
    run: toggle('snapToGrid')
  },
  {
    id: 'arrange.guides',
    title: 'Alignment guides',
    category: 'Arrange',
    checked: setting('guides'),
    run: toggle('guides')
  },

  // Window
  { id: 'window.explorer', title: 'Explorer', category: 'Window', run: tool('explorer') },
  {
    id: 'window.outline',
    title: 'Outline',
    category: 'Window',
    keys: ['Ctrl+Shift+O'],
    global: true,
    run: tool('outline')
  },
  {
    id: 'window.inspector',
    title: 'Inspector',
    category: 'Window',
    keys: ['Ctrl+I'],
    global: true,
    run: tool('inspector')
  },
  {
    id: 'window.problems',
    title: 'Problems',
    category: 'Window',
    keys: ['Ctrl+Shift+M'],
    global: true,
    run: tool('problems')
  },
  {
    id: 'window.search',
    title: 'Search',
    category: 'Window',
    keys: ['Ctrl+Shift+F'],
    global: true,
    run: tool('search')
  },
  {
    id: 'window.settings',
    title: 'Settings',
    category: 'Window',
    keys: ['Ctrl+,'],
    global: true,
    run: () => toggleTool('settings')
  },
  {
    id: 'window.nextDoc',
    title: 'Next document',
    category: 'Window',
    keys: ['Alt+PageDown'],
    global: true,
    run: () => cycleDoc(1)
  },
  {
    id: 'window.prevDoc',
    title: 'Previous document',
    category: 'Window',
    keys: ['Alt+PageUp'],
    global: true,
    run: () => cycleDoc(-1)
  },
  { id: 'window.resetLayout', title: 'Reset panel layout', category: 'Window', run: resetLayout },
  ...docCommands,

  // Help
  {
    id: 'help.shortcuts',
    title: 'Keyboard shortcuts',
    category: 'Help',
    keys: ['?'],
    run: () => useUiStore.setState({ shortcutsOpen: true })
  }
]

const byId = new Map(commands.map((c) => [c.id, c]))

export function getCommand(id: string): Command {
  const c = byId.get(id)
  if (!c) throw new Error(`Unknown command ${id}`)
  return c
}

export function runCommand(id: string): void {
  const c = getCommand(id)
  if (c.enabled?.() ?? true) c.run()
}

/** Menu entry running a command. */
export function commandItem(id: string, label?: string): MenuItem {
  const c = getCommand(id)
  return {
    label: label ?? c.title,
    keys: c.keys?.[0] ? keyLabel(c.keys[0]) : undefined,
    disabled: !(c.enabled?.() ?? true),
    checked: c.checked?.(),
    run: () => runCommand(id)
  }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Shortcut text for display. */
export function keyLabel(keys: string): string {
  return isMac ? keys.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧') : keys
}

/** Shortcut of a key event, in the `keys` notation. */
export function keyOf(e: KeyboardEvent): string {
  let key = e.key
  // Layout independent digits (Alt+1 on AZERTY).
  if (/^(Digit|Numpad)\d$/.test(e.code)) key = e.code.slice(-1)
  else if (key.length === 1) key = key.toUpperCase()
  // Shift is part of symbols ('?', '+'): not a modifier for them.
  const symbol = key.length === 1 && !/[A-Z0-9]/.test(key)
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && !symbol ? 'Shift+' : ''}${key}`
}

export function installKeyboard(): () => void {
  const byKey = new Map<string, Command>()
  for (const c of commands) for (const k of c.keys ?? []) byKey.set(k, c)
  const listener = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    const c = byKey.get(keyOf(e))
    if (!c) return
    // Clipboard shortcuts go through the copy / cut / paste events.
    if (c.id === 'edit.copy' || c.id === 'edit.cut' || c.id === 'edit.paste') return
    if (!c.global && isEditable(document.activeElement)) return
    // Modal UI (palette, menus) handles its own keys.
    const ui = useUiStore.getState()
    if ((ui.palette || ui.contextMenu || ui.shortcutsOpen || ui.dialog) && !c.global) return
    if (!(c.enabled?.() ?? true)) return
    e.preventDefault()
    c.run()
  }
  window.addEventListener('keydown', listener)
  return () => window.removeEventListener('keydown', listener)
}

/** Copy / cut / paste of canvas and explorer items through the system clipboard. */
export function installClipboard(): () => void {
  const onCopy = (e: ClipboardEvent): void => {
    if (isEditable(document.activeElement) || window.getSelection()?.toString()) return
    if (copySelection(e.clipboardData)) e.preventDefault()
  }
  const onCut = (e: ClipboardEvent): void => {
    if (isEditable(document.activeElement) || window.getSelection()?.toString()) return
    if (cutSelection(e.clipboardData)) e.preventDefault()
  }
  const onPaste = (e: ClipboardEvent): void => {
    if (isEditable(document.activeElement)) return
    e.preventDefault()
    void paste(e.clipboardData)
  }
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  return () => {
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCut)
    document.removeEventListener('paste', onPaste)
  }
}
