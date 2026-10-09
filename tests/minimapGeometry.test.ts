import { describe, expect, it } from 'vitest'
import {
  mapGeometry,
  placeLabels,
  rowAt,
  rowOfLine,
  rulerRow,
  scrollbarThumb,
  scrollForDrag,
  visibleLines,
  wrapColumns,
  type MapInput
} from '@/components/minimapGeometry'

describe('minimap rows', () => {
  it('skips lines hidden in folds', () => {
    expect(visibleLines(6, [])).toEqual([1, 2, 3, 4, 5, 6])
    expect(
      visibleLines(8, [
        [2, 3],
        [6, 7]
      ])
    ).toEqual([1, 4, 5, 8])
    expect(visibleLines(3, [[2, 3]])).toEqual([1])
  })

  it('maps a hidden line to the row of the line folding it', () => {
    const rows = [1, 4, 5, 8]
    expect(rowOfLine(rows, 1)).toBe(0)
    expect(rowOfLine(rows, 3)).toBe(0)
    expect(rowOfLine(rows, 5)).toBe(2)
    expect(rowOfLine(rows, 9)).toBe(3)
  })

  it('maps a wrapped line to its first row', () => {
    const rows = [1, 2, 2, 2, 3, 5, 5]
    expect(rowOfLine(rows, 1)).toBe(0)
    expect(rowOfLine(rows, 2)).toBe(1)
    expect(rowOfLine(rows, 3)).toBe(4)
    expect(rowOfLine(rows, 4)).toBe(4)
    expect(rowOfLine(rows, 5)).toBe(5)
    expect(rowOfLine(rows, 6)).toBe(5)
  })

  it('wraps lines after spaces, else anywhere', () => {
    expect(wrapColumns('short', 10, 2)).toEqual([0])
    expect(wrapColumns('long line', 0, 2)).toEqual([0])
    expect(wrapColumns('aaaa bbbb cccc', 10, 2)).toEqual([0, 10])
    expect(wrapColumns('aaaa bbbbbb', 8, 2)).toEqual([0, 5])
    expect(wrapColumns('abcdefghij', 4, 2)).toEqual([0, 4, 8])
    expect(wrapColumns('\tab cd', 4, 4)).toEqual([0, 4, 7])
  })
})

const input = (m: Partial<MapInput>): MapInput => ({
  rowCount: 100,
  rowHeight: 2,
  mapHeight: 400,
  firstRow: 0,
  lastRow: 19,
  scrollTop: 0,
  scrollHeight: 2000,
  clientHeight: 400,
  ...m
})

describe('minimap geometry', () => {
  it('does not scroll rows that fit', () => {
    const g = mapGeometry(input({ firstRow: 50, lastRow: 69, scrollTop: 1000 }))
    expect(g).toEqual({ offset: 0, sliderTop: 100, sliderHeight: 40 })
  })

  it('scrolls rows that do not fit in proportion to the editor', () => {
    const m = input({ rowCount: 1000, scrollHeight: 20400 })
    expect(mapGeometry(m).offset).toBe(0)
    const end = mapGeometry({ ...m, scrollTop: 20000, firstRow: 980, lastRow: 999 })
    expect(end.offset).toBe(1600)
    expect(end.sliderTop + end.sliderHeight).toBe(400)
    const mid = mapGeometry({ ...m, scrollTop: 10000, firstRow: 490, lastRow: 509 })
    expect(mid.offset).toBe(800)
    expect(mid.sliderTop).toBe(180)
  })

  it('keeps the slider inside the minimap', () => {
    const g = mapGeometry(input({ firstRow: 99, lastRow: 99, mapHeight: 100 }))
    expect(g.sliderTop + g.sliderHeight).toBeLessThanOrEqual(100)
  })

  it('converts slider drags to editor scroll', () => {
    expect(scrollForDrag(input({}), 20)).toBe(200)
    const m = input({ rowCount: 1000, scrollHeight: 20400 })
    expect(scrollForDrag(m, 36)).toBe(2000)
  })

  it('finds rows under the pointer', () => {
    expect(rowAt(11, 0, 2, 100)).toBe(5)
    expect(rowAt(11, 100, 2, 100)).toBe(55)
    expect(rowAt(1000, 0, 2, 100)).toBe(99)
    expect(rulerRow(200, 400, 1000)).toBe(500)
    expect(rulerRow(400, 400, 1000)).toBe(999)
  })
})

describe('minimap section labels', () => {
  it('keeps labels apart', () => {
    expect(placeLabels([0, 40, 100], 10)).toEqual([0, 40, 100])
    expect(placeLabels([0, 4, 100], 10)).toEqual([0, 10, 100])
    expect(placeLabels([0, 4, 8, 12], 10)).toEqual([0, null, 10, 20])
  })
})

describe('scrollbar thumb', () => {
  it('spans the track in proportion to the view', () => {
    expect(scrollbarThumb(400, 0, 400, 400, 10)).toEqual([0, 400])
    expect(scrollbarThumb(400, 0, 1600, 400, 10)).toEqual([0, 100])
    expect(scrollbarThumb(400, 1200, 1600, 400, 10)).toEqual([300, 100])
    expect(scrollbarThumb(400, 50000, 100400, 400, 10)).toEqual([195, 10])
  })
})
