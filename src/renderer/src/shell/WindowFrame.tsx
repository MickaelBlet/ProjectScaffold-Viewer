import { useEffect, useState, type PointerEvent, type ReactNode } from 'react'
import type { ResizeEdge } from '@/api'
import { Icon } from '@/components/Icon'
import { tauriDesktop } from '@/tauriDesktop'

const desktop = window.desktop ?? tauriDesktop
const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** Tracks the maximized state; also sets data-frame on the root element for the window styles. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!desktop) return
    void desktop.isMaximized().then(setMaximized)
    return desktop.onMaximizedChange(setMaximized)
  }, [])
  useEffect(() => {
    if (desktop) document.documentElement.dataset.frame = maximized ? 'maximized' : 'frameless'
  }, [maximized])
  return maximized
}

/** Minimize, maximize/restore and close buttons of the frameless desktop window. */
export function WindowControls(): ReactNode {
  const maximized = useMaximized()
  if (!desktop) return null
  return (
    <div className="window-controls">
      <button type="button" title="Minimize" onClick={() => desktop.minimize()}>
        <Icon name="minimize" />
      </button>
      <button
        type="button"
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => desktop.toggleMaximize()}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} />
      </button>
      <button type="button" className="close" title="Close" onClick={() => desktop.close()}>
        <Icon name="x" />
      </button>
    </div>
  )
}

function startResize(edge: ResizeEdge, e: PointerEvent<HTMLDivElement>): void {
  if (!desktop?.resize || e.button !== 0) return
  const target = e.currentTarget
  const { screenX, screenY, pointerId } = e
  target.setPointerCapture(pointerId)
  desktop.resizeStart?.()
  const onMove = (ev: globalThis.PointerEvent): void =>
    desktop.resize?.(edge, ev.screenX - screenX, ev.screenY - screenY)
  const onUp = (): void => {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    target.removeEventListener('lostpointercapture', onUp)
  }
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('lostpointercapture', onUp)
  e.preventDefault()
}

/** Resize handles along the borders of the frameless desktop window. */
export function ResizeEdges(): ReactNode {
  const maximized = useMaximized()
  if (!desktop?.resize || maximized) return null
  return EDGES.map((edge) => (
    <div key={edge} className={`resize-edge ${edge}`} onPointerDown={(e) => startResize(edge, e)} />
  ))
}
