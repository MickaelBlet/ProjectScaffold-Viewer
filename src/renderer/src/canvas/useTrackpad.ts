import { useEffect, type RefObject } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'

/** A trackpad scroll goes on panning until it pauses this long (ms). */
const SCROLL_PAUSE = 200

/** Wheel events of Blink and WebKit carry the legacy `wheelDeltaY` too. */
interface LegacyWheelEvent extends WheelEvent {
  wheelDeltaY?: number
}

/**
 * Precise scrolling (trackpad, Magic Mouse) in Blink and WebKit: its legacy delta is exactly -3 times
 * the delta, a notched wheel's is a multiple of 120.
 */
const isPrecise = (e: LegacyWheelEvent): boolean =>
  e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && e.deltaY !== 0 && e.wheelDeltaY === -3 * e.deltaY

/** WebKit's pinch events (Safari, Tauri on macOS), which send no ctrl+wheel. */
interface GestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

/**
 * Trackpad gestures React Flow leaves out, on the canvas under `ref`: a two-finger scroll pans
 * (a mouse wheel, vertical only, still zooms), and a pinch zooms in WebKit too. React Flow zooms
 * on the ctrl+wheel other browsers send for a pinch.
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

    let scrollUntil = 0
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || !onCanvas(e)) return
      // A precise or horizontal move starts a trackpad scroll (or Shift+wheel), vertical moves of it
      // pan too. Elsewhere (Firefox, some Windows and Linux trackpads) a vertical-only start zooms.
      if (e.deltaX === 0 && !isPrecise(e) && e.timeStamp > scrollUntil) return
      scrollUntil = e.timeStamp + SCROLL_PAUSE
      e.preventDefault()
      e.stopPropagation()
      const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1
      const { x, y, zoom } = getViewport()
      void setViewport({ x: x - e.deltaX * lines, y: y - e.deltaY * lines, zoom })
    }

    let startZoom = 1
    let pane: DOMRect | undefined
    // Keeps WebKit from zooming the page.
    const onGestureEnd = (e: Event): void => e.preventDefault()
    const onGestureStart = (e: Event): void => {
      e.preventDefault()
      startZoom = getViewport().zoom
      // The pane does not move during the gesture: measured once.
      pane = el.querySelector('.react-flow')?.getBoundingClientRect()
    }
    const onGestureChange = (e: Event): void => {
      e.preventDefault()
      if (!onCanvas(e)) return
      const g = e as GestureEvent
      if (!pane) return
      const { minZoom, maxZoom } = store.getState()
      const { x, y, zoom } = getViewport()
      const next = Math.min(maxZoom, Math.max(minZoom, startZoom * g.scale))
      // The point under the fingers stays in place.
      const px = g.clientX - pane.left
      const py = g.clientY - pane.top
      const k = next / zoom
      void setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next })
    }

    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    el.addEventListener('gestureend', onGestureEnd)
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
      el.removeEventListener('gestureend', onGestureEnd)
    }
  }, [ref, getViewport, setViewport, store])
}
