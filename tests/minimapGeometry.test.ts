import { describe, expect, it } from 'vitest'
import {
  mapGeometry,
  rowAt,
  rowOfLine,
  rulerRow,
  scrollForDrag,
  visibleLines,
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
