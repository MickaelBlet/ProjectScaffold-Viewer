// User preferences, kept in the preferences storage.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { IN_VSCODE, vscodeTheme } from '@/host'
import { onStorageChange, storage } from '@/storage'

export type Theme = 'system' | 'light' | 'dark'
export type EdgeStyle = 'bezier' | 'smoothstep' | 'step' | 'straight'
/** How port handles tell `in` from `out` apart, besides their color. */
export type PortStyle = 'dots' | 'arrows' | 'hollow' | 'shapes'
/** Whitespace shown in the code editors. */
export type WhitespaceShown = 'all' | 'trailing' | 'none'
/** Code editor minimap: characters shaded by their ink, or solid blocks. */
export type MinimapRender = 'characters' | 'blocks'

export interface Settings {
  theme: Theme
  snapToGrid: boolean
  gridSize: number
  /** Alignment guides and snapping to sibling edges while dragging. */
  guides: boolean
  /** Only selected modules, notes and frames move when dragged; others pan the view. */
  selectToMove: boolean
  edgeStyle: EdgeStyle
  portStyle: PortStyle
  minimap: boolean
  edgeBadges: boolean
  /** Link ends attach to the module side facing the other end. */
  autoOrientLinks: boolean
  /** Arrows from modules to their bases. */
  inheritance: boolean
  /** Arrange files without editor layout with ELK when opening them. */
  autoLayoutOnOpen: boolean
  /** Selecting on the canvas or in the Explorer brings the Inspector to the front. */
  revealInspector: boolean
  /** Keep animations even when the system asks for reduced motion. */
  forceAnimations: boolean
  /** Code editors: font size in pixels. */
  editorFontSize: number
  /** Code editors: CSS font family, empty for the built-in monospace one. */
  editorFontFamily: string
  /** Code editors: line height, relative to the font size. */
  editorLineHeight: number
  /** Code editors: columns of a tab and of an indentation level. */
  editorTabSize: number
  /** Code editors: indent with tabs (never in YAML, where tabs are invalid). */
  editorIndentTabs: boolean
  /** Code editors: dots and arrows for spaces and tabs, everywhere or trailing only. */
  editorWhitespace: WhitespaceShown
  /** Code editors: long lines wrap. */
  editorWordWrap: boolean
  editorLineNumbers: boolean
  /** Code editors: fold markers in the gutter. */
  editorFolding: boolean
  /** Code editors: the line of the caret highlighted. */
  editorActiveLine: boolean
  editorBracketMatching: boolean
  /** Code editors: typing an opening bracket or quote inserts the closing one. */
  editorCloseBrackets: boolean
  /** Code editors: completions shown while typing (Ctrl+Space shows them anyway). */
  editorAutocomplete: boolean
  /** Code editors: other occurrences of the selected text highlighted. */
  editorSelectionMatches: boolean
  /** Code editors: the last line can scroll to the top. */
  editorScrollPastEnd: boolean
  /** Code editors: minimap on the right (hidden in narrow editors). */
  editorMinimap: boolean
  editorMinimapRender: MinimapRender
  /** The element under the caret of the project text is selected and zoomed to. */
  sourceFollow: boolean
  /** The project text shows its changes since the last save. */
  sourceChanges: boolean
  /** Explorer sections top to bottom; sections missing here keep their default place. */
  explorerOrder: string[]
  /** Explorer sections not shown. */
  explorerHidden: string[]
  /** Code generation panel sections top to bottom. */
  generationOrder: string[]
  /** Code generation panel files as a folder tree, not a list. */
  generationTree: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  snapToGrid: true,
  gridSize: 20,
  guides: true,
  selectToMove: true,
  edgeStyle: 'bezier',
  portStyle: 'hollow',
  minimap: true,
  edgeBadges: true,
  autoOrientLinks: true,
  inheritance: true,
  autoLayoutOnOpen: true,
  revealInspector: true,
  forceAnimations: true,
  editorFontSize: 12,
  editorFontFamily: '',
  editorLineHeight: 1.5,
  editorTabSize: 2,
  editorIndentTabs: false,
  editorWhitespace: 'all',
  editorWordWrap: false,
  editorLineNumbers: true,
  editorFolding: true,
  editorActiveLine: true,
  editorBracketMatching: true,
  editorCloseBrackets: true,
  editorAutocomplete: true,
  editorSelectionMatches: true,
  editorScrollPastEnd: false,
  editorMinimap: true,
  editorMinimapRender: 'characters',
  sourceFollow: true,
  sourceChanges: true,
  explorerOrder: [],
  explorerHidden: [],
  generationOrder: [],
  generationTree: false
}

const SETTINGS_KEY = 'project-scaffold:settings'

/** Settings renamed since. */
interface Legacy {
  sourceWhitespace?: boolean
}

function migrate({ sourceWhitespace, ...saved }: Partial<Settings> & Legacy): Partial<Settings> {
  if (sourceWhitespace === false && saved.editorWhitespace === undefined) saved.editorWhitespace = 'none'
  return saved
}

export const useSettings = create<Settings>()(
  persist(() => ({ ...DEFAULT_SETTINGS }), {
    name: SETTINGS_KEY,
    // Settings added later get their default.
    merge: (saved, current) => ({ ...current, ...migrate(saved as Partial<Settings> & Legacy) }),
    storage: createJSONStorage(() => storage)
  })
)

// VS Code: settings changed in another editor.
onStorageChange((key) => {
  if (key === SETTINGS_KEY) void useSettings.persist.rehydrate()
})

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  useSettings.setState({ [key]: value } as Pick<Settings, K>)
}

export function applyForceAnimations(force: boolean): void {
  if (force) document.documentElement.dataset.forceMotion = ''
  else delete document.documentElement.dataset.forceMotion
}

export function applyPortStyle(style: PortStyle): void {
  document.documentElement.dataset.portStyle = style
}

export function applyTheme(theme: Theme): void {
  // In VS Code, the system theme is the VS Code color theme: its kind and its colors.
  const vscodeColors = theme === 'system' && IN_VSCODE
  const resolved = vscodeColors ? vscodeTheme() : theme
  const root = document.documentElement
  if (resolved === 'system') delete root.dataset.theme
  else root.dataset.theme = resolved
  if (vscodeColors) root.dataset.vscodeColors = ''
  else delete root.dataset.vscodeColors
}
