export type MenuAction =
  'new' | 'open' | 'save' | 'save-as' | 'export-yaml' | 'export-json' | 'undo' | 'redo' | 'add-module'

export interface OpenResult {
  path: string
  content: string
}

export interface SaveRequest {
  /** Existing path; when null a save dialog is shown. */
  path: string | null
  content: string
  defaultName: string
  format: 'yaml' | 'json'
  title?: string
  /** Exports are not added to the recent documents. */
  export?: boolean
}

/** Unsaved edits kept across page reloads (browser only). */
export interface Draft {
  /** File the edits belong to; null for an unsaved project. */
  path: string | null
  /** Project as JSON, editor data included. */
  content: string
}

export interface Api {
  openFile(): Promise<OpenResult | null>
  /** File to open at startup: the one passed on the command line, else the last opened one. */
  initialFile(): Promise<OpenResult | null>
  /** Recently opened or saved project files, most recent first. */
  recentFiles(): Promise<string[]>
  /** Reads a recent file; null when it cannot be read anymore (it is then dropped from the list). */
  openRecent(path: string): Promise<OpenResult | null>
  clearRecent(): Promise<void>
  onRecentChange(cb: (files: string[]) => void): () => void
  /** A recent file picked from the application menu. */
  onOpenRecent(cb: (path: string) => void): () => void
  /** Resolves to the written path, or null when cancelled. */
  saveFile(req: SaveRequest): Promise<string | null>
  setDirty(dirty: boolean): void
  /** Browser only: stores the unsaved edits, or clears them when null. */
  saveDraft?(draft: Draft | null): void
  /** Browser only: the unsaved edits of the previous page load. */
  loadDraft?(): Promise<Draft | null>
  onMenu(cb: (action: MenuAction) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
