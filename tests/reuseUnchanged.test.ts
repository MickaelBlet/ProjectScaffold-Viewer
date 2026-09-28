import { describe, expect, it } from 'vitest'
import { reuseUnchanged } from '@/canvas/reuseUnchanged'

describe('reuseUnchanged', () => {
  const a = { id: 'a', position: { x: 0, y: 0 }, data: { anchors: {} }, measured: { width: 10 } }
  const b = { id: 'b', position: { x: 5, y: 5 }, data: { anchors: {} } }

  it('returns the previous list when nothing changed', () => {
    const prev = [a, b]
    expect(reuseUnchanged(prev, [structuredClone(b), structuredClone(a)].reverse())).toBe(prev)
  })

  it('keeps unchanged items and fields added outside (measured)', () => {
    const moved = { id: 'b', position: { x: 6, y: 5 }, data: { anchors: {} } }
    const next = reuseUnchanged([a, b], [{ id: 'a', position: { x: 0, y: 0 }, data: { anchors: {} } }, moved])
    expect(next[0]).toBe(a)
    expect(next[1]).toBe(moved)
  })

  it('takes new, removed and reordered items', () => {
    expect(reuseUnchanged([a, b], [b])).toEqual([b])
    expect(reuseUnchanged([a], [a, b])[1]).toBe(b)
    expect(reuseUnchanged([a, b], [b, a])).toEqual([b, a])
  })
})
