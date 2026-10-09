import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { structureAt } from '@/components/completion'
import { produce } from 'immer'
import { targetAt } from '@/components/sourceTarget'
import { loadText, saveText } from '@/model/serialize'

const project = loadText(readFileSync('examples/robot.scaffold.yaml', 'utf8'), 'yaml')
const text = saveText(project, 'yaml', { editor: true })

/** Entity name at the first occurrence of `marker` in the text. */
function at(marker: string, from = 0): string | null {
  const pos = text.indexOf(marker, from) + marker.length
  const { path, names } = structureAt(text, pos)
  const t = targetAt(project, path, names)
  if (!t) return null
  if (t.kind === 'project') return 'project'
  const all = [
    ...project.modules,
    ...project.links,
    ...project.types,
    ...project.interfaces,
    ...project.dependencies
  ]
  return `${t.kind}:${all.find((e) => e.id === t.id)?.name ?? t.id}`
}

describe('caret target', () => {
  it('finds the entity of a line', () => {
    expect(at('name: Robot')).toBe('project')
    expect(at('name: Pose')).toBe('type:Pose')
    expect(at('name: float64')).toBe('type:Pose')
    expect(at('name: Telemetry')).toBe('interface:Telemetry')
    expect(at('- name: Sensor')).toBe('module:Sensor')
    expect(at('role: out', text.indexOf('- name: Sensor'))).toBe('module:Sensor')
    expect(at('name: sensor_to_controller')).toBe('link:sensor_to_controller')
    expect(at('class: realtime')).toBe('link:sensor_to_controller')
    expect(at('- name: Common')).toBe('dependency:Common')
    expect(at('file: common.scaffold.yaml')).toBe('dependency:Common')
    expect(at('name: Vec3')).toBe('type:Vec3')
  })

  it('finds modules from their editor data', () => {
    expect(at('  Core.Logger:')).toBe('module:Logger')
  })

  it('finds links and modules from the editor data of the views', () => {
    const p = produce(project, (d) => {
      const core = d.modules.find((m) => m.name === 'Core')!
      const operator = d.modules.find((m) => m.name === 'Operator')!
      d.links[0]!.route = { points: [{ x: 1, y: 2 }] }
      d.views.push({
        id: 'core-view',
        name: 'Core view',
        rootModuleId: core.id,
        hidden: [],
        routes: { [d.links[2]!.id]: { points: [{ x: 3, y: 4 }] } },
        standIns: { [operator.id]: { x: -300, y: 0 } }
      })
    })
    const t = saveText(p, 'yaml', { editor: true })
    const find = (marker: string, from = 0) => {
      const { path, names } = structureAt(t, t.indexOf(marker, from) + marker.length)
      const target = targetAt(p, path, names)
      const name = [...p.modules, ...p.links].find(
        (e) => target && 'id' in target && e.id === target.id
      )?.name
      return `${target?.kind}:${name}`
    }
    const views = t.indexOf('  views:')
    expect(find(`  links:\n    ${p.links[0]!.name}:`)).toBe(`link:${p.links[0]!.name}`)
    expect(find(`${p.links[2]!.name}:`, views)).toBe(`link:${p.links[2]!.name}`)
    expect(find('Operator:', t.indexOf('outside:', views))).toBe('module:Operator')
    expect(find('- name: Core view')).toBe('module:Core')
  })
})
