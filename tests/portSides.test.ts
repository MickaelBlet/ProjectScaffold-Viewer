import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { defaultConstraints, emptyProject } from '@/model/project'
import { facingSide, floatingPortSides, neededHeight, portsOn } from '@/canvas/portSides'
import type { Module, Project } from '@/model/types'

const mod = (
  id: string,
  x: number,
  y: number,
  ports: Module['ports'],
  parentId: string | null = null
): Module => ({
  id,
  name: id,
  description: '',
  parentId,
  metadata: {},
  ports,
  layout: { x, y, width: 200, height: 72 }
})
const port = (id: string, role: 'in' | 'out') => ({ id, name: id, role, interfaceId: null, description: '' })

/** A.out → B.in and B.cmd → A.in, with B at (bx, by). */
function project(bx: number, by: number): Project {
  return produce(emptyProject(), (d) => {
    d.modules = [
      mod('A', 0, 0, [port('a_in', 'in'), port('a_out', 'out'), port('a_free', 'out')]),
      mod('B', bx, by, [port('b_in', 'in'), port('b_cmd', 'out')])
    ]
    d.links = [
      {
        id: 'l1',
        name: 'l1',
        description: '',
        from: { moduleId: 'A', portId: 'a_out' },
        to: { moduleId: 'B', portId: 'b_in' },
        constraints: defaultConstraints()
      },
      {
        id: 'l2',
        name: 'l2',
        description: '',
        from: { moduleId: 'B', portId: 'b_cmd' },
        to: { moduleId: 'A', portId: 'a_in' },
        constraints: defaultConstraints()
      }
    ]
  })
}
const all = (p: Project) => new Set(p.modules.map((m) => m.id))

describe('facingSide', () => {
  const a = { x: 0, y: 0, width: 200, height: 72 }
  it('uses top / bottom for stacked modules, sides otherwise (horizontal)', () => {
    expect(facingSide(a, { x: 20, y: 300, width: 200, height: 72 }, 'horizontal')).toBe('bottom')
    expect(facingSide(a, { x: 20, y: -300, width: 200, height: 72 }, 'horizontal')).toBe('top')
    expect(facingSide(a, { x: 400, y: 10, width: 200, height: 72 }, 'horizontal')).toBe('right')
    expect(facingSide(a, { x: -400, y: 10, width: 200, height: 72 }, 'horizontal')).toBe('left')
  })
  it('mirrors in vertical orientation', () => {
    expect(facingSide(a, { x: 400, y: 10, width: 200, height: 72 }, 'vertical')).toBe('right')
    expect(facingSide(a, { x: 20, y: 300, width: 200, height: 72 }, 'vertical')).toBe('bottom')
  })
})

describe('floatingPortSides', () => {
  it('moves linked ports of stacked modules to the facing edges', () => {
    const sides = floatingPortSides(project(0, 300), all(project(0, 300)))
    expect(sides.get('A')).toMatchObject({
      a_in: { side: 'bottom' },
      a_out: { side: 'bottom' },
      a_free: { side: 'right' }
    })
    expect(sides.get('B')).toMatchObject({ b_in: { side: 'top' }, b_cmd: { side: 'top' } })
  })

  it('keeps the default sides left to right', () => {
    const sides = floatingPortSides(project(500, 0), all(project(500, 0)))
    expect(sides.get('A')).toMatchObject({ a_in: { side: 'right' }, a_out: { side: 'right' } })
    expect(sides.get('B')).toMatchObject({ b_in: { side: 'left' }, b_cmd: { side: 'left' } })
  })

  it('leaves containers and hidden ends alone', () => {
    const p = produce(project(0, 300), (d) => void d.modules.push(mod('C', 10, 90, [], 'B')))
    expect(floatingPortSides(p, all(p)).has('B')).toBe(false)
    const hidden = floatingPortSides(project(0, 300), new Set(['A']))
    expect(hidden.get('A')).toMatchObject({ a_in: { side: 'left' }, a_out: { side: 'right' } })
  })

  it('orders band ports and sizes the module', () => {
    const p = project(0, 300)
    const placements = floatingPortSides(p, all(p)).get('A')!
    const ports = p.modules[0]!.ports
    // l1 (a_out → b_in) comes before l2 (b_cmd → a_in): same order on both bands, no crossing.
    expect(portsOn(ports, placements, 'bottom').map((x) => x.id)).toEqual(['a_out', 'a_in'])
    const b = floatingPortSides(p, all(p)).get('B')!
    expect(portsOn(p.modules[1]!.ports, b, 'top').map((x) => x.id)).toEqual(['b_in', 'b_cmd'])
    // Header, one band, one row (a_free on the right).
    expect(neededHeight(ports, placements)).toBe(36 + 24 + 24 + 12)
  })
})
