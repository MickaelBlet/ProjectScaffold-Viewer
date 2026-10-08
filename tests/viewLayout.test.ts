import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { findView, growAncestors, isolatedViewId, modulePath, newId, pruneViews } from '@/model/project'
import { foldLayouts, inView, outsideOf } from '@/model/viewLayout'
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

  const link = example.links.find((l) => l.name === 'sensor_to_controller')!.id
  const port = mod(example, sensor).ports[0]!.id
  const linkOf = (p: Project) => p.links.find((l) => l.id === link)!
  const portOf = (p: Project) => mod(p, sensor).ports.find((pt) => pt.id === port)!
  const shaped = produce(example, (d) => {
    linkOf(d).route = { points: [{ x: 1, y: 2 }] }
    portOf(d).label = 'top'
  })

  it('draws only its own link shapes and port name sides', () => {
    const drawn = inView(shaped, findView(shaped, viewId))
    expect(linkOf(drawn).route).toBeUndefined()
    expect(portOf(drawn).label).toBeUndefined()
    // Same object while nothing changes.
    expect(inView(shaped, findView(shaped, viewId))).toBe(drawn)
    expect(inView(shaped, findView(shaped, 'global'))).toBe(shaped)
  })

  it('keeps the link shapes and port name sides set in the view, the project keeping its own', () => {
    const route = { points: [{ x: 5, y: 6 }], label: 0.25 }
    const next = edit(shaped, viewId, (d) => {
      linkOf(d).route = route
      portOf(d).label = 'bottom'
    })
    const view = next.views.find((v) => v.id === viewId)!
    expect(view.routes?.[link]).toEqual(route)
    expect(view.portLabels?.[port]).toBe('bottom')
    expect(linkOf(next)).toBe(linkOf(shaped))
    expect(mod(next, sensor)).toBe(mod(shaped, sensor))
    const drawn = inView(next, view)
    expect(linkOf(drawn).route).toEqual(route)
    expect(portOf(drawn).label).toBe('bottom')
    // Cleared in the view: back to the automatic shape.
    const cleared = edit(next, viewId, (d) => {
      delete linkOf(d).route
      delete portOf(d).label
    })
    const after = cleared.views.find((v) => v.id === viewId)!
    expect(after.routes).toBeUndefined()
    expect(after.portLabels).toBeUndefined()
    expect(linkOf(cleared).route).toEqual(linkOf(shaped).route)
  })

  it('gives links new in the view their shape in the view only', () => {
    const id = newId()
    const next = edit(example, viewId, (d) => {
      d.links.push({ ...linkOf(d), id, name: 'extra', route: { points: [{ x: 3, y: 4 }] } })
    })
    expect(next.links.find((l) => l.id === id)?.route).toBeUndefined()
    expect(next.views.find((v) => v.id === viewId)?.routes?.[id]).toEqual({ points: [{ x: 3, y: 4 }] })
  })

  it('drops the shapes, names and notes of deleted links, ports and views', () => {
    const next = produce(
      edit(example, viewId, (d) => {
        linkOf(d).route = { points: [], from: { side: 'top', at: 0.5 } }
        portOf(d).label = 'left'
        d.notes.push({ id: 'n', kind: 'note', text: '', layout: { x: 0, y: 0, width: 1, height: 1 }, viewId })
      }),
      (d) => {
        d.links = d.links.filter((l) => l.id !== link)
        mod(d, sensor).ports = mod(d, sensor).ports.filter((pt) => pt.id !== port)
        pruneViews(d)
      }
    )
    const view = next.views.find((v) => v.id === viewId)!
    expect(view.routes).toBeUndefined()
    expect(view.portLabels).toBeUndefined()
    expect(next.notes.some((n) => n.id === 'n')).toBe(true)
    const gone = produce(next, (d) => {
      d.views = d.views.filter((v) => v.id !== viewId)
      pruneViews(d)
    })
    expect(gone.notes.some((n) => n.id === 'n')).toBe(false)
  })

  it('round-trips the link shapes, port name sides and notes of a view through the file', () => {
    const next = edit(shaped, viewId, (d) => {
      linkOf(d).route = { points: [{ x: 7, y: 8 }] }
      portOf(d).label = 'right'
      d.notes.push({
        id: 'n',
        kind: 'frame',
        text: 'In view',
        layout: { x: 1, y: 2, width: 3, height: 4 },
        viewId
      })
    })
    const file = toFile(next, { editor: true })
    const saved = file.editor?.views?.find((v) => v.root === 'Core')
    expect(saved?.links).toEqual({ sensor_to_controller: { points: [{ x: 7, y: 8 }] } })
    expect(saved?.labels).toEqual({ 'Core.Sensor': { [portOf(next).name]: 'right' } })
    expect(saved?.notes?.map((n) => n.text)).toEqual(['In view'])
    expect(file.editor?.notes ?? []).not.toContainEqual(expect.objectContaining({ text: 'In view' }))
    const back = fromFile(JSON.parse(JSON.stringify(file)), next)
    const v = back.views.find((v) => v.rootModuleId === core)!
    expect(v.routes).toEqual(next.views.find((x) => x.id === viewId)!.routes)
    expect(v.portLabels).toEqual(next.views.find((x) => x.id === viewId)!.portLabels)
    // Ids kept on reload.
    expect(back.notes).toEqual(next.notes)
    expect(linkOf(back).route).toEqual(linkOf(shaped).route)
    expect(portOf(back).label).toBe('top')
  })

  it('round-trips the places of outside stand-ins, dropped with their module', () => {
    const operator = idOf(example, 'Operator')
    const next = produce(example, (d) => {
      d.views.push({
        id: viewId,
        name: 'Core',
        rootModuleId: core,
        hidden: [],
        standIns: { [operator]: { x: -300, y: 40 } }
      })
    })
    const saved = toFile(next, { editor: true }).editor?.views?.find((v) => v.root === 'Core')
    expect(saved?.outside).toEqual({ Operator: { x: -300, y: 40 } })
    const back = fromFile(JSON.parse(JSON.stringify(toFile(next, { editor: true }))))
    expect(back.views.find((v) => v.rootModuleId === core)?.standIns).toEqual({
      [operator]: { x: -300, y: 40 }
    })
    const gone = produce(next, (d) => {
      d.modules = d.modules.filter((m) => m.id !== operator)
      pruneViews(d)
    })
    expect(gone.views.find((v) => v.id === viewId)?.standIns).toBeUndefined()
  })

  it('draws the modules outside a drill-down view compact, at the top level, lined up along it', () => {
    const operator = idOf(example, 'Operator')
    const drawn = inView(example, findView(example, viewId))
    expect([...outsideOf(drawn)]).toEqual([operator])
    expect(mod(drawn, core).parentId).toBeNull()
    const o = mod(drawn, operator)
    expect(o.parentId).toBeNull()
    expect(o.attributes).toEqual([])
    expect(o.ports.map((pt) => pt.name)).toEqual(['cmd'])
    // Only sends to the view: on its in side.
    expect(o.layout.x + o.layout.width).toBeLessThan(mod(drawn, core).layout.x)
    expect(outsideOf(example).size).toBe(0)
  })

  it('keeps the place of a module outside the view in the view, the module as it is', () => {
    const operator = idOf(example, 'Operator')
    const next = edit(example, viewId, (d) => {
      Object.assign(mod(d, operator).layout, { x: -500, y: 10, width: 300 })
      mod(d, core).layout.width += 10
    })
    const view = next.views.find((v) => v.id === viewId)!
    expect(view.standIns?.[operator]).toMatchObject({ x: -500, y: 10, width: 300 })
    expect(mod(next, operator)).toBe(mod(example, operator))
    // The root keeps its parent; its rect is the view's.
    expect(mod(next, core).parentId).toBe(mod(example, core).parentId)
    expect(view.layouts?.[core]?.width).toBe(mod(example, core).layout.width + 10)
    expect(mod(inView(next, view), operator).layout).toMatchObject({ x: -500, y: 10, width: 300 })
  })

  it('shapes the links to the modules outside the view in the view only', () => {
    const toCore = example.links.find((l) => l.name === 'operator_to_core')!.id
    const route = { points: [{ x: -100, y: 50 }], from: { side: 'bottom' as const, at: 0.5 } }
    const next = edit(example, viewId, (d) => void (d.links.find((l) => l.id === toCore)!.route = route))
    expect(next.views.find((v) => v.id === viewId)?.routes?.[toCore]).toEqual(route)
    expect(next.links.find((l) => l.id === toCore)).toBe(example.links.find((l) => l.id === toCore))
  })
})
