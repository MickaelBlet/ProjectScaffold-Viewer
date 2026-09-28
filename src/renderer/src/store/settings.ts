// User preferences, kept in localStorage.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Theme = 'system' | 'light' | 'dark'
export type EdgeStyle = 'bezier' | 'smoothstep' | 'step' | 'straight'
/** How port handles tell `in` from `out` apart, besides their color. */
export type PortStyle = 'dots' | 'arrows' | 'hollow' | 'shapes'

export interface Settings {
  theme: Theme
  snapToGrid: boolean
  gridSize: number
  /** Alignment guides and snapping to sibling edges while dragging. */
  guides: boolean
  edgeStyle: EdgeStyle
  portStyle: PortStyle
  minimap: boolean
  edgeBadges: boolean
  /** Link ends attach to the module side facing the other end. */
  autoOrientLinks: boolean
  /** Arrange files without editor layout with ELK when opening them. */
  autoLayoutOnOpen: boolean
  /** Keep animations even when the system asks for reduced motion. */
  forceAnimations: boolean
  /** Dots and arrows for the indentation, trailing spaces and tabs of the project text. */
  sourceWhitespace: boolean
  /** The element under the caret of the project text is selected and zoomed to. */
  sourceFollow: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  snapToGrid: false,
  gridSize: 20,
  guides: true,
  edgeStyle: 'bezier',
  portStyle: 'hollow',
  minimap: true,
  edgeBadges: true,
  autoOrientLinks: true,
  autoLayoutOnOpen: true,
  forceAnimations: false,
  sourceWhitespace: true,
  sourceFollow: true
}

export const useSettings = create<Settings>()(
  persist(() => ({ ...DEFAULT_SETTINGS }), {
    name: 'project-scaffold:settings',
    // Settings added later get their default.
    merge: (saved, current) => ({ ...current, ...(saved as Partial<Settings>) }),
    storage: createJSONStorage(() => localStorage)
  })
)

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
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
