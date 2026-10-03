// Geometry of the code editor minimap (`minimap.ts`): one row per line not hidden in a fold, the
// rows scrolled with the editor when they do not all fit, the slider over the rows shown.

/** Lines (from 1) shown as rows: all but those hidden in folds, given as sorted [first, last] ranges. */
export function visibleLines(lineCount: number, hidden: readonly (readonly [number, number])[]): number[] {
  const rows: number[] = []
  let next = 0
  for (let line = 1; line <= lineCount; line++) {
    while (next < hidden.length && hidden[next]![1] < line) next++
    const h = hidden[next]
    if (h && h[0] <= line) {
      line = h[1]
      continue
    }
    rows.push(line)
  }
  return rows
}

/** Row of a line: its own, or the row of the line folding it. */
export function rowOfLine(rows: readonly number[], line: number): number {
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rows[mid]! <= line) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

export interface MapInput {
  rowCount: number
  rowHeight: number
  /** Height of the minimap. */
  mapHeight: number
  /** Rows of the first and last lines in the editor's viewport. */
  firstRow: number
  lastRow: number
  /** The editor's scroller. */
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface MapGeometry {
  /** Minimap scroll: pixels of rows above its top. */
  offset: number
  sliderTop: number
  sliderHeight: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Rows scroll in proportion to the editor when they do not fit; the slider covers the rows in view. */
export function mapGeometry(m: MapInput): MapGeometry {
  const total = m.rowCount * m.rowHeight
  const scrollMax = m.scrollHeight - m.clientHeight
  const ratio = scrollMax > 0 ? clamp(m.scrollTop / scrollMax, 0, 1) : 0
  const offset = total > m.mapHeight ? ratio * (total - m.mapHeight) : 0
  const sliderHeight = Math.min(
    m.mapHeight,
    Math.max(m.rowHeight, (m.lastRow - m.firstRow + 1) * m.rowHeight)
  )
  const sliderTop = clamp(m.firstRow * m.rowHeight - offset, 0, Math.max(0, m.mapHeight - sliderHeight))
  return { offset, sliderTop, sliderHeight }
}

/** Editor scroll for the slider dragged by `dy` pixels. */
export function scrollForDrag(m: MapInput, dy: number): number {
  const total = m.rowCount * m.rowHeight
  if (total <= m.mapHeight) return total > 0 ? (dy * m.scrollHeight) / total : 0
  const { sliderHeight } = mapGeometry(m)
  const track = m.mapHeight - sliderHeight
  return track > 0 ? (dy * (m.scrollHeight - m.clientHeight)) / track : 0
}

/** Row at a height in the minimap. */
export function rowAt(y: number, offset: number, rowHeight: number, rowCount: number): number {
  return clamp(Math.floor((y + offset) / rowHeight), 0, Math.max(0, rowCount - 1))
}

/** Row at a height of the overview ruler, which spans all rows. */
export function rulerRow(y: number, mapHeight: number, rowCount: number): number {
  return mapHeight > 0 ? clamp(Math.floor((y / mapHeight) * rowCount), 0, Math.max(0, rowCount - 1)) : 0
}

/**
 * Tops of section header labels `height` tall at sorted `tops`: each pushed below the one above it,
 * left out (null) when pushed down to the next header.
 */
export function placeLabels(tops: readonly number[], height: number): (number | null)[] {
  let bottom = -Infinity
  return tops.map((top, i) => {
    const at = Math.max(top, bottom)
    const next = tops[i + 1]
    if (next !== undefined && at >= next) return null
    bottom = at + height
    return at
  })
}
