import { describe, expect, it } from 'vitest'
import {
  anchorPoint,
  insertIndex,
  midpoint,
  nearestAnchor,
  routeThrough,
  snapToNeighbours
} from '@/canvas/linkRoute'

const r = { x: 100, y: 100, width: 200, height: 80 }

describe('anchors', () => {
  it('maps an anchor to the border and back', () => {
    expect(anchorPoint(r, { side: 'bottom', at: 0.25 })).toEqual({ x: 150, y: 180 })
    expect(anchorPoint(r, { side: 'left', at: 0.5 })).toEqual({ x: 100, y: 140 })
    expect(nearestAnchor(r, { x: 150, y: 190 })).toEqual({ side: 'bottom', at: 0.25 })
    expect(nearestAnchor(r, { x: 90, y: 120 })).toEqual({ side: 'left', at: 0.25 })
    expect(nearestAnchor(r, { x: 310, y: 150 }).side).toBe('right')
  })

  it('keeps anchors off the corners', () => {
    const a = nearestAnchor(r, { x: 80, y: 60 })
    expect(a.at).toBeGreaterThan(0)
  })
})

describe('routeThrough', () => {
  const s = { x: 0, y: 0, side: 'right' as const }
  const t = { x: 200, y: 100, side: 'left' as const }

  it('draws a straight polyline through the bends', () => {
    const route = routeThrough('straight', s, t, [{ x: 100, y: 0 }])
    expect(route.path).toBe('M0,0 L100,0 L200,100')
    expect(route.marks).toEqual([0, 1, 2])
  })

  it('makes each bend a corner of a step link', () => {
    const route = routeThrough('step', s, t, [{ x: 100, y: -50 }])
    expect(route.line).toContainEqual({ x: 100, y: -50 })
    // Only horizontal and vertical legs.
    for (let i = 1; i < route.line.length; i++) {
      const [a, b] = [route.line[i - 1]!, route.line[i]!]
      expect(a.x === b.x || a.y === b.y).toBe(true)
    }
    expect(route.line[route.marks[1]!]).toEqual({ x: 100, y: -50 })
    expect(route.line.at(-1)).toEqual({ x: 200, y: 100 })
  })

  it('curves through the bends, leaving square to the side', () => {
    const route = routeThrough('bezier', s, t, [{ x: 100, y: 50 }])
    expect(route.path.startsWith('M0,0 C')).toBe(true)
    const c1 = route.path.split(' ')[1]!.slice(1).split(',').map(Number)
    expect(c1[1]).toBe(0)
    expect(route.line[route.marks[1]!]).toEqual({ x: 100, y: 50 })
  })

  it('finds where a new bend goes', () => {
    const route = routeThrough('straight', s, t, [{ x: 100, y: 0 }])
    expect(insertIndex(route, { x: 50, y: 2 })).toBe(0)
    expect(insertIndex(route, { x: 150, y: 50 })).toBe(1)
  })
})

it('midpoint and neighbour snapping', () => {
  expect(
    midpoint([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ])
  ).toEqual({ x: 10, y: 0 })
  expect(snapToNeighbours({ x: 103, y: 50 }, [{ x: 100, y: 0 }], 5)).toEqual({ x: 100, y: 50 })
})
