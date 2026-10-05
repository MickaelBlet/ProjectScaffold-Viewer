import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { findView, growAncestors, isolatedViewId, modulePath, newId } from '@/model/project'
import { foldLayouts, inView } from '@/model/viewLayout'
import type { Project } from '@/model/types'

const example = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const idOf = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!.id
const core = idOf(example, 'Core')
const sensor = idOf(example, 'Core.Sensor')

/** Edit `p` as the view draws it, folded back as the store does. */
function edit(p: Project, viewId: string, fn: (d: Project) => void): Project {
  const base = inView(p, findView(p, viewId))
  return foldLayouts(p, base, produce(base, fn), viewId)
}
const mod = (p: Project, id: string) => p.modules.find((m) => m.id === id)!

describe('view layouts', () => {
  const viewId = isolatedViewId(core)

  it('keeps the rects an edit in a drill-down view gives its modules, storing a temporary view', () => {
    const next = edit(example, viewId, (d) => {
      mod(d, sensor).layout.x += 40
      mod(d, core).layout.width += 100
    })
    const view = next.views.find((v) => v.id === viewId)!
    expect(view.rootModuleId).toBe(core)
    expect(view.layouts?.[sensor]).toEqual({
      ...mod(example, sensor).layout,
      x: mod(example, sensor).layout.x + 40
    })
    expect(view.layouts?.[core]?.width).toBe(mod(example, core).layout.width + 100)
    // The project view is unchanged.
    expect(mod(next, sensor)).toBe(mod(example, sensor))
    expect(mod(next, core).layout).toEqual(mod(example, core).layout)
    // The view draws its own rects.
    expect(mod(inView(next, view), sensor).layout.x).toBe(mod(example, sensor).layout.x + 40)
  })

  it('drops a rect brought back to the module layout', () => {
    const moved = edit(example, viewId, (d) => void (mod(d, sensor).layout.x += 40))
    const back = edit(moved, viewId, (d) => void (mod(d, sensor).layout.x -= 40))
    expect(back.views.find((v) => v.id === viewId)?.layouts).toBeUndefined()
  })

  it('gives new modules their rect in the view as layout, growing their parents', () => {
    const id = newId()
    const next = edit(example, viewId, (d) => {
      d.modules.push({
        ...mod(d, sensor),
        id,
        name: 'Extra',
        layout: { x: 2000, y: 40, width: 200, height: 80 }
      })
      growAncestors(d, id)
    })
    expect(mod(next, id).layout.x).toBe(2000)
    expect(mod(next, core).layout.width).toBeGreaterThanOrEqual(2200)
  })

  it('round-trips the rects of a view through the file', () => {
    const next = edit(example, viewId, (d) => void (mod(d, sensor).layout.y += 20))
    const file = toFile(next, { editor: true })
    const saved = file.editor?.views?.find((v) => v.root === 'Core')
    expect(saved?.layout?.['Core.Sensor']?.y).toBe(mod(example, sensor).layout.y + 20)
    const back = fromFile(JSON.parse(JSON.stringify(file)))
    const v = back.views.find((v) => v.rootModuleId === idOf(back, 'Core'))!
    expect(v.layouts?.[idOf(back, 'Core.Sensor')]?.y).toBe(mod(example, sensor).layout.y + 20)
  })
})
