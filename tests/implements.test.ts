import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { unimplementedMessages } from '@/model/project'
import type { Project } from '@/model/types'

const float = { kind: 'primitive', name: 'float32' }
const source = `
schemaVersion: 1
project:
  name: Implements
types: []
interfaces:
  - name: Telemetry
    messages:
      - name: publish
        params:
          - { name: value, type: ${JSON.stringify(float)} }
        returns: null
      - name: rate
        params: []
        returns: ${JSON.stringify(float)}
modules:
  - name: Sensor
    implements: [Telemetry]
    methods:
      - name: publish
        params:
          - { name: value, type: ${JSON.stringify(float)} }
        returns: null
      - name: rate
        const: true
        params: []
        returns: ${JSON.stringify(float)}
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const errors = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'error')
    .map((pr) => pr.message)

describe('implemented interfaces', () => {
  it('loads them and writes them back', () => {
    const p = load()
    expect(p.modules[0]!.implements).toEqual([p.interfaces[0]!.id])
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('reports unknown interfaces', () => {
    const data = structuredClone(example)
    data.modules[0].implements = ['Nope']
    expect(() => fromFile(data)).toThrow(LoadError)
  })

  it('checks the methods against the messages', () => {
    const p = load()
    const [publish, rate] = p.modules[0]!.methods
    publish!.params[0]!.type = { kind: 'primitive', name: 'int32' }
    rate!.access = 'private'
    expect(errors(p)).toEqual([
      'Sensor.publish: not as Telemetry.publish it implements (public, same parameters, result and exceptions)',
      'Sensor.rate: not as Telemetry.rate it implements (public, same parameters, result and exceptions)'
    ])
    p.modules[0]!.methods = []
    expect(unimplementedMessages(p, p.modules[0]!).map((u) => u.message.name)).toEqual(['publish', 'rate'])
    p.modules[0]!.kind = 'abstract'
    expect(errors(p)).toEqual([])
  })

  it('follows renames of the interface', () => {
    const p = load()
    p.interfaces[0]!.name = 'Telemetry2'
    expect(toFile(p, { editor: false }).modules[0]!.implements).toEqual(['Telemetry2'])
  })
})
