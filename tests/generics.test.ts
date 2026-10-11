import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, reloadText, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { parseTypeExpr, printTypeExpr } from '@/model/typeExpr'
import { typeParamsOf, typeScope } from '@/model/project'
import { copyItems, pasteClip } from '@/model/clipboard'
import { produce } from 'immer'
import type { Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Generics
types: []
interfaces: []
modules:
  - name: Shape
    kind: abstract
    ports: []
  - name: Circle
    bases: [Shape]
    ports: []
  - name: Buffer
    typeParams:
      - name: T
        constraint: numeric
      - name: N
        default:
          kind: primitive
          name: uint32
    attributes:
      - name: items
        type:
          kind: vector
          of:
            kind: ref
            name: Buffer.T
      - name: size
        type:
          kind: ref
          name: Buffer.N
    ports: []
  - name: Gallery
    typeParams:
      - name: S
        derivesFrom: Shape
    ports: []
  - name: Samples
    bases:
      - Buffer<float32>
    attributes:
      - name: ints
        type:
          kind: ref
          name: Buffer
          args:
            - kind: primitive
              name: int16
            - kind: primitive
              name: uint8
      - name: shapes
        type:
          kind: ref
          name: Gallery
          args:
            - kind: ref
              name: Circle
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const errors = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'error')
    .map((pr) => pr.message)

describe('type expressions with type arguments', () => {
  it('parses and prints them', () => {
    const t = parseTypeExpr('map<string, Box<vector<int32>, Core.Sensor>>')
    expect(printTypeExpr(t)).toBe('map<string, Box<vector<int32>, Core.Sensor>>')
    expect(t.kind === 'map' && t.value).toEqual({
      kind: 'ref',
      name: 'Box',
      args: [
        { kind: 'vector', of: { kind: 'primitive', name: 'int32' } },
        { kind: 'ref', name: 'Core.Sensor' }
      ]
    })
  })
})

describe('generic modules', () => {
  it('loads type parameters, arguments and generic bases, and writes them back', () => {
    const p = load()
    const params = typeParamsOf(p, mod(p, 'Buffer').id)
    expect(params.map((t) => [t.name, t.typeParam])).toEqual([
      ['T', { constraint: 'numeric' }],
      ['N', { default: { kind: 'primitive', name: 'uint32' } }]
    ])
    expect(mod(p, 'Samples').baseArgs).toEqual({
      [mod(p, 'Buffer').id]: [{ kind: 'primitive', name: 'float32' }]
    })
    const shapes = mod(p, 'Samples').attributes[1]!.type
    expect(shapes).toEqual({
      kind: 'ref',
      id: mod(p, 'Gallery').id,
      args: [{ kind: 'ref', id: mod(p, 'Circle').id }]
    })
    expect(
      validate(p)
        .map((pr) => pr.message)
        .join(' | ')
    ).toBe('')
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('copies type parameters and the arguments of generic bases', () => {
    const p = load()
    const clip = copyItems(p, [mod(p, 'Buffer').id, mod(p, 'Samples').id])!
    const q = produce(p, (d) => void pasteClip(d, clip, { parent: null }))
    const [buffer, samples] = q.modules.slice(-2)
    expect(typeParamsOf(q, buffer!.id).map((t) => t.name)).toEqual(['T', 'N'])
    expect(samples!.bases).toEqual([buffer!.id])
    expect(samples!.baseArgs).toEqual({ [buffer!.id]: [{ kind: 'primitive', name: 'float32' }] })
    expect(errors(q)).toEqual([])
  })

  it('keeps ids on reload', () => {
    const p = load()
    const again = reloadText(saveText(p, 'yaml', { editor: true }), 'yaml', p)
    expect(typeParamsOf(again, mod(p, 'Buffer').id).map((t) => t.id)).toEqual(
      typeParamsOf(p, mod(p, 'Buffer').id).map((t) => t.id)
    )
  })

  it('names type parameters in their module only', () => {
    const p = load()
    expect(typeScope(p, mod(p, 'Buffer').id).idOf('T')).toBe(typeParamsOf(p, mod(p, 'Buffer').id)[0]!.id)
    expect(typeScope(p, mod(p, 'Samples').id).idOf('T')).toBeUndefined()
  })

  it('checks type arguments against type parameters', () => {
    const p = load()
    const [ints, shapes] = mod(p, 'Samples').attributes
    ints!.type = { kind: 'ref', id: mod(p, 'Buffer').id, args: [{ kind: 'primitive', name: 'string' }] }
    shapes!.type = { kind: 'ref', id: mod(p, 'Gallery').id, args: [{ kind: 'ref', id: mod(p, 'Buffer').id }] }
    expect(errors(p)).toEqual([
      'Samples.ints: T of Buffer: expects a number type',
      'Samples.shapes: S of Gallery: expects a module deriving from Shape',
      'Samples.shapes: Buffer needs a type argument for T'
    ])
    ints!.type = { kind: 'ref', id: mod(p, 'Buffer').id }
    shapes!.type = { kind: 'ref', id: mod(p, 'Circle').id, args: [{ kind: 'primitive', name: 'bool' }] }
    expect(errors(p)).toEqual([
      'Samples.ints: Buffer needs a type argument for T',
      'Samples.shapes: Circle takes no type arguments'
    ])
  })

  it('checks generic bases and parameter defaults', () => {
    const p = load()
    mod(p, 'Samples').baseArgs = {}
    const [t] = typeParamsOf(p, mod(p, 'Buffer').id)
    t!.typeParam!.default = { kind: 'primitive', name: 'bool' }
    // T has a default now: the base needs no argument.
    expect(errors(p)).toEqual(['Buffer<T> default: expects a number type'])
    delete t!.typeParam!.default
    expect(errors(p)).toEqual(['Samples base: Buffer needs a type argument for T'])
  })
})
