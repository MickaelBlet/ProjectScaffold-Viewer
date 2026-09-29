// Window controls of the Tauri app (decorations off): the same Desktop API as the Electron preload.
// Tauri resizes undecorated windows from their borders itself, so there are no page resize edges.
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Desktop } from '@/api'

function create(): Desktop {
  const win = getCurrentWindow()
  return {
    minimize: () => void win.minimize(),
    toggleMaximize: () => void win.toggleMaximize(),
    close: () => void win.close(),
    isMaximized: () => win.isMaximized(),
    onMaximizedChange(cb) {
      let active = true
      const unlisten = win.onResized(() => {
        void win.isMaximized().then((maximized) => active && cb(maximized))
      })
      return () => {
        active = false
        void unlisten.then((f) => f())
      }
    }
  }
}

/** The window controls, undefined outside Tauri. */
export const tauriDesktop: Desktop | undefined = isTauri() ? create() : undefined
