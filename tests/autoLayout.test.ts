import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { arrange } from '@/model/autoLayout'
import { childModules } from '@/model/project'
import type { Project, Rect } from '@/model/types'

const example = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))

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

  it('arranges horizontally again', async () => {
    const v = await arrange(example, null, { orientation: 'vertical', spacing: 70 })
    const h = await arrange(v, null, { orientation: 'horizontal', spacing: 70 })
    expect(h.orientation).toBe('horizontal')
    checkNoOverlap(h)
    checkChildrenInside(h)
  })
})
