import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, loadText, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { parseTypeExpr, printTypeExpr } from '@/model/typeExpr'
import { canUseType, modulePath, nameError, typeNames, typeScope } from '@/model/project'
import { diffRenames } from '@/model/sync'
import { applyDependencyRenames } from '@/model/dependencies'
import { outline } from '@/model/outline'
import { targetPath } from '@/model/locate'
import { copyItems, pasteClip } from '@/model/clipboard'
import type { Project, StructDef } from '@/model/types'
import type { FileProject } from '@/model/schema'

const exampleText = readFileSync('examples/robot.scaffold.yaml', 'utf8')
const example = YAML.parse(exampleText)
/** The example, with the types and interfaces of its dependencies made its own. */
const load = (): Project => {
  const p = fromFile(structuredClone(example))
  for (const e of [...p.types, ...p.interfaces]) delete e.dependency
  p.dependencies = []
  return p
}
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!
const typeOf = (p: Project, key: string) => p.types.find((t) => typeNames(p).get(t.id) === key)!
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('types of modules', () => {
  it('loads them owned by their module, named by their module path', () => {
    const p = fromFile(example)
    const sensor = byPath(p, 'Core.Sensor')
    const filter = typeOf(p, 'Core.Sensor.Filter')
    expect(filter.module).toBe(sensor.id)
    expect(typeOf(p, 'Core.Sensor.Sample').access).toBe('protected')
    expect(sensor.attributes.find((a) => a.name === 'filter')!.type).toEqual({ kind: 'ref', id: filter.id })
    const file = toFile(p, { editor: false })
    expect(file.types.map((t) => t.name)).not.toContain('Filter')
    expect(file.modules[0]!.modules![0]!.types).toEqual(example.modules[0].modules[0].types)
  })

  it('round-trips through text, keeping their ids', () => {
    const p = fromFile(example)
    const again = loadText(saveText(p, 'yaml', { editor: true }), 'yaml')
    expect(toFile(again, { editor: true })).toEqual(toFile(p, { editor: true }))
  })

  it('reports unknown and duplicate types of modules', () => {
    const bad = structuredClone(example) as FileProject
    bad.modules[0]!.modules![0]!.types!.push({ kind: 'primitive', name: 'Filter' })
    expect(() => fromFile(bad)).toThrow(/Duplicate type name 'Core.Sensor.Filter'/)
    const unknown = structuredClone(example) as FileProject
    const filter = unknown.modules[0]!.modules![0]!.attributes![2]!
    if (filter.type.kind === 'ref') filter.type.name = 'Core.Filter'
    expect(() => fromFile(unknown)).toThrow(/unknown type 'Core.Filter'/)
  })

  it('parses and prints qualified names in type expressions', () => {
    for (const src of ['Core.Sensor.Mode', 'vector<Dep/Core.Sensor.Mode, 4>', 'map<string, Core.Sample>'])
      expect(printTypeExpr(parseTypeExpr(src))).toBe(src)
  })

  it('names them in a module as C++ does: its own and its bases by name, the others qualified', () => {
    const p = produce(load(), (d) => {
      byPath(d, 'Core.Controller').bases = [byPath(d, 'Core.Sensor').id]
    })
    const filter = typeOf(p, 'Core.Sensor.Filter')
    const sample = typeOf(p, 'Core.Sensor.Sample')
    const inSensor = typeScope(p, byPath(p, 'Core.Sensor').id)
    expect(inSensor.nameOf(filter.id)).toBe('Filter')
    expect(inSensor.idOf('Sample')).toBe(sample.id)
    const derived = typeScope(p, byPath(p, 'Core.Controller').id)
    expect(derived.nameOf(sample.id)).toBe('Sample')
    const other = typeScope(p, byPath(p, 'Core.Logger').id)
    expect(other.nameOf(filter.id)).toBe('Core.Sensor.Filter')
    expect(other.idOf('Core.Sensor.Filter')).toBe(filter.id)
    expect(other.usable.map((u) => u.name)).toContain('Core.Sensor.Filter')
    expect(other.usable.map((u) => u.name)).not.toContain('Core.Sensor.Sample')
    // Outside modules: the public ones only, by qualified name.
    const outside = typeScope(p, null).usable.filter((u) => u.type.module)
    expect(outside.map((u) => u.name)).toContain('Core.Sensor.Filter')
    expect(outside.some((u) => u.type.access)).toBe(false)
  })

  it('lets modules use them as their access allows', () => {
    const p = load()
    const sample = typeOf(p, 'Core.Sensor.Sample')
    expect(canUseType(p, byPath(p, 'Core.Sensor').id, sample)).toBe(true)
    expect(canUseType(p, byPath(p, 'Core.Logger').id, sample)).toBe(false)
    expect(canUseType(p, null, typeOf(p, 'Core.Sensor.Filter'))).toBe(true)
    expect(canUseType(p, null, sample)).toBe(false)
    const derived = produce(p, (d) => void (byPath(d, 'Core.Logger').bases = [byPath(d, 'Core.Sensor').id]))
    expect(canUseType(derived, byPath(derived, 'Core.Logger').id, sample)).toBe(true)
  })

  it('flags types of modules used where their access does not reach', () => {
    const p = load()
    expect(messages(p)).toEqual([])
    const sample = typeOf(p, 'Core.Sensor.Sample')
    const logger = produce(p, (d) => {
      byPath(d, 'Core.Logger').attributes.push({
        id: 'x',
        name: 'sample',
        type: { kind: 'ref', id: sample.id },
        description: ''
      })
    })
    expect(messages(logger)).toEqual(["Core.Logger.sample: 'Core.Sensor.Sample' is protected in Core.Sensor"])
    const outside = (key: string) =>
      produce(p, (d) => {
        const vec3 = d.types.find((t) => t.name === 'Vec3') as StructDef
        vec3.fields.push({
          id: 'y',
          name: 'field',
          type: { kind: 'ref', id: typeOf(d, key).id },
          description: ''
        })
      })
    // Public ones are used anywhere.
    expect(messages(outside('Core.Sensor.Filter'))).toEqual([])
    expect(messages(outside('Core.Sensor.Sample'))).toEqual([
      "Vec3.field: 'Core.Sensor.Sample' is a protected type of module Core.Sensor, used by modules only"
    ])
  })

  it('warns about public members using less accessible types', () => {
    const p = produce(load(), (d) => {
      const last = byPath(d, 'Core.Sensor').attributes.find((a) => a.name === 'last')!
      delete last.access
    })
    expect(messages(p, 'warning')).toContain(
      "Core.Sensor.last: public member uses protected type 'Core.Sensor.Sample'"
    )
  })

  it('names them uniquely in their module, apart from its members', () => {
    const p = load()
    const sensor = byPath(p, 'Core.Sensor')
    expect(nameError(p, { kind: 'type', module: sensor.id }, 'Sample')).toMatch(/already has a type/)
    expect(nameError(p, { kind: 'type', module: sensor.id }, 'rateHz')).toMatch(/attribute, method/)
    expect(nameError(p, { kind: 'type', module: sensor.id }, 'Mode')).toBeNull()
    expect(nameError(p, { kind: 'type' }, 'Filter')).toBeNull()
    const clash = produce(p, (d) => void (typeOf(d, 'Core.Sensor.Filter').name = 'filter'))
    expect(messages(clash)).toEqual(["Core.Sensor: 'filter' is both a type and a member or submodule"])
  })

  it('carries renames of modules and of their types to dependent projects', () => {
    const p = load()
    const next = produce(p, (d) => {
      typeOf(d, 'Core.Sensor.Sample').name = 'Point'
      byPath(d, 'Core.Sensor').name = 'Lidar'
    })
    const r = diffRenames(p, next)!
    expect(r.moduleTypes).toEqual(
      new Map([
        ['Core.Sensor.Filter', 'Core.Lidar.Filter'],
        ['Core.Sensor.Sample', 'Core.Lidar.Point']
      ])
    )
    expect(r.types.size).toBe(0)
    const station = fromFile(YAML.parse(readFileSync('examples/station.scaffold.yaml', 'utf8')))
    const after = produce(station, (d) => applyDependencyRenames(d, 'robot.scaffold.yaml', r))
    expect(typeNames(after).get(after.types.find((t) => t.name === 'Point')!.id)).toBe(
      'Robot/Core.Lidar.Point'
    )
    expect(validate(after).filter((pr) => pr.severity === 'error')).toEqual([])
  })

  it('copies them with their module, and keeps their references', () => {
    const p = load()
    const sensor = byPath(p, 'Core.Sensor')
    const q = produce(p, (d) => void pasteClip(d, copyItems(p, [sensor.id])!, { parent: 'original' }))
    const copy = q.modules.find((m) => m.name === 'Sensor2')!
    const types = q.types.filter((t) => t.module === copy.id)
    expect(types.map((t) => [t.name, t.access])).toEqual([
      ['Filter', undefined],
      ['Sample', 'protected']
    ])
    expect(copy.attributes.find((a) => a.name === 'filter')!.type).toEqual({ kind: 'ref', id: types[0]!.id })
    expect(messages(q)).toEqual([])
  })

  it('outlines and locates them in the text', () => {
    const core = outline(exampleText).find((n) => n.name === 'Modules')!.children[0]!
    const sensor = core.children.find((n) => n.name === 'Sensor')!
    expect(sensor.children.slice(0, 2).map((n) => [n.name, n.kind])).toEqual([
      ['Filter', 'enum'],
      ['Sample', 'struct']
    ])
    const p = fromFile(example)
    expect(targetPath(example, p, { kind: 'type', id: typeOf(p, 'Core.Sensor.Sample').id })).toEqual([
      'modules',
      0,
      'modules',
      0,
      'types',
      1
    ])
  })
})
