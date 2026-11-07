import { useEffect, type RefObject } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'

/** Zoom factor of a double-click. */
const DOUBLE_CLICK_ZOOM = 2

/** WebKit's pinch events (Safari, Tauri on macOS), which send no ctrl+wheel. */
interface GestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

/**
 * Wheel and pointer gestures on the canvas under `ref`: the wheel (or a two-finger scroll) pans,
 * a double-click on the pane zooms in, Ctrl (or Shift) + double-click zooms out, and a pinch zooms
 * in WebKit too. React Flow zooms on Ctrl+wheel, which other browsers also send for a pinch.
 */
export function useTrackpad(ref: RefObject<HTMLElement | null>): void {
  const { getViewport, setViewport } = useReactFlow()
  const store = useStoreApi()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onCanvas = (e: Event): boolean => {
      const target = e.target as Element
      return !!target.closest('.react-flow__renderer') && !target.closest('.nowheel')
    }

    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey || !onCanvas(e)) return
      e.preventDefault()
      e.stopPropagation()
      const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1
      const { x, y, zoom } = getViewport()
      void setViewport({ x: x - e.deltaX * lines, y: y - e.deltaY * lines, zoom })
    }

    const zoomAround = (clientX: number, clientY: number, next: number, duration?: number): void => {
      const pane = el.querySelector('.react-flow')?.getBoundingClientRect()
      if (!pane) return
      const { minZoom, maxZoom } = store.getState()
      const { x, y, zoom } = getViewport()
      next = Math.min(maxZoom, Math.max(minZoom, next))
      // The point under the pointer stays in place.
      const px = clientX - pane.left
      const py = clientY - pane.top
      const k = next / zoom
      void setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next }, { duration })
    }

    const onDoubleClick = (e: MouseEvent): void => {
      if (!(e.target as Element).classList.contains('react-flow__pane')) return
      const out = e.ctrlKey || e.metaKey || e.shiftKey
      const zoom = getViewport().zoom
      zoomAround(e.clientX, e.clientY, out ? zoom / DOUBLE_CLICK_ZOOM : zoom * DOUBLE_CLICK_ZOOM, 200)
    }

    let startZoom = 1
    // Keeps WebKit from zooming the page.
    const onGestureEnd = (e: Event): void => e.preventDefault()
    const onGestureStart = (e: Event): void => {
      e.preventDefault()
      startZoom = getViewport().zoom
    }
    const onGestureChange = (e: Event): void => {
      e.preventDefault()
      if (!onCanvas(e)) return
      const g = e as GestureEvent
      zoomAround(g.clientX, g.clientY, startZoom * g.scale)
    }

    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('dblclick', onDoubleClick)
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    el.addEventListener('gestureend', onGestureEnd)
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('dblclick', onDoubleClick)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('gestureend', onGestureEnd)
    }
  }, [ref, getViewport, setViewport, store])
}
