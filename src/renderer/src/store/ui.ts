import type { ReactNode } from 'react'
import { create } from 'zustand'
import type { Id } from '@/model/types'
import { patchDoc, useDoc, type Selection } from './documents'
import { log } from './output'

export type { Selection } from './documents'

export interface ActionItem {
  label: string
  run: () => void
  keys?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  title?: string
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
  dialog: { title: string; lines: string[] } | null
  contextMenu: { x: number; y: number; items: MenuItem[] } | null
  /** Command palette: '>' prefix lists commands, otherwise entities; or a quick pick of `pick`. */
  palette: { query: string; pick?: { placeholder: string; entries: PickEntry[] } } | null
  shortcutsOpen: boolean
  aboutOpen: boolean
  /** Module whose name is being edited on the canvas. */
  renaming: Id | null
  /** Zoom of the focused canvas, for the status bar. */
  zoom: number
  /** Dependency shown in the Dependencies panel (the first one when unset). */
  dependency: Id | null
}

export const useUiStore = create<UiState>(() => ({
  recent: [],
  status: null,
  dialog: null,
  contextMenu: null,
  palette: null,
  shortcutsOpen: false,
  aboutOpen: false,
  renaming: null,
  zoom: 1,
  dependency: null
}))

/** Show an entity in the inspector; it also becomes the selection that copy / delete act on. */
export const select = (selection: Selection): void =>
  patchDoc({
    selection,
    selectedIds: selection && 'id' in selection && selection.kind !== 'link' ? [selection.id] : []
  })

export const useSelection = (): Selection => useDoc((d) => d.selection)

/** Shows a message in the status bar, logged to the Output panel. */
export function setStatus(kind: 'info' | 'error', text: string): void {
  log(kind, 'app', text)
  useUiStore.setState({ status: { kind, text } })
}

/** Shows a dialog, logged to the Output panel unless `logged` (the caller logged it its own way). */
export function showDialog(title: string, lines: string[], options: { logged?: boolean } = {}): void {
  if (!options.logged) {
    log('error', 'app', title)
    for (const line of lines) log('error', 'app', `  ${line}`)
  }
  useUiStore.setState({ dialog: { title, lines } })
}

/** Let the user pick one of `entries` in the command palette. */
export const quickPick = (placeholder: string, entries: PickEntry[]): void =>
  useUiStore.setState({ palette: { query: '', pick: { placeholder, entries } } })

export const openContextMenu = (e: { clientX: number; clientY: number }, items: MenuItem[]): void =>
  useUiStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
