// Messages between the extension (session.ts) and its webview pages (src/renderer/src/vscodeApi.ts).
// Types only: the page imports this file too.

/**
 * Full diagram editor in place of the text, compact preview beside it, or one tool panel of the
 * ProjectScaffold views (following the active project document).
 */
export type WebviewMode = 'editor' | 'preview' | 'panel'

/** Tool panels of the ProjectScaffold views (the ProjectScaffold side bar). */
export type SidePanel = 'explorer' | 'modules' | 'links' | 'dependencies' | 'settings'

type DataPath = (string | number)[]

/** What the page needs before its scripts run, inlined in the HTML by the extension. */
export interface WebviewInit {
  /** File system path of the document; empty for a side panel without project document. */
  path: string
  /** URI of the document, kept by the page to be restored after a window reload. */
  uri: string
  mode: WebviewMode
  /** Side panel shown (mode `panel`). */
  panel?: SidePanel
  /** Text of the document, unsaved edits included. */
  text: string
  /** Stored preferences (settings, panel layout...), shared by all the editors. */
  storage: Record<string, string>
}

/** A view: stored by name, temporary by the path of its module (`Core.Sensor`), null: global. */
export type ViewRef = string | { module: string } | null

/** Done by a diagram for a side panel. Entities by data path of the file, views by reference. */
export type DiagramAction =
  | { kind: 'openView'; view: ViewRef; split?: boolean }
  | { kind: 'openEditor'; editor: 'type' | 'interface' | 'module' | 'link'; path: DataPath; split?: boolean }
  | { kind: 'command'; id: string }

export interface OutputDirReply {
  /** URI of the directory, given back in `outputFile`. */
  dir: string
  /** Shown to the user. */
  label: string
}

/** Content of a file read (null: no such file); an error when the operation failed. */
export type OutputFileReply = { text: string | null } | { error: string }

/** Page → extension. Messages with an `id` get a `reply` with the same id. */
export type ToHost =
  /** The project changed: new text of the document (an undoable, unsaved edit). */
  | { type: 'edit'; text: string; uri: string }
  | { type: 'save' }
  | { type: 'undo' }
  | { type: 'redo' }
  /** The page gained or lost the keyboard focus. */
  | { type: 'focus'; focused: boolean }
  | { type: 'storage'; key: string; value: string | null }
  /** Save dialog then write; replies with the written path, or null when cancelled. */
  | { type: 'export'; id: number; name: string; data: string; encoding: 'utf8' | 'base64' }
  /** Open dialog then read a project file; replies with `{ path, content }`, or null when cancelled. */
  | { type: 'openFile'; id: number }
  /**
   * Open dialog accepting several files with one of `extensions` (`description` names them), then
   * read; replies with `{ path, content }[]`, empty when cancelled.
   */
  | { type: 'openFiles'; id: number; filter: { description: string; extensions: string[] } }
  /** Reads a file next to the document; replies with its content, or null when unreadable. */
  | { type: 'readSibling'; id: number; file: string }
  /** Reads a file by absolute path; replies with its content, or null when unreadable. */
  | { type: 'readFile'; id: number; path: string }
  /** Opens a project file next to the document in its own editor. */
  | { type: 'openSibling'; file: string }
  /**
   * Directory of the code generated from the document: the one picked for it before, else the one
   * of the settings (`name`: the project's namespace); always picked with `pick`. Replies with an
   * `OutputDirReply`, or null when cancelled.
   */
  | { type: 'outputDir'; id: number; pick: boolean; name: string }
  /**
   * Template folder of the document's code generation: the one picked for it, else the one of the
   * settings, else null (`current`); one to pick and remember (`pick`, null when cancelled); back to
   * the settings (`forget`, replies null). Replies with an `OutputDirReply`, read with `outputFile`.
   */
  | { type: 'templateDir'; id: number; op: 'current' | 'pick' | 'forget' }
  /** File of a directory given by `outputDir`, by relative path: replies with an `OutputFileReply`. */
  | {
      type: 'outputFile'
      id: number
      dir: string
      path: string
      op: 'read' | 'write' | 'remove'
      text?: string
    }
  /** Opens a file of a directory given by `outputDir` / `templateDir` in its VS Code editor. */
  | { type: 'openOutputFile'; dir: string; path: string }
  /** The selection changed: data path of the selected entity in the file. */
  | { type: 'selected'; path: DataPath }
  /** A diagram shows another view. */
  | { type: 'view'; view: ViewRef }
  /** A side panel asks the diagram of its document for an action. */
  | { type: 'inDiagram'; action: DiagramAction }
  /** A page shows a side panel; the Dependencies panel with one of them (by name). */
  | { type: 'showPanel'; panel: SidePanel; dependency?: string }
  /** A line of the page's Output log, for the ProjectScaffold Output channel. */
  | { type: 'log'; line: string }
  /** Side panel: listening for its document, sent again in reply. Diagram: listening for commands. */
  | { type: 'ready' }

/** Extension → page. */
export type ToPage =
  /** The document's text changed outside the page: undo, text editor, file changed on disk. */
  | { type: 'update'; text: string }
  /** Side panel: another project document is active (path empty: none). */
  | { type: 'document'; path: string; uri: string; text: string }
  /** Runs an app command (VS Code command palette, editor title buttons). */
  | { type: 'run'; command: string }
  /** A preference changed in another editor. */
  | { type: 'storage'; key: string; value: string | null }
  /** Shows the entity at a data path of the file, with the name of the list item at each index. */
  | { type: 'reveal'; path: DataPath; names: (string | undefined)[] }
  /** Side panel: the view the diagram shows. */
  | { type: 'view'; view: ViewRef }
  /** Dependencies side panel: the dependency to show, by name. */
  | { type: 'dependency'; name: string }
  /** Diagram: an action asked by a side panel. */
  | { type: 'action'; action: DiagramAction }
  | { type: 'reply'; id: number; result: unknown }
