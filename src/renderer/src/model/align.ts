// Alignment and distribution of rects (absolute coordinates).
import type { Id, Rect } from './types'

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** New absolute positions aligning the rects on the selection's bounds. */
export function align(rects: Map<Id, Rect>, mode: AlignMode): Map<Id, Rect> {
  const all = [...rects.values()]
  const left = Math.min(...all.map((r) => r.x))
  const right = Math.max(...all.map((r) => r.x + r.width))
  const top = Math.min(...all.map((r) => r.y))
  const bottom = Math.max(...all.map((r) => r.y + r.height))
  const out = new Map<Id, Rect>()
  for (const [id, r] of rects) {
    const n = { ...r }
    if (mode === 'left') n.x = left
    if (mode === 'right') n.x = right - r.width
    if (mode === 'hcenter') n.x = (left + right) / 2 - r.width / 2
    if (mode === 'top') n.y = top
    if (mode === 'bottom') n.y = bottom - r.height
    if (mode === 'vcenter') n.y = (top + bottom) / 2 - r.height / 2
    out.set(id, n)
  }
  return out
}

/** Equal gaps between the rects along an axis, keeping the outermost ones in place. */
export function distribute(rects: Map<Id, Rect>, axis: 'h' | 'v'): Map<Id, Rect> {
  const pos = axis === 'h' ? 'x' : 'y'
  const size = axis === 'h' ? 'width' : 'height'
  const sorted = [...rects.entries()].sort(([, a], [, b]) => a[pos] - b[pos])
  const out = new Map<Id, Rect>(sorted.map(([id, r]) => [id, { ...r }]))
  if (sorted.length < 3) return out
  const first = sorted[0]![1]
  const last = sorted.at(-1)![1]
  const total = sorted.reduce((s, [, r]) => s + r[size], 0)
  const gap = (last[pos] + last[size] - first[pos] - total) / (sorted.length - 1)
  let cursor = first[pos]
  for (const [id, r] of sorted) {
    out.get(id)![pos] = cursor
    cursor += r[size] + gap
  }
  return out
}

/** Give every rect the size of the largest one. */
export function sameSize(rects: Map<Id, Rect>, dim: 'width' | 'height' | 'both'): Map<Id, Rect> {
  const all = [...rects.values()]
  const w = Math.max(...all.map((r) => r.width))
  const h = Math.max(...all.map((r) => r.height))
  const out = new Map<Id, Rect>()
  for (const [id, r] of rects)
    out.set(id, { ...r, width: dim !== 'height' ? w : r.width, height: dim !== 'width' ? h : r.height })
  return out
}
