import type { DockviewTheme } from 'dockview-react'

/** Dockview colors come from the app tokens (styles.css), so both follow the light / dark theme. */
export const dockTheme: DockviewTheme = {
  name: 'scaffold',
  className: 'dockview-theme-scaffold',
  gap: 0,
  dndOverlayMounting: 'absolute',
  dndPanelOverlay: 'group'
}
