// User preferences, kept in localStorage.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Theme = 'system' | 'light' | 'dark'
export type EdgeStyle = 'bezier' | 'smoothstep' | 'step' | 'straight'

export interface Settings {
  theme: Theme
  snapToGrid: boolean
  gridSize: number
  /** Alignment guides and snapping to sibling edges while dragging. */
  guides: boolean
  edgeStyle: EdgeStyle
  minimap: boolean
  edgeBadges: boolean
  /** Link ends attach to the module side facing the other end. */
  autoOrientLinks: boolean
  /** Arrange files without editor layout with ELK when opening them. */
  autoLayoutOnOpen: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  snapToGrid: false,
  gridSize: 20,
  guides: true,
  edgeStyle: 'bezier',
  minimap: true,
  edgeBadges: true,
  autoOrientLinks: true,
  autoLayoutOnOpen: true
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

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
