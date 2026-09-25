// Where a link attaches to its modules when link ends are auto-oriented.
import { MODULE_HEADER, PORT_ROW } from '@/model/project'
import type { Orientation, Rect } from '@/model/types'

export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface LinkEnd {
  x: number
  y: number
  side: Side
}

interface EndInput {
  /** Absolute rect of the module. */
  rect: Rect
  /** Port handle, where the link attaches by default. */
  handle: { x: number; y: number }
}

/** Keeps attachments away from the rounded corners. */
const MARGIN = 14
/** Horizontal gap between links of different ports leaving the same edge. */
const SPREAD = 16

const clamp = (v: number, lo: number, hi: number): number =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v))
const centerX = (r: Rect): number => r.x + r.width / 2

/** 0, +1, -1, +2, -2… for port rows 0, 1, 2, 3, 4… so links of one module fan out around a point. */
function rowOffset(e: EndInput): number {
  const row = Math.max(0, Math.round((e.handle.y - e.rect.y - MODULE_HEADER - 6 - PORT_ROW / 2) / PORT_ROW))
  return (row % 2 ? 1 : -1) * Math.ceil(row / 2) * SPREAD
}

/** Ports along a band (vertical orientation, transposed): their distance to the band's middle. */
function bandOffset(e: EndInput): number {
  return Math.round(((e.handle.y - (e.rect.y + e.rect.height / 2)) / e.rect.height) * 4) * SPREAD
}

const transposeRect = (r: Rect): Rect => ({ x: r.y, y: r.x, width: r.height, height: r.width })
const transposeInput = (e: EndInput): EndInput => ({
  rect: transposeRect(e.rect),
  handle: { x: e.handle.y, y: e.handle.x }
})
const TRANSPOSED: Record<Side, Side> = { left: 'top', right: 'bottom', top: 'left', bottom: 'right' }
const transposeEnd = (e: LinkEnd): LinkEnd => ({ x: e.y, y: e.x, side: TRANSPOSED[e.side] })

/**
 * Attachments of a link from `source` (an out port) to `target` (an in port). Horizontal
 * orientation (out ports on the right, in ports on the left): modules one above the other are linked through their facing top / bottom edges, straight
 * down when they overlap horizontally; otherwise each end leaves from the facing left / right side
 * at its port's height. Vertical orientation mirrors this: modules side by side use their facing
 * left / right edges, otherwise the facing bottom / top edges at the port's position.
 */
export function orientLinkEnds(
  source: EndInput,
  target: EndInput,
  orientation: Orientation = 'horizontal'
): { source: LinkEnd; target: LinkEnd } {
  // Vertical: out ports at the bottom, in ports on top; the same rules on swapped axes.
  if (orientation === 'vertical') {
    const ends = orient(transposeInput(source), transposeInput(target), bandOffset)
    return { source: transposeEnd(ends.source), target: transposeEnd(ends.target) }
  }
  return orient(source, target, rowOffset)
}

function orient(
  source: EndInput,
  target: EndInput,
  portOffset: (e: EndInput) => number
): { source: LinkEnd; target: LinkEnd } {
  const s = source.rect
  const t = target.rect
  const below = t.y >= s.y + s.height
  const vGap = below ? t.y - (s.y + s.height) : s.y - (t.y + t.height)
  const hGap = Math.max(t.x - (s.x + s.width), s.x - (t.x + t.width))

  if (vGap > 0 && vGap >= hGap) {
    const lo = Math.max(s.x, t.x) + MARGIN
    const hi = Math.min(s.x + s.width, t.x + t.width) - MARGIN
    let sx: number
    let tx: number
    if (lo <= hi) {
      // Overlapping columns: a vertical link, shifted per port so parallel links stay apart.
      sx = tx = clamp((lo + hi) / 2 + portOffset(source), lo, hi)
    } else {
      sx = clamp(centerX(t) + portOffset(source), s.x + MARGIN, s.x + s.width - MARGIN)
      tx = clamp(centerX(s) + portOffset(target), t.x + MARGIN, t.x + t.width - MARGIN)
    }
    return {
      source: { x: sx, y: below ? s.y + s.height : s.y, side: below ? 'bottom' : 'top' },
      target: { x: tx, y: below ? t.y : t.y + t.height, side: below ? 'top' : 'bottom' }
    }
  }

  const sourceLeft = centerX(t) < centerX(s) && target.handle.x < centerX(s)
  const targetRight = centerX(s) > centerX(t) && source.handle.x > centerX(t)
  return {
    source: { x: sourceLeft ? s.x : s.x + s.width, y: source.handle.y, side: sourceLeft ? 'left' : 'right' },
    target: { x: targetRight ? t.x + t.width : t.x, y: target.handle.y, side: targetRight ? 'right' : 'left' }
  }
}
