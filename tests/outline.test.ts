import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { outline, type OutlineNode } from '@/model/outline'
import { targetAt } from '@/components/sourceTarget'
import { loadText } from '@/model/serialize'

const robot = readFileSync('examples/robot.scaffold.yaml', 'utf8')

const find = (nodes: OutlineNode[], name: string): OutlineNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n
    const found = find(n.children, name)
    if (found) return found
  }
  return undefined
}

describe('outline', () => {
  it('lists the sections and their named entries', () => {
    const nodes = outline(robot)
    expect(nodes.map((n) => n.name)).toEqual([
      'Robot',
      'Types',
      'Interfaces',
      'Modules',
      'Dependencies',
      'Links'
    ])
    const types = nodes.find((n) => n.name === 'Types')!
    expect(types.children.map((t) => `${t.kind} ${t.name}`)).toEqual(['primitive Primitive'])
    const dependencies = nodes.find((n) => n.name === 'Dependencies')!
    expect(dependencies.children.map((d) => `${d.kind} ${d.name} ${d.detail}`)).toEqual([
      'dependency Common common.scaffold.yaml'
    ])
    expect(dependencies.children[0]!.children.map((t) => `${t.kind} ${t.name}`)).toEqual([
      'struct Vec3',
      'enum Mode',
      'alias Samples',
      'struct Pose',
      'interface Telemetry',
      'interface Control'
    ])
    expect(find(nodes, 'Samples')?.detail).toBe('vector<uint16>')
    expect(find(nodes, 'Pose')?.children.map((f) => `${f.name}: ${f.detail}`)).toEqual([
      'position: Vec3',
      'orientation: array<float64, 4> = [ 0, 0, 0, 1 ]'
    ])
  })

  it('locates entries in the text', () => {
    const vec3 = find(outline(robot), 'Vec3')!
    expect(robot.slice(...vec3.nameRange)).toBe('Vec3')
    expect(robot.slice(vec3.range[0]).startsWith('kind: struct')).toBe(true)
  })

  it('gives paths that lead to the entities', () => {
    const p = loadText(robot, 'yaml')
    const nodes = outline(robot)
    const modules = nodes.find((n) => n.name === 'Modules')!
    const walk = (list: OutlineNode[]): OutlineNode[] => list.flatMap((n) => [n, ...walk(n.children)])
    for (const m of walk(modules.children).filter((n) => n.kind === 'module')) {
      const target = targetAt(p, m.path, m.names)
      expect(target?.kind).toBe('module')
      expect(p.modules.find((x) => target && 'id' in target && x.id === target.id)?.name).toBe(m.name)
    }
    const vec3 = find(nodes, 'Vec3')!
    expect(targetAt(p, vec3.path, vec3.names)).toEqual({
      kind: 'type',
      id: p.types.find((t) => t.name === 'Vec3')!.id
    })
    const link = nodes.find((n) => n.name === 'Links')!.children[0]!
    expect(targetAt(p, link.path, link.names)).toEqual({ kind: 'link', id: p.links[0]!.id })
  })

  it('outlines JSON and incomplete text', () => {
    const json = JSON.stringify({ project: { name: 'J' }, modules: [{ name: 'A', ports: [] }] }, null, 2)
    expect(outline(json).map((n) => n.name)).toEqual(['J', 'Modules'])
    expect(
      outline('modules:\n  - name: A\n  - name:').find((n) => n.name === 'Modules')?.children
    ).toHaveLength(2)
    expect(outline(': : :')).toEqual([])
  })
})
