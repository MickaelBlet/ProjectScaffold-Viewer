import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { snapChanges, snapRect } from '@/model/grid'
import { absolutePosition, modulePath } from '@/model/project'

const example = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const byPath = (path: string) => example.modules.find((m) => modulePath(example, m.id) === path)!
const onGrid = (v: number): boolean => v % 20 === 0

describe('grid', () => {
  it('puts both edges of a rect on the grid, keeping its minimum size', () => {
    expect(snapRect({ x: 13, y: 47, width: 151, height: 33 }, 20)).toEqual({
      x: 20,
      y: 40,
      width: 140,
      height: 40
    })
    expect(snapRect({ x: 0, y: 0, width: 30, height: 30 }, 20, { width: 50, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 40
    })
    // Resizing from the left: the right edge stays when the minimum wins.
    expect(
      snapRect({ x: 95, y: 0, width: 45, height: 20 }, 20, { width: 50, height: 0 }, { right: true }).x
    ).toBe(80)
  })

  it('snaps only what an edit moved or resized', () => {
    const sensor = byPath('Core.Sensor')
    const logger = byPath('Core.Logger')
    const next = produce(example, (d) => {
      const m = d.modules.find((m) => m.id === sensor.id)!
      m.layout.x += 7
      m.layout.y += 3
    })
    const snapped = snapChanges(example, next, 20)
    const abs = absolutePosition(snapped, sensor.id)
    expect(onGrid(abs.x) && onGrid(abs.y)).toBe(true)
    expect(snapped.modules.find((m) => m.id === logger.id)!.layout).toBe(
      example.modules.find((m) => m.id === logger.id)!.layout
    )
  })

  it('keeps an unchanged project as is', () => {
    expect(snapChanges(example, example, 20)).toBe(example)
  })

  it('grows the parent on the grid to hold a snapped child', () => {
    const core = byPath('Core')
    const sensor = byPath('Core.Sensor')
    const next = produce(example, (d) => {
      const m = d.modules.find((m) => m.id === sensor.id)!
      m.layout.x = core.layout.width + 3
    })
    const snapped = snapChanges(example, next, 20)
    const parent = snapped.modules.find((m) => m.id === core.id)!
    const child = snapped.modules.find((m) => m.id === sensor.id)!
    expect(parent.layout.width).toBeGreaterThanOrEqual(child.layout.x + child.layout.width)
    expect(onGrid(parent.layout.width)).toBe(true)
  })
})
