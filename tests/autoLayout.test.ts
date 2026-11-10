import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fromFile, parseText } from '@/model/serialize'
import { arrange, crossings, relations } from '@/model/autoLayout'
import { boundsOf, childModules, contentBottom, contentTop, LAYOUT_PAD } from '@/model/project'
import type { Module, Project, Rect } from '@/model/types'

const example = fromFile(parseText(readFileSync('examples/robot.scaffold', 'utf8'), 'dsl'))

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

function checkNoOverlap(p: Project): void {
  for (const parentId of [null, ...p.modules.map((m) => m.id)]) {
    const siblings = childModules(p, parentId)
    for (const [i, a] of siblings.entries())
      for (const b of siblings.slice(i + 1))
        expect(overlap(a.layout, b.layout), `${a.name} / ${b.name}`).toBe(false)
  }
}

function checkChildrenInside(p: Project): void {
  for (const m of p.modules) {
    const parent = p.modules.find((x) => x.id === m.parentId)
    if (!parent) continue
    expect(m.layout.x).toBeGreaterThanOrEqual(0)
    expect(m.layout.y).toBeGreaterThanOrEqual(0)
    expect(m.layout.x + m.layout.width).toBeLessThanOrEqual(parent.layout.width)
    expect(m.layout.y + m.layout.height).toBeLessThanOrEqual(parent.layout.height)
  }
}

describe('autoLayout', () => {
  it('arranges the whole project without overlaps', async () => {
    const p = await arrange(example, null)
    checkNoOverlap(p)
    checkChildrenInside(p)
    expect(p.modules.map((m) => m.name)).toEqual(example.modules.map((m) => m.name))
  })

  it('arranges the content of one module only', async () => {
    const core = example.modules.find((m) => m.name === 'Core')!
    const p = await arrange(example, core.id)
    checkNoOverlap(p)
    checkChildrenInside(p)
    for (const m of p.modules.filter((m) => !m.parentId && m.id !== core.id))
      expect(m.layout).toEqual(example.modules.find((x) => x.id === m.id)!.layout)
  })

  it('fits each container to its content', async () => {
    const drone = fromFile(parseText(readFileSync('examples/fleet/drone.scaffold', 'utf8'), 'dsl'))
    for (const o of ['horizontal', 'vertical'] as const) {
      const p = await arrange(drone, null, { orientation: o, spacing: 70 })
      for (const m of p.modules) {
        const content = childModules(p, m.id)
        if (!content.length) continue
        const b = boundsOf(content.map((c) => c.layout))
        expect(b.y, m.name).toBe(contentTop(o, m) + LAYOUT_PAD / 2)
        expect(m.layout.height - b.y - b.height, m.name).toBe(contentBottom(o))
        if (o === 'vertical') expect(m.layout.width - b.width, m.name).toBe(2 * LAYOUT_PAD)
      }
    }
  })

  it('fits the arranged container to its new content', async () => {
    const core = example.modules.find((m) => m.name === 'Core')!
    const big = {
      ...example,
      modules: example.modules.map((m) =>
        m.id === core.id ? { ...m, layout: { ...m.layout, width: 3000, height: 3000 } } : m
      )
    }
    const p = await arrange(big, core.id)
    const layout = p.modules.find((m) => m.id === core.id)!.layout
    expect(layout.width).toBeLessThan(3000)
    expect(layout.height).toBeLessThan(3000)
    checkChildrenInside(p)
  })

  it('handles an empty project', async () => {
    const p = await arrange({ ...example, modules: [], links: [] }, null)
    expect(p.modules).toEqual([])
  })
})

describe('autoLayout, vertical', () => {
  it('moves ports to top / bottom and layers downwards', async () => {
    const p = await arrange(example, null, { orientation: 'vertical', spacing: 70 })
    expect(p.orientation).toBe('vertical')
    checkNoOverlap(p)
    checkChildrenInside(p)
    const byName = (n: string) => p.modules.find((m) => m.name === n)!.layout
    // Sensor sends to Controller and Logger: they are below it.
    expect(byName('Controller').y).toBeGreaterThan(byName('Sensor').y + byName('Sensor').height)
    expect(byName('Logger').y).toBeGreaterThan(byName('Sensor').y + byName('Sensor').height)
  })

  it('centers each layer on its container axis', async () => {
    const p = await arrange(example, null, { orientation: 'vertical', spacing: 70 })
    const byName = (n: string) => p.modules.find((m) => m.name === n)!.layout
    const center = (r: Rect): number => r.x + r.width / 2
    const [sensor, logger, controller] = ['Sensor', 'Logger', 'Controller'].map(byName)
    const row =
      Math.min(logger!.x, controller!.x) +
      Math.max(logger!.x + logger!.width, controller!.x + controller!.width)
    expect(center(sensor!)).toBeCloseTo(row / 2, 0)
  })

  it('arranges horizontally again', async () => {
    const v = await arrange(example, null, { orientation: 'vertical', spacing: 70 })
    const h = await arrange(v, null, { orientation: 'horizontal', spacing: 70 })
    expect(h.orientation).toBe('horizontal')
    checkNoOverlap(h)
    checkChildrenInside(h)
  })
})

describe('autoLayout, relations', () => {
  const template = example.modules.find((m) => !childModules(example, m.id).length)!
  const leaf = (id: string, extra: Partial<Module> = {}): Module => ({
    ...template,
    id,
    name: id,
    parentId: null,
    ports: [],
    attributes: [],
    methods: [],
    bases: undefined,
    ...extra
  })
  // Two modules derive from Base; Car holds a Wheel.
  const project: Project = {
    ...example,
    links: [],
    modules: [
      leaf('Car', {
        bases: ['Base'],
        attributes: [{ id: 'wheel', name: 'wheel', description: '', type: { kind: 'ref', id: 'Wheel' } }]
      }),
      leaf('Wheel'),
      leaf('Bike', { bases: ['Base'] }),
      leaf('Base')
    ]
  }

  it('lists inheritance and association lines, once per pair', () => {
    expect(relations(project, new Set(project.modules.map((m) => m.id)))).toEqual([
      { from: 'Base', to: 'Car' },
      { from: 'Base', to: 'Bike' },
      { from: 'Car', to: 'Wheel' }
    ])
  })

  it('places bases and modules holding attributes first along the flow', async () => {
    for (const o of ['horizontal', 'vertical'] as const) {
      const p = await arrange(project, null, { orientation: o, spacing: 70 })
      checkNoOverlap(p)
      const at = (n: string): Rect => p.modules.find((m) => m.id === n)!.layout
      const end = (r: Rect): number => (o === 'vertical' ? r.y + r.height : r.x + r.width)
      const start = (r: Rect): number => (o === 'vertical' ? r.y : r.x)
      expect(start(at('Car')), o).toBeGreaterThan(end(at('Base')))
      expect(start(at('Bike')), o).toBeGreaterThan(end(at('Base')))
      expect(start(at('Wheel')), o).toBeGreaterThan(end(at('Car')))
    }
  })

  it('counts crossings between lines of different modules', () => {
    const x = { from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, ends: ['a', 'b'] as [string, string] }
    const y = { from: { x: 0, y: 10 }, to: { x: 10, y: 0 }, ends: ['c', 'd'] as [string, string] }
    expect(crossings([x, y])).toBe(1)
    expect(crossings([x, { ...y, ends: ['a', 'd'] }])).toBe(0)
    expect(crossings([x, { ...y, to: { x: 4, y: 6 } }])).toBe(0)
  })
})
