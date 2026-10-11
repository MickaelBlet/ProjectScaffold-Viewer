import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, reloadText, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { copyItems, pasteClip } from '@/model/clipboard'
import { compartmentsHeight } from '@/model/project'
import type { Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Lifecycle
types: []
interfaces: []
modules:
  - name: Sensor
    copy: delete
    move: default
    attributes:
      - name: id
        const: true
        type:
          kind: primitive
          name: uint32
      - name: rate
        type:
          kind: primitive
          name: float32
        default: 10
    constructors:
      - explicit: true
        params:
          - name: id
            type:
              kind: primitive
              name: uint32
          - name: rate
            type:
              kind: primitive
              name: float32
            default: 10
      - access: private
        deleted: true
        params: []
    destructor:
      virtual: true
    methods:
      - name: read
        virtual: true
        params: []
        returns:
          kind: primitive
          name: float32
    ports: []
  - name: Registry
    instantiation: singleton
    copy: delete
    move: delete
    constructors:
      - access: private
        defaulted: true
        params: []
    ports: []
  - name: Units
    instantiation: utility
    methods:
      - name: toCelsius
        static: true
        params:
          - name: kelvin
            type:
              kind: primitive
              name: float64
        returns:
          kind: primitive
          name: float64
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('lifecycle', () => {
  it('loads constructors, destructor, copy, move and instantiation, and writes them back', () => {
    const p = load()
    const sensor = mod(p, 'Sensor')
    expect(sensor).toMatchObject({ copy: 'delete', move: 'default', destructor: { virtual: true } })
    expect(sensor.constructors).toHaveLength(2)
    expect(sensor.constructors![0]).toMatchObject({ explicit: true })
    expect(sensor.constructors![0]!.params[1]!.default).toBe(10)
    expect(mod(p, 'Registry').instantiation).toBe('singleton')
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('keeps constructor ids on reload, and copies them anew', () => {
    const p = load()
    const again = reloadText(saveText(p, 'yaml', { editor: true }), 'yaml', p)
    expect(mod(again, 'Sensor').constructors!.map((c) => c.id)).toEqual(
      mod(p, 'Sensor').constructors!.map((c) => c.id)
    )
    const clip = copyItems(p, [mod(p, 'Sensor').id])!
    const pasted = produce(p, (d) => void pasteClip(d, clip, { parent: null }))
    const copy = pasted.modules.at(-1)!
    expect(copy.constructors).toHaveLength(2)
    expect(copy.constructors![0]!.id).not.toBe(mod(p, 'Sensor').constructors![0]!.id)
  })

  it('makes room for constructors and the destructor among the methods', () => {
    const p = load()
    const sensor = mod(p, 'Sensor')
    expect(compartmentsHeight(sensor)).toBe(
      compartmentsHeight({ attributes: sensor.attributes, methods: [1, 2, 3, 4] })
    )
  })

  it('checks constructors against attributes', () => {
    const p = load()
    const [ctor] = mod(p, 'Sensor').constructors!
    ctor!.params[0]!.type = { kind: 'primitive', name: 'string' }
    expect(messages(p)).toEqual(['Sensor(id, rate): id is not of the type of the attribute it sets'])
    ctor!.params.shift()
    expect(messages(p)).toEqual(['Sensor(rate): leaves const attribute id unset'])
    delete mod(p, 'Sensor').constructors
    expect(messages(p, 'warning')).toEqual([
      'Sensor.id: const, without a default value nor constructors setting it'
    ])
  })

  it('flags defaulted constructors with parameters and duplicates', () => {
    const p = load()
    const [ctor, other] = mod(p, 'Sensor').constructors!
    ctor!.defaulted = true
    other!.params = structuredClone(ctor!.params)
    delete other!.deleted
    expect(messages(p)).toContain('Sensor(id, rate): a defaulted constructor has no parameters')
    expect(messages(p)).toContain('Sensor(id, rate): same parameters as another constructor')
  })

  it('checks singletons, utility and value modules', () => {
    const p = load()
    delete mod(p, 'Registry').constructors![0]!.access
    mod(p, 'Registry').copy = 'default'
    expect(messages(p)).toEqual([
      'Registry(): constructors of a singleton are not public',
      'Registry: a singleton is not copied (copy: delete)'
    ])
    delete mod(p, 'Units').methods[0]!.static
    expect(messages(p)).toContain('Units.toCelsius: members of a utility module are static')
    mod(p, 'Sensor').instantiation = 'value'
    expect(messages(p)).toContain('Sensor.read: a value module has no virtual methods')
    expect(messages(p)).toContain('Sensor: a value module is copied (not copy: delete)')
  })

  it('warns about a public destructor that is not virtual beside virtual methods', () => {
    const p = load()
    mod(p, 'Sensor').destructor = { virtual: false }
    expect(messages(p, 'warning')).toEqual([
      'Sensor: virtual methods, but a public destructor that is not virtual'
    ])
    mod(p, 'Sensor').destructor = { virtual: false, access: 'protected' }
    expect(messages(p, 'warning')).toEqual([])
  })
})
