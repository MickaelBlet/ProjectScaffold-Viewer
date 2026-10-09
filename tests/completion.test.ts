import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { complete, filterItems, type JsonSchema } from '@/components/completion'

const schema = JSON.parse(readFileSync('schema/scaffold.schema.json', 'utf8')) as JsonSchema
const names = {
  interfaces: ['Telemetry', 'Control'],
  modules: ['Core', 'Core.Sensor'],
  types: ['Vec3', 'Pose']
}

/** Completion labels at the `|` of the text. */
function at(text: string): string[] | null {
  const pos = text.indexOf('|')
  const r = complete(text.replace('|', ''), pos, schema, names)
  return r && filterItems(r).map((i) => i.label)
}

describe('schema completion', () => {
  it('completes top-level keys', () => {
    expect(at('schemaVersion: 1\npro|')).toEqual(['project'])
    expect(at('schemaVersion: 1\n|')).not.toContain('schemaVersion')
  })

  it('completes the keys of a new list item, required first', () => {
    const labels = at('links:\n  - name: a\n  - |')!
    expect(labels.slice(0, 4)).toEqual(['name', 'from', 'to', 'constraints'])
    expect(labels).toContain('description')
  })

  it('leaves out the keys already present, above and below', () => {
    const labels = at('modules:\n  - name: A\n    |\n    ports: []\n')!
    expect(labels).not.toContain('name')
    expect(labels).not.toContain('ports')
    expect(labels).toContain('modules')
  })

  it('narrows alternatives with the values already written', () => {
    expect(at('types:\n  - kind: enum\n    und|')).toEqual(['underlying'])
    expect(at('types:\n  - kind: struct\n    und|')).toEqual([])
  })

  it('completes enums, booleans and constants', () => {
    expect(at('types:\n  - kind: enum\n    underlying: uint|')).toEqual([
      'uint8',
      'uint16',
      'uint32',
      'uint64'
    ])
    expect(at('links:\n  - constraints:\n      ack:\n        required: |')).toEqual(['true', 'false'])
    expect(at('modules:\n  - name: A\n    ports:\n      - role: |')).toEqual(['out', 'in'])
  })

  it('completes project names', () => {
    expect(at('modules:\n  - name: A\n    ports:\n      - interface: Te|')).toEqual(['Telemetry'])
    expect(at('links:\n  - from:\n      module: Core.|')).toEqual(['Core.Sensor'])
    expect(at('types:\n  - kind: alias\n    type:\n      kind: ref\n      name: |')).toEqual(['Vec3', 'Pose'])
  })

  it('opens nested objects and lists on the next line', () => {
    const end = (t: string) => complete(t, t.length, schema, names)!
    const r = end('links:\n  - name: a\n    constr')
    expect(r.items.find((i) => i.label === 'constraints')!.insert).toBe('constraints:\n      ')
    const m = end('modules:\n  - name: A\n    por')
    expect(m.items.find((i) => i.label === 'ports')!.insert).toBe('ports:\n      - ')
  })
})
