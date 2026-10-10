import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { addDependency, removeDependency } from '@/model/dependencies'
import { copyItems, pasteClip } from '@/model/clipboard'
import { dependencyModuleRef, modulePath, nameError, typeScope } from '@/model/project'
import { validate } from '@/model/validate'
import type { Project, StructDef, TypeRef } from '@/model/types'

const load = (yaml: string): Project => fromFile(YAML.parse(yaml))
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!
const ref = (name: string) => ({ kind: 'ref', name })

/** Modules Core.Sensor and Logger used as types by a struct, an interface and an attribute. */
const plant = (): Project =>
  load(`
schemaVersion: 1
project: { name: Plant }
types:
  - kind: struct
    name: Wiring
    fields:
      - { name: sensor, type: { kind: ref, name: Core.Sensor } }
      - { name: loggers, type: { kind: vector, of: { kind: ref, name: Logger } } }
interfaces:
  - name: Registry
    messages:
      - name: add
        params: [{ name: sensor, type: { kind: ref, name: Core.Sensor } }]
        returns: { kind: optional, of: { kind: ref, name: Logger } }
modules:
  - name: Core
    ports: []
    modules:
      - name: Sensor
        ports: []
        attributes: [{ name: log, type: { kind: ref, name: Logger } }]
  - { name: Logger, ports: [] }
links: []
`)

describe('modules used as types', () => {
  it('reads and writes references to modules by path', () => {
    const p = plant()
    const sensor = byPath(p, 'Core.Sensor')
    const logger = byPath(p, 'Logger')
    const wiring = p.types.find((t) => t.name === 'Wiring') as StructDef
    expect(wiring.fields[0]!.type).toEqual({ kind: 'ref', id: sensor.id })
    expect(sensor.attributes[0]!.type).toEqual({ kind: 'ref', id: logger.id })
    expect(messages(p)).toEqual([])
    const f = toFile(p, { editor: false })
    expect(f.types[0]).toMatchObject({
      fields: [{ type: ref('Core.Sensor') }, { type: { of: ref('Logger') } }]
    })
    expect(f.interfaces[0]!.messages[0]!.returns).toEqual({ kind: 'optional', of: ref('Logger') })
  })

  it('follows renamed and moved modules', () => {
    const p = produce(plant(), (d) => {
      d.modules.find((m) => m.name === 'Sensor')!.name = 'Probe'
      d.modules.find((m) => m.name === 'Logger')!.parentId = d.modules.find((m) => m.name === 'Core')!.id
    })
    const f = toFile(p, { editor: false })
    expect(f.types[0]).toMatchObject({
      fields: [{ type: ref('Core.Probe') }, { type: { of: ref('Core.Logger') } }]
    })
  })

  it('rejects unknown modules', () => {
    const data = YAML.parse(`
schemaVersion: 1
project: { name: P }
types: [{ kind: alias, name: A, type: { kind: ref, name: Core.Nope } }]
interfaces: []
modules: [{ name: Core, ports: [] }]
links: []
`)
    expect(() => fromFile(data)).toThrow(/unknown type 'Core.Nope'/)
  })

  it('flags references to deleted modules', () => {
    const p = produce(plant(), (d) => {
      d.modules = d.modules.filter((m) => m.name !== 'Logger')
    })
    expect(messages(p)).toContain('Core.Sensor.log: references a deleted type or module')
  })

  it('gives modules no value', () => {
    const p = produce(plant(), (d) => {
      const sensor = d.modules.find((m) => m.name === 'Sensor')!
      sensor.attributes[0]!.default = 'main'
      const logger = sensor.attributes[0]!.type
      sensor.attributes.push({
        id: 'maybe',
        name: 'maybe',
        type: { kind: 'optional', of: logger },
        description: '',
        default: null
      })
      // A value of a struct leaves its modules out.
      d.consts.push({
        id: 'c',
        name: 'NoWiring',
        description: '',
        type: { kind: 'ref', id: d.types[0]!.id },
        value: { loggers: [] }
      })
    })
    expect(messages(p)).toEqual([
      'Core.Sensor.log default: Expected null (a module reference has no value), got text main'
    ])
  })

  it('accepts modules as map keys, not as union discriminators', () => {
    const p = produce(plant(), (d) => {
      const logger: TypeRef = { kind: 'ref', id: d.modules.find((m) => m.name === 'Logger')!.id }
      d.types.push(
        {
          id: 'm',
          kind: 'alias',
          name: 'Levels',
          description: '',
          type: { kind: 'map', key: logger, value: { kind: 'primitive', name: 'uint8' } }
        },
        { id: 'u', kind: 'union', name: 'Choice', description: '', discriminator: logger, cases: [] }
      )
    })
    expect(messages(p)).toEqual(["Union 'Choice': discriminator must be an integer, bool, char or enum"])
  })

  it('names modules in type scopes', () => {
    const p = plant()
    const scope = typeScope(p, null)
    expect(scope.modules.map((m) => m.name)).toEqual(['Core', 'Core.Sensor', 'Logger'])
    expect(scope.idOf('Core.Sensor')).toBe(byPath(p, 'Core.Sensor').id)
    expect(scope.nameOf(byPath(p, 'Logger').id)).toBe('Logger')
  })

  it('keeps top-level modules and types apart', () => {
    const p = plant()
    expect(nameError(p, { kind: 'type' }, 'Logger')).toBe("A module named 'Logger' already exists")
    expect(nameError(p, { kind: 'module', parentId: null }, 'Wiring')).toBe(
      "A type, interface or constant named 'Wiring' already exists"
    )
    expect(nameError(p, { kind: 'module', parentId: byPath(p, 'Core').id }, 'Wiring')).toBeNull()
    const q = produce(p, (d) => {
      d.modules.find((m) => m.name === 'Logger')!.name = 'Wiring'
    })
    expect(messages(q, 'warning')).toContain(
      "Module 'Wiring' has the name of a type, interface or constant: 'Wiring' in a type names that one"
    )
  })

  it('pastes references to copied modules as references to their copies', () => {
    const p = plant()
    const clip = copyItems(p, [byPath(p, 'Core').id, byPath(p, 'Logger').id])!
    const q = produce(p, (d) => void pasteClip(d, clip, { parent: null }))
    const sensors = q.modules.filter((m) => m.name === 'Sensor')
    const loggers = q.modules.filter((m) => m.name.startsWith('Logger'))
    expect(sensors.map((m) => m.attributes[0]!.type)).toEqual(loggers.map((m) => ({ kind: 'ref', id: m.id })))
  })
})

/** Lib, saved next to the project, with a struct holding its module Drivers.Imu. */
const lib = load(`
schemaVersion: 1
project: { name: Lib }
types:
  - kind: struct
    name: Reading
    fields: [{ name: source, type: { kind: ref, name: Drivers.Imu } }]
interfaces: []
modules:
  - name: Drivers
    ports: []
    modules: [{ name: Imu, ports: [] }]
links: []
`)

describe('modules of dependencies used as types', () => {
  const station = (): Project =>
    produce(
      load(`
schemaVersion: 1
project: { name: Station }
types: []
interfaces: []
modules: [{ name: Monitor, ports: [] }]
links: []
`),
      (d) => {
        addDependency(d, lib, 'lib.scaffold.yaml', 'station.scaffold.yaml')
        const imu = dependencyModuleRef(d.dependencies[0]!.id, 'Drivers.Imu')
        d.modules[0]!.attributes.push({
          id: 'imu',
          name: 'imu',
          type: { kind: 'ref', id: imu },
          description: ''
        })
      }
    )

  it('copies references to the modules of a dependency', () => {
    const p = station()
    const dep = p.dependencies[0]!
    const reading = p.types.find((t) => t.name === 'Reading') as StructDef
    expect(reading.fields[0]!.type).toEqual({ kind: 'ref', id: dependencyModuleRef(dep.id, 'Drivers.Imu') })
    expect(messages(p)).toEqual([])
  })

  it('writes them as Dep/Path and reads them back', () => {
    const p = station()
    const f = toFile(p, { editor: true })
    expect(f.modules[0]!.attributes![0]!.type).toEqual(ref('Lib/Drivers.Imu'))
    expect(f.dependencies![0]!.types[0]).toMatchObject({ fields: [{ type: ref('Lib/Drivers.Imu') }] })
    const q = fromFile(JSON.parse(JSON.stringify(f)))
    expect(q.modules[0]!.attributes[0]!.type).toEqual({
      kind: 'ref',
      id: dependencyModuleRef(q.dependencies[0]!.id, 'Drivers.Imu')
    })
    expect(messages(q)).toEqual([])
  })

  it('keeps a dependency whose modules are used', () => {
    const p = station()
    let users: string[] = []
    produce(p, (d) => void (users = removeDependency(d, d.dependencies[0]!.id)))
    expect(users).toEqual(['Monitor.imu'])
  })

  it('flags references to modules of removed dependencies', () => {
    const p = produce(station(), (d) => {
      d.dependencies = []
      d.types = d.types.filter((t) => !t.dependency)
    })
    expect(messages(p)).toEqual(['Monitor.imu: references a deleted type or module'])
  })
})
