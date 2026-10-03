import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { locateProblems, targetPath } from '@/model/locate'
import { lineOfPath, loadText, toFile } from '@/model/serialize'

const robot = readFileSync('examples/robot.scaffold.yaml', 'utf8')
const lineOf = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split('\n').length

describe('locateProblems', () => {
  it('finds nothing in the example', () => {
    expect(locateProblems(robot, 'yaml').filter((p) => p.severity === 'error')).toEqual([])
  })

  it('puts a validation problem on the line of its entity', () => {
    // A port using an interface that does not exist.
    const text = robot.replace('interface: Telemetry', 'interface: Missing')
    const problems = locateProblems(text, 'yaml')
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.some((p) => p.line > 1)).toBe(true)
  })

  it('puts a nested module problem on its line', () => {
    const text = [
      'schemaVersion: 1',
      'project:',
      '  name: P',
      'types: []',
      'interfaces: []',
      'links: []',
      'modules:',
      '  - name: A',
      '    ports: []',
      '    modules:',
      '      - name: B',
      '        ports:',
      '          - { name: x, role: in, interface: null }'
    ].join('\n')
    // A port without interface: a warning on its module.
    expect(locateProblems(text, 'yaml')).toEqual([
      { severity: 'warning', message: 'A.B:x has no interface', line: lineOf(text, '- name: B') }
    ])
  })

  it('reports load errors with their line', () => {
    const problems = locateProblems('schemaVersion: 1\nproject:\n  name: [', 'yaml')
    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('error')
  })
})

describe('targetPath', () => {
  it('leads from a selected entity to its line, through the data of the project', () => {
    const p = loadText(robot, 'yaml')
    const data = toFile(p, { editor: false })
    const lineOfTarget = (target: Parameters<typeof targetPath>[2]): number | undefined =>
      lineOfPath(robot, targetPath(data, p, target))
    for (const m of p.modules)
      expect(robot.split('\n')[lineOfTarget({ kind: 'module', id: m.id })! - 1]).toContain(`name: ${m.name}`)
    for (const t of p.types)
      expect(robot.split('\n')[lineOfTarget({ kind: 'type', id: t.id })! - 1]).toMatch(/kind: |name: /)
    const dep = p.dependencies[0]!
    expect(robot.split('\n')[lineOfTarget({ kind: 'dependency', id: dep.id })! - 1]).toContain(
      `name: ${dep.name}`
    )
    const link = p.links[0]!
    expect(robot.split('\n')[lineOfTarget({ kind: 'link', id: link.id })! - 1]).toContain(
      `name: ${link.name}`
    )
  })
})
