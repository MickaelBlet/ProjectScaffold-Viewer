import type { ReactNode } from 'react'
import { create } from 'zustand'
import type { Id } from '@/model/types'
import { patchDoc, useDoc, type Selection } from './documents'

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
  renaming: null,
  zoom: 1
}))

/** Show an entity in the inspector; it also becomes the selection that copy / delete act on. */
export const select = (selection: Selection): void =>
  patchDoc({
    selection,
    selectedIds: selection && 'id' in selection && selection.kind !== 'link' ? [selection.id] : []
  })

export const useSelection = (): Selection => useDoc((d) => d.selection)

export const setStatus = (kind: 'info' | 'error', text: string): void =>
  useUiStore.setState({ status: { kind, text } })

export const showDialog = (title: string, lines: string[]): void =>
  useUiStore.setState({ dialog: { title, lines } })

/** Let the user pick one of `entries` in the command palette. */
export const quickPick = (placeholder: string, entries: PickEntry[]): void =>
  useUiStore.setState({ palette: { query: '', pick: { placeholder, entries } } })

export const openContextMenu = (e: { clientX: number; clientY: number }, items: MenuItem[]): void =>
  useUiStore.setState({ contextMenu: { x: e.clientX, y: e.clientY, items } })
