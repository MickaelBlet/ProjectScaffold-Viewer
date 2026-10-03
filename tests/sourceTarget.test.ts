import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { structureAt } from '@/components/completion'
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
})
