import { create } from 'zustand'
import type { Id, Project } from '@/model/types'

export type Selection =
  | { kind: 'project' }
  | { kind: 'module'; id: Id }
  | { kind: 'link'; id: Id }
  | { kind: 'type'; id: Id }
  | { kind: 'interface'; id: Id }
  | null

export type SidebarTab = 'types' | 'interfaces'

interface UiState {
  selection: Selection
  sidebarTab: SidebarTab
  filePath: string | null
  /** Recent project files, most recent first. */
  recent: string[]
  /** Project as last saved/loaded; the document is dirty when it differs. */
  savedProject: Project | null
  status: { kind: 'info' | 'error'; text: string } | null
  dialog: { title: string; lines: string[] } | null
  /** Bumped when a project is loaded, to re-fit the canvas. */
  viewEpoch: number
}

export const useUiStore = create<UiState>(() => ({
  selection: null,
  sidebarTab: 'types',
  filePath: null,
  recent: [],
  savedProject: null,
  status: null,
  dialog: null,
  viewEpoch: 0
}))

export const select = (selection: Selection): void => useUiStore.setState({ selection })

export const setStatus = (kind: 'info' | 'error', text: string): void =>
  useUiStore.setState({ status: { kind, text } })

export const showDialog = (title: string, lines: string[]): void =>
  useUiStore.setState({ dialog: { title, lines } })
