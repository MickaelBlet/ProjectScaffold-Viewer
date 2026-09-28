// Snap to grid: positions and sizes of modules, notes and imported modules on multiples of the grid.
import { produce } from 'immer'
import { absolutePosition, contentBottom, contentTop, LAYOUT_PAD, minSize } from './project'
import type { Id, Project, Rect } from './types'

export const NOTE_MIN = { width: 80, height: 40 }

export const snapValue = (v: number, grid: number): number => Math.round(v / grid) * grid
export const ceilToGrid = (v: number, grid: number): number => Math.ceil(v / grid - 1e-9) * grid

/**
 * Absolute rect with its edges on the grid, not smaller than `min`; `keep` holds the right (bottom)
 * edge when the minimum wins, as when resizing from the left (top).
 */
export function snapRect(
  r: Rect,
  grid: number,
  min = { width: 0, height: 0 },
  keep: { right?: boolean; bottom?: boolean } = {}
): Rect {
  const axis = (pos: number, size: number, least: number, keepEnd?: boolean): [number, number] => {
    const start = snapValue(pos, grid)
    const end = snapValue(pos + size, grid)
    const s = Math.max(end - start, ceilToGrid(least, grid), grid)
    return keepEnd && end - start < s ? [end - s, s] : [start, s]
  }
  const [x, width] = axis(r.x, r.width, min.width, keep.right)
  const [y, height] = axis(r.y, r.height, min.height, keep.bottom)
  return { x, y, width, height }
}

/**
 * Snap what an edit moved or resized (`next` against `prev`): modules, notes and imported modules.
 * Untouched items keep their place, so that turning the grid on does not move a whole diagram.
 */
export function snapChanges(prev: Project, next: Project, grid: number): Project {
  const modules = new Map(prev.modules.map((m) => [m.id, m]))
  const notes = new Map(prev.notes.map((n) => [n.id, n]))
  const imported = new Map(prev.imports.flatMap((i) => i.modules).map((m) => [m.id, m]))
  /** A resize puts the edges on the grid; a move keeps the size, only rounded up. */
  const place = (r: Rect, before: Rect | undefined, min: { width: number; height: number }): Rect =>
    !before || before.width !== r.width || before.height !== r.height
      ? snapRect(r, grid, min)
      : {
          x: snapValue(r.x, grid),
          y: snapValue(r.y, grid),
          width: ceilToGrid(r.width, grid),
          height: ceilToGrid(r.height, grid)
        }
  const touched = (a: Rect | undefined, b: Rect): boolean =>
    !a || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height
  if (
    next.modules.every((m) => !touched(modules.get(m.id)?.layout, m.layout)) &&
    next.notes.every((n) => !touched(notes.get(n.id)?.layout, n.layout)) &&
    next.imports.every((i) =>
      i.modules.every((m) => {
        const a = imported.get(m.id)?.position
        return a?.x === m.position.x && a.y === m.position.y
      })
    )
  )
    return next

  return produce(next, (d) => {
    const changed: Id[] = []
    // Parents come first: children snap against their parent's final place.
    for (const m of d.modules) {
      const before = modules.get(m.id)
      // Locked modules keep their place.
      if (m.locked || (!touched(before?.layout, m.layout) && before?.parentId === m.parentId)) continue
      changed.push(m.id)
      const parent = m.parentId ? d.modules.find((p) => p.id === m.parentId) : undefined
      const origin = parent ? absolutePosition(d, parent.id) : { x: 0, y: 0 }
      const r = place(
        { ...m.layout, x: origin.x + m.layout.x, y: origin.y + m.layout.y },
        before?.layout,
        minSize(m, d.orientation)
      )
      // Children stay below their parent's header and ports.
      if (parent) {
        r.x = Math.max(r.x, ceilToGrid(origin.x + LAYOUT_PAD / 2, grid))
        r.y = Math.max(r.y, ceilToGrid(origin.y + contentTop(d.orientation), grid))
      }
      m.layout = { ...r, x: r.x - origin.x, y: r.y - origin.y }
    }
    // Parents grown to hold the snapped children, on the grid too.
    for (const id of changed) {
      let child = d.modules.find((m) => m.id === id)
      while (child?.parentId) {
        const parentId: Id = child.parentId
        const parent = d.modules.find((m) => m.id === parentId)
        if (!parent) break
        const width = child.layout.x + child.layout.width + LAYOUT_PAD
        const height = child.layout.y + child.layout.height + contentBottom(d.orientation)
        if (width > parent.layout.width) parent.layout.width = ceilToGrid(width, grid)
        if (height > parent.layout.height) parent.layout.height = ceilToGrid(height, grid)
        child = parent
      }
    }
    for (const n of d.notes) {
      const before = notes.get(n.id)?.layout
      if (!n.locked && touched(before, n.layout)) n.layout = place(n.layout, before, NOTE_MIN)
    }
    for (const m of d.imports.flatMap((i) => i.modules)) {
      const before = imported.get(m.id)?.position
      if (before && before.x === m.position.x && before.y === m.position.y) continue
      m.position = { x: snapValue(m.position.x, grid), y: snapValue(m.position.y, grid) }
    }
  })
}
