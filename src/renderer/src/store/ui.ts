import type { ReactNode } from 'react'
import { create } from 'zustand'
import type { Id } from '@/model/types'
import type { IconName } from '@/components/Icon'
import { patchDoc, useDoc, type Selection } from './documents'
import { log, type OutputLevel } from './output'

export type { Selection } from './documents'

export interface ActionItem {
  label: string
  run: () => void
  keys?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  title?: string
  /** Shown where the check mark goes, when not checked. */
  icon?: IconName
}
export type MenuItem = ActionItem | { label: string; submenu: MenuItem[]; disabled?: boolean } | 'separator'

/** A choice of a quick pick (command palette listing given entries). */
export interface PickEntry {
  key: string
  label: string
  detail?: string
  /** Short badge: a letter or an icon. */
  kind: ReactNode
  run: () => void
}

interface UiState {
  /** Recent project files, most recent first. */
  recent: string[]
  status: { kind: 'info' | 'error'; text: string } | null
  /**
   * Lines marked `warning` or `error` show the icon of their level in place of a bullet. `action`:
   * a button doing something more than closing (closing as well).
   */
  dialog: {
    title: string
    lines: { text: string; level?: 'warning' | 'error' }[]
    action?: DialogAction
  } | null
  contextMenu: { x: number; y: number; items: MenuItem[] } | null
  /** Command palette: '>' prefix lists commands, otherwise entities; or a quick pick of `pick`. */
  palette: { query: string; pick?: { placeholder: string; entries: PickEntry[] } } | null
  shortcutsOpen: boolean
  aboutOpen: boolean
  /** Step of the tutorial shown, null when closed. */
  tutorialStep: number | null
  /** Module whose name is being edited on the canvas. */
  renaming: Id | null
  /** Zoom of the focused canvas, for the status bar. */
  zoom: number
}

export const useUiStore = create<UiState>(() => ({
  recent: [],
  status: null,
  dialog: null,
  contextMenu: null,
  palette: null,
  shortcutsOpen: false,
  aboutOpen: false,
  tutorialStep: null,
  renaming: null,
  zoom: 1
}))

/** Show an entity in the inspector; it also becomes the selection that copy / delete act on. */
export const select = (selection: Selection): void =>
  patchDoc({
    selection,
    selectedIds:
      selection && 'id' in selection && selection.kind !== 'link' && selection.kind !== 'dependency'
        ? [selection.id]
        : []
  })

export const useSelection = (): Selection => useDoc((d) => d.selection)

/** Shows a message in the status bar, logged to the Output panel. */
export function setStatus(kind: 'info' | 'error', text: string): void {
  log(kind, text)
  useUiStore.setState({ status: { kind, text } })
}

/** Button of a dialog beside Close, such as deleting anyway what is still used. */
export interface DialogAction {
  label: string
  run: () => void
  danger?: boolean
}

/** Line of a dialog: logged at the dialog's level, unless it has its own. */
export type DialogLine = string | { level: OutputLevel; text: string }

/**
 * Shows a dialog, logged to the Output panel at `level`: `error` for what failed, `warning` for
 * what was approximated or left out by what succeeded.
 */
export function showDialog(
  title: string,
  lines: DialogLine[],
  level: OutputLevel = 'error',
  action?: DialogAction
): void {
  log(level, title)
  for (const line of lines)
    if (typeof line === 'string') log(level, `  ${line}`)
    else log(line.level, `  ${line.text}`)
  // Warnings are marked, and lines with a level of their own; lines of an error dialog are not.
  const mark = (l: OutputLevel): 'warning' | 'error' | undefined => (l === 'info' ? undefined : l)
  useUiStore.setState({
    dialog: {
      title,
      lines: lines.map((l) =>
        typeof l === 'string'
          ? { text: l, level: level === 'warning' ? 'warning' : undefined }
          : { text: l.text, level: mark(l.level) }
      ),
      action
    }
  })
}

/** Let the user pick one of `entries` in the command palette. */
export const quickPick = (placeholder: string, entries: PickEntry[]): void =>
  useUiStore.setState({ palette: { query: '', pick: { placeholder, entries } } })

export const openContextMenu = (e: { clientX: number; clientY: number }, items: MenuItem[]): void =>
  useUiStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
