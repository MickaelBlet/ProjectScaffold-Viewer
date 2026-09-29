import type { DiagramAction, SidePanel } from '../../../vscode/src/protocol'
import type { OutputDir } from './codegen/run'

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

export interface OutputDirRequest {
  pick: boolean
  /** File of the document; null for an unsaved project. */
  document: string | null
  /** Default directory name (the project's namespace). */
  name: string
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
  /** Open dialog accepting several files; empty when cancelled. */
  openFiles(): Promise<OpenResult[]>
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
  /**
   * Content of a document's file when it changed since it was last read or written here (edited
   * in another program); null otherwise, and when the file cannot be watched.
   */
  changedOnDisk(path: string): Promise<string | null>
  /** False when saving downloads a copy instead of writing the file (Firefox, Safari). */
  writesFiles: boolean
  setDirty(dirty: boolean): void
  /** Stores the open documents. */
  saveSession(session: Session): void
  /** The open documents of the previous page load. */
  loadSession(): Promise<Session | null>
  /** Saves an exported diagram image (data: URL); resolves to its name, or null when cancelled. */
  saveImage(name: string, dataUrl: string): Promise<string | null>
  /**
   * Directory generated code goes to: the one last used for the document, else one to pick (always
   * with `pick`); null when cancelled. Absent when the host cannot write into a directory.
   */
  outputDir?(request: OutputDirRequest): Promise<OutputDir | null>

  // VS Code only: the page edits one document whose text, undo history and file VS Code owns.
  /** Writes the project's new content to the document text, as an unsaved edit. */
  updateText?(content: string): void
  /** Undo / redo of the document text; they replace the page's own history. */
  undo?(): void
  redo?(): void
  /** Reads a project file next to the document; null when it cannot be read. */
  readSibling?(file: string): Promise<string | null>
  /** Opens a project file next to the document in its own editor. */
  openSibling?(file: string): void
  /** The document text changed outside the page: undo, text editor, file changed on disk. */
  onExternalChange?(cb: (text: string) => void): () => void
  /** Commands run from VS Code (command palette, editor title buttons). */
  onCommand?(cb: (id: string) => void): () => void
  /** The diagram selection changed: data path of the selected entity, for the text cursor. */
  selected?(path: (string | number)[]): void
  /** Entities to show, by data path of the file and list item names (VS Code outline). */
  onReveal?(cb: (path: (string | number)[], names: (string | undefined)[]) => void): () => void
  /** Side panel: asks the diagram of the document for an action. */
  inDiagram?(action: DiagramAction): void
  /** Side panel: another project document is active (path empty: none). */
  onDocument?(cb: (file: OpenResult) => void): () => void
  /** Side panel: the view the diagram shows (by name, null: global). */
  onView?(cb: (view: string | null) => void): () => void
  /** Diagram: shows another view (by name, null: global), for the side panels. */
  viewChanged?(view: string | null): void
  /** Diagram: actions asked by the side panels. */
  onAction?(cb: (action: DiagramAction) => void): () => void
  /** Diagram: shows a panel of the VS Code side bar. */
  showPanel?(panel: SidePanel): void
}

/** Window edge or corner a resize starts from. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Frameless desktop window: the page draws the window buttons, and the resize edges when the
 *  window has none of its own (Electron). */
export interface Desktop {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizedChange(cb: (maximized: boolean) => void): () => void
  resizeStart?(): void
  /** Pointer offset in screen pixels since resizeStart. */
  resize?(edge: ResizeEdge, dx: number, dy: number): void
}

declare global {
  interface Window {
    api: Api
    /** Only in the desktop app. */
    desktop?: Desktop
  }
}
