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

/** An open document kept across page reloads. */
export interface SessionDoc {
  /** File of the document; null for an unsaved project. */
  path: string | null
  /** Unsaved edits: project as JSON, editor data included. Null when the file is up to date. */
  content: string | null
  /** Editor state (open views and editors). */
  ui?: unknown
}

/** Open documents kept across page reloads. */
export interface Session {
  docs: SessionDoc[]
  active: number
}

export interface Api {
  openFile(): Promise<OpenResult | null>
  /** File to open at startup: the last opened one. */
  initialFile(): Promise<OpenResult | null>
  /** Recently opened or saved project files, most recent first. */
  recentFiles(): Promise<string[]>
  /** Reads a recent file; null when it cannot be read anymore (it is then dropped from the list). */
  openRecent(path: string): Promise<OpenResult | null>
  /** Reads a recent file without asking for access nor reordering the list (session restore). */
  reopen(path: string): Promise<OpenResult | null>
  clearRecent(): Promise<void>
  onRecentChange(cb: (files: string[]) => void): () => void
  /** Resolves to the written path, or null when cancelled. */
  saveFile(req: SaveRequest): Promise<string | null>
  setDirty(dirty: boolean): void
  /** Stores the open documents. */
  saveSession(session: Session): void
  /** The open documents of the previous page load. */
  loadSession(): Promise<Session | null>
}

declare global {
  interface Window {
    api: Api
  }
}
