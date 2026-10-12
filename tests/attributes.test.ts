import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { constraintErrors, constraintValueErrors, multiplicity } from '@/model/constraints'
import { setAttributeQualifier } from '@/model/project'
import { associationEdges } from '@/canvas/associationEdges'
import type { Attribute, Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Attributes
types:
  - kind: struct
    name: Reading
    fields:
      - name: celsius
        type:
          kind: primitive
          name: float32
        default: 20
        constraints:
          min: -40
          max: 125
          unit: °C
      - name: tag
        type:
          kind: primitive
          name: string
        default: t1
        constraints:
          pattern: "[a-z][0-9]+"
interfaces: []
modules:
  - name: Bus
    ports: []
  - name: Sensor
    locks:
      - name: mutex
        kind: shared
    attributes:
      - name: bus
        type:
          kind: ref
          name: Bus
        ownership: shared
      - name: rate
        atomic: true
        type:
          kind: primitive
          name: uint16
        default: 10
        constraints:
          min: 1
          max: 1000
          unit: Hz
      - name: last
        type:
          kind: ref
          name: Reading
        guardedBy: mutex
      - name: cache
        mutable: true
        type:
          kind: primitive
          name: bytes
        accessors: none
    methods:
      - name: read
        const: true
        threadSafe: true
        params: []
        returns:
          kind: ref
          name: Reading
    ports: []
  - name: Probe
    attributes:
      - name: bus
        type:
          kind: optional
          of:
            kind: ref
            name: Bus
        ownership: weak
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const attr = (p: Project, module: string, name: string) =>
  mod(p, module).attributes.find((a) => a.name === name)!
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('attribute details', () => {
  it('loads constraints, ownership, accessors, qualifiers and locks, and writes them back', () => {
    const p = load()
    expect(attr(p, 'Sensor', 'rate')).toMatchObject({
      atomic: true,
      constraints: { min: 1, max: 1000, unit: 'Hz' }
    })
    expect(attr(p, 'Sensor', 'last').guardedBy).toBe(mod(p, 'Sensor').locks![0]!.id)
    expect(attr(p, 'Sensor', 'cache')).toMatchObject({ mutable: true, accessors: 'none' })
    expect(mod(p, 'Sensor').methods[0]!.threadSafe).toBe(true)
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
    expect(toFile(p, { editor: false }).types).toEqual(example.types)
  })

  it('reports unknown locks', () => {
    const data = structuredClone(example)
    data.modules[1].attributes[2].guardedBy = 'nope'
    expect(() => fromFile(data)).toThrow(LoadError)
  })

  it('checks constraints against the type and the default value', () => {
    const p = load()
    const types = p.types
    const float = { kind: 'primitive', name: 'float32' } as const
    expect(constraintErrors({ min: 5, max: 1 }, float, types)).toEqual(['min 5 is above max 1'])
    expect(constraintErrors({ pattern: 'a' }, float, types)).toEqual(['pattern applies to text'])
    expect(constraintErrors({ min: 0.5 }, { kind: 'primitive', name: 'uint8' }, types)).toEqual([
      'min of an integer is an integer'
    ])
    expect(constraintErrors({ max: 300 }, { kind: 'primitive', name: 'uint8' }, types)).toEqual([
      'max 300 is out of the range of uint8'
    ])
    expect(constraintErrors({ min: 1 }, { kind: 'vector', of: float }, types)).toEqual([])
    expect(constraintValueErrors([1, 50], { max: 10, unit: 'm' })).toEqual(['50 m is above max 10 m'])
    attr(p, 'Sensor', 'rate').default = 0
    expect(messages(p)).toEqual(['Sensor.rate default: 0 Hz is below min 1 Hz'])
  })

  it('checks qualifiers, accessors, locks and ownership', () => {
    const p = load()
    attr(p, 'Sensor', 'rate').guardedBy = mod(p, 'Sensor').locks![0]!.id
    attr(p, 'Sensor', 'cache').atomic = true
    expect(messages(p)).toEqual([
      'Sensor.rate: atomic, it needs no lock',
      'Sensor.cache: atomic applies to booleans, characters, numbers, enums and bitmasks'
    ])
    const q = load()
    attr(q, 'Sensor', 'cache').static = true
    mod(q, 'Sensor').locks![0]!.name = 'read'
    attr(q, 'Probe', 'bus').ownership = undefined
    attr(q, 'Sensor', 'rate').ownership = 'owned'
    expect(messages(q)).toEqual([
      'Sensor.rate: ownership applies to types referencing modules',
      'Sensor.cache: a mutable attribute is not static',
      "Sensor: lock 'read' has the name of a member"
    ])
  })

  it('warns about weak references nothing shares', () => {
    const p = load()
    delete attr(p, 'Sensor', 'bus').ownership
    expect(messages(p, 'warning')).toEqual(['Probe.bus: weak, but nothing holds Bus as shared'])
    attr(p, 'Sensor', 'bus').ownership = 'owned'
    mod(p, 'Sensor').copy = 'default'
    expect(messages(p)).toContain('Sensor.bus: owned modules are not copied (copy: default)')
  })

  it('keeps qualifiers of attributes consistent', () => {
    const a = { static: true, const: true } as Attribute
    setAttributeQualifier(a, 'mutable', true)
    expect(a).toEqual({ mutable: true })
    setAttributeQualifier(a, 'const', true)
    expect(a).toEqual({ const: true })
    const b = { accessors: 'read' } as Attribute
    setAttributeQualifier(b, 'const', true)
    expect(b).toEqual({ const: true })
  })

  it('draws associations to referenced modules', () => {
    const p = load()
    const visible = new Set(p.modules.map((m) => m.id))
    const edges = associationEdges(p, visible)
    expect(edges.map((e) => [e.source, e.target, e.data?.ownership, e.data?.label])).toEqual([
      [mod(p, 'Sensor').id, mod(p, 'Bus').id, 'shared', 'bus [1]'],
      [mod(p, 'Probe').id, mod(p, 'Bus').id, 'weak', 'bus [0..1]']
    ])
    expect(multiplicity({ kind: 'vector', of: { kind: 'ref', id: 'x' } })).toBe('*')
  })
})
