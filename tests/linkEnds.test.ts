import { describe, expect, it } from 'vitest'
import { orientLinkEnds } from '@/canvas/linkEnds'
import type { Rect } from '@/model/types'

/** Module at (x, y), 200 × 100, with its first out port (right) and first in port (left). */
const mod = (
  x: number,
  y: number
): { rect: Rect; out: { x: number; y: number }; in: { x: number; y: number } } => ({
  rect: { x, y, width: 200, height: 100 },
  out: { x: x + 200, y: y + 54 },
  in: { x, y: y + 54 }
})

const link = (a: ReturnType<typeof mod>, b: ReturnType<typeof mod>, row = 0) =>
  orientLinkEnds(
    { rect: a.rect, handle: { x: a.out.x, y: a.out.y + row * 24 } },
    { rect: b.rect, handle: b.in }
  )

describe('orientLinkEnds', () => {
  it('keeps the port sides left to right', () => {
    const { source, target } = link(mod(0, 0), mod(400, 20))
    expect(source).toEqual({ x: 200, y: 54, side: 'right' })
    expect(target).toEqual({ x: 400, y: 74, side: 'left' })
  })

  it('leaves from the facing sides right to left', () => {
    const { source, target } = link(mod(400, 0), mod(0, 0))
    expect([source.side, target.side]).toEqual(['left', 'right'])
  })

  it('links stacked modules straight down through bottom and top', () => {
    const { source, target } = link(mod(0, 0), mod(20, 300))
    expect(source.side).toBe('bottom')
    expect(target.side).toBe('top')
    expect(source.y).toBe(100)
    expect(target.y).toBe(300)
    // Vertical: same x, inside both modules.
    expect(source.x).toBe(target.x)
    expect(source.x).toBeGreaterThan(20)
    expect(source.x).toBeLessThan(200)
  })

  it('goes up from the top when the target is above', () => {
    const { source, target } = link(mod(0, 300), mod(0, 0))
    expect([source.side, target.side]).toEqual(['top', 'bottom'])
    expect([source.y, target.y]).toEqual([300, 100])
  })

  it('spreads links of different ports on the same edge', () => {
    const xs = [0, 1, 2].map((row) => link(mod(0, 0), mod(0, 300), row).source.x)
    expect(new Set(xs).size).toBe(3)
  })

  it('uses top / bottom for diagonal neighbours mostly apart vertically', () => {
    const { source, target } = link(mod(0, 0), mod(260, 400))
    expect([source.side, target.side]).toEqual(['bottom', 'top'])
    expect(source.x).toBeLessThanOrEqual(200)
    expect(target.x).toBeGreaterThanOrEqual(260)
  })

  it('stays on the sides when modules are mostly apart horizontally', () => {
    const { source, target } = link(mod(0, 0), mod(600, 150))
    expect([source.side, target.side]).toEqual(['right', 'left'])
  })
})

describe('orientLinkEnds, vertical orientation', () => {
  /** Module with its first out port (bottom) and first in port (top), each alone on its band. */
  const vmod = (x: number, y: number) => ({
    rect: { x, y, width: 200, height: 92 },
    out: { x: x + 100, y: y + 92 },
    in: { x: x + 100, y }
  })
  const vlink = (a: ReturnType<typeof vmod>, b: ReturnType<typeof vmod>) =>
    orientLinkEnds({ rect: a.rect, handle: a.out }, { rect: b.rect, handle: b.in }, 'vertical')

  it('keeps the port edges top to bottom', () => {
    const { source, target } = vlink(vmod(0, 0), vmod(300, 300))
    expect(source).toEqual({ x: 100, y: 92, side: 'bottom' })
    expect(target).toEqual({ x: 400, y: 300, side: 'top' })
  })

  it('leaves from the facing edges bottom to top', () => {
    const { source, target } = vlink(vmod(0, 400), vmod(300, 0))
    expect([source.side, target.side]).toEqual(['top', 'bottom'])
  })

  it('links modules side by side straight across', () => {
    const { source, target } = vlink(vmod(0, 0), vmod(400, 10))
    expect([source.side, target.side]).toEqual(['right', 'left'])
    expect(source.y).toBe(target.y)
    expect([source.x, target.x]).toEqual([200, 400])
  })
})
