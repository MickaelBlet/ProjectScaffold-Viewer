import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { defaultConstraints, emptyProject } from '@/model/project'
import { facingSide, floatingPortSides, neededHeight, portsOn, type StandIn } from '@/canvas/portSides'
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

  it('floats container ports, except those linked to their content', () => {
    const p = produce(project(0, 300), (d) => {
      d.modules.push(mod('C', 10, 90, [port('c_in', 'in')], 'B'))
      d.links.push({
        id: 'l3',
        name: 'l3',
        description: '',
        from: { moduleId: 'B', portId: 'b_in' },
        to: { moduleId: 'C', portId: 'c_in' },
        constraints: defaultConstraints()
      })
    })
    // b_in feeds C: kept on its edge; b_cmd faces A above.
    expect(floatingPortSides(p, all(p)).get('B')).toMatchObject({
      b_in: { side: 'left' },
      b_cmd: { side: 'top' }
    })
  })

  it('leaves hidden ends alone', () => {
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

  it('orders side ports so that links do not cross', () => {
    // A.a_out → B.b_in with B.b_in second on its edge: a_out goes below a_in on A's right side.
    const p = produce(project(500, 0), (d) => {
      d.modules[1]!.ports.unshift(port('b_extra', 'in'))
      d.links.push({
        id: 'l3',
        name: 'l3',
        description: '',
        from: { moduleId: 'A', portId: 'a_free' },
        to: { moduleId: 'B', portId: 'b_extra' },
        constraints: defaultConstraints()
      })
    })
    const a = floatingPortSides(p, all(p)).get('A')!
    // b_extra, b_in, b_cmd on B's left edge, top to bottom.
    expect(portsOn(p.modules[0]!.ports, a, 'right').map((x) => x.id)).toEqual(['a_free', 'a_out', 'a_in'])
  })

  it('turns ports towards the stand-ins of outside modules', () => {
    const p = project(500, 0)
    // B drawn as a stand-in on the right of A, its ports in reverse order.
    const standIns = new Map<string, StandIn>([
      ['B', { rect: { x: 300, y: 0, width: 180, height: 82 }, side: 'left', ports: ['b_cmd', 'b_in'] }]
    ])
    const a = floatingPortSides(p, new Set(['A']), standIns).get('A')!
    expect(a).toMatchObject({ a_in: { side: 'right' }, a_out: { side: 'right' } })
    expect(portsOn(p.modules[0]!.ports, a, 'right').map((x) => x.id)).toEqual(['a_in', 'a_out', 'a_free'])
  })
})
