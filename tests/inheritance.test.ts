import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { copyItems, pasteClip } from '@/model/clipboard'
import { canDerive, contentTop, setMethodQualifier, unimplementedMethods } from '@/model/project'
import { inheritEdges } from '@/canvas/inheritEdges'
import type { Method, Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Shapes
types: []
interfaces: []
modules:
  - name: IShape
    kind: interface
    methods:
      - name: area
        const: true
        virtual: true
        pure: true
        params: []
        returns:
          kind: primitive
          name: float64
    ports: []
  - name: Base
    kind: abstract
    bases:
      - IShape
    methods:
      - name: name
        virtual: true
        params: []
        returns:
          kind: primitive
          name: string
    ports: []
    modules:
      - name: Circle
        bases:
          - Base
        attributes:
          - name: radius
            type:
              kind: primitive
              name: float64
        methods:
          - name: area
            const: true
            virtual: true
            override: true
            params: []
            returns:
              kind: primitive
              name: float64
        ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const method = (p: Project, module: string, name: string) =>
  mod(p, module).methods.find((x) => x.name === name)!
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('module kinds and bases', () => {
  it('loads kinds, bases and method qualifiers, and writes them back', () => {
    const p = load()
    expect(mod(p, 'IShape').kind).toBe('interface')
    expect('kind' in mod(p, 'Circle')).toBe(false)
    expect(mod(p, 'Circle').bases).toEqual([mod(p, 'Base').id])
    expect(method(p, 'Circle', 'area')).toMatchObject({ const: true, virtual: true, override: true })
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false })).toEqual(
      toFile(fromFile(toFile(p, { editor: false })), { editor: false })
    )
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('reads kind class as no kind', () => {
    const data = structuredClone(example)
    data.modules[1].modules[0].kind = 'class'
    const p = fromFile(data)
    expect('kind' in mod(p, 'Circle')).toBe(false)
    expect(toFile(p, { editor: false }).modules[1]!.modules![0]!.kind).toBeUndefined()
  })

  it('reports unknown bases', () => {
    const data = structuredClone(example)
    data.modules[1].bases = ['Nope']
    expect(() => fromFile(data)).toThrow(LoadError)
    expect(() => fromFile(data)).toThrow("Module 'Base': unknown base 'Nope'")
  })

  it('writes bases as paths that follow renames', () => {
    const p = load()
    mod(p, 'Base').name = 'Shape'
    expect(toFile(p, { editor: false }).modules[1]!.modules![0]!.bases).toEqual(['Shape'])
  })
})

describe('inheritance checks', () => {
  it('flags inconsistent method qualifiers', () => {
    const p = load()
    const name = method(p, 'Base', 'name')
    name.static = true
    expect(messages(p)).toEqual(['Base.name: a static method cannot be virtual'])
    delete name.static
    delete name.virtual
    name.override = true
    expect(messages(p)).toContain('Base.name: a override method must be virtual')
  })

  it('flags pure methods in concrete modules and impure ones in interfaces', () => {
    const p = load()
    method(p, 'Circle', 'area').pure = true
    expect(messages(p)).toEqual([
      'Base.Circle.area: pure method in a concrete module (make it abstract or an interface)'
    ])
    const q = load()
    delete method(q, 'IShape', 'area').pure
    mod(q, 'IShape').attributes = mod(q, 'Circle').attributes
    expect(messages(q)).toEqual([
      'IShape.area: methods of an interface module must be pure',
      'IShape: an interface module cannot have attributes'
    ])
  })

  it('flags inheritance cycles and repeated bases', () => {
    const p = load()
    mod(p, 'IShape').bases = [mod(p, 'Circle').id]
    expect(messages(p)).toEqual(
      expect.arrayContaining([
        'IShape derives from itself through its bases',
        'Base derives from itself through its bases',
        'Base.Circle derives from itself through its bases'
      ])
    )
    const q = load()
    mod(q, 'Circle').bases = [mod(q, 'Base').id, mod(q, 'Base').id]
    expect(messages(q)).toEqual(['Base.Circle derives from Base more than once'])
    expect(canDerive(q, mod(q, 'IShape').id, mod(q, 'Circle').id)).toBe(false)
    expect(canDerive(q, mod(q, 'Circle').id, mod(q, 'IShape').id)).toBe(true)
  })

  it('checks overrides against the base method', () => {
    const p = load()
    method(p, 'Circle', 'area').name = 'perimeter'
    expect(messages(p)).toEqual([
      'Base.Circle.perimeter: overrides no virtual method of a base',
      'Base.Circle does not implement pure method IShape.area (implement it or make the module abstract)'
    ])
    const q = load()
    delete method(q, 'Circle', 'area').const
    expect(messages(q)).toEqual(['Base.Circle.area: signature differs from IShape.area it overrides'])
  })

  it('warns about virtual methods redefined without override', () => {
    const p = load()
    delete method(p, 'Circle', 'area').override
    expect(messages(p, 'warning')).toEqual(['Base.Circle.area: hides virtual IShape.area (mark it override)'])
  })

  it('lists pure methods left to implement', () => {
    const p = load()
    expect(unimplementedMethods(p, mod(p, 'Circle').id)).toEqual([])
    expect(unimplementedMethods(p, mod(p, 'Base').id).map((u) => [u.base.name, u.method.name])).toEqual([
      ['IShape', 'area']
    ])
    mod(p, 'Circle').methods = []
    expect(unimplementedMethods(p, mod(p, 'Circle').id).map((u) => u.method.name)).toEqual(['area'])
  })
})

describe('method qualifiers', () => {
  const blank = (): Method => ({ id: 'm', name: 'f', description: '', params: [], returns: null })

  it('keeps virtual, pure, override and static consistent', () => {
    const m = blank()
    setMethodQualifier(m, 'pure', true)
    expect(m).toMatchObject({ virtual: true, pure: true })
    setMethodQualifier(m, 'override', true)
    setMethodQualifier(m, 'virtual', false)
    expect([m.virtual, m.pure, m.override]).toEqual([undefined, undefined, undefined])
    setMethodQualifier(m, 'override', true)
    setMethodQualifier(m, 'static', true)
    expect([m.static, m.virtual, m.override]).toEqual([true, undefined, undefined])
    setMethodQualifier(m, 'virtual', true)
    expect([m.static, m.virtual]).toEqual([undefined, true])
  })
})

describe('copy and paste', () => {
  it('rebinds bases to pasted modules and keeps the others', () => {
    const p = load()
    const clip = copyItems(p, [mod(p, 'Circle').id])!
    const next = produce(p, (d) => void pasteClip(d, clip, { parent: 'original' }))
    const copy = next.modules.at(-1)!
    expect(copy.bases).toEqual([mod(p, 'Base').id])

    const both = copyItems(p, [mod(p, 'IShape').id, mod(p, 'Base').id])!
    const other = produce(
      fromFile({ ...structuredClone(example), modules: [] }),
      (d) => void pasteClip(d, both, { parent: null })
    )
    const [shape, base, circle] = other.modules
    expect(base!.bases).toEqual([shape!.id])
    expect(circle!.bases).toEqual([base!.id])
    expect(validate(other)).toEqual([])
  })

  it('drops bases missing from the target', () => {
    const p = load()
    const clip = copyItems(p, [mod(p, 'Circle').id])!
    const other = produce(
      fromFile({ ...structuredClone(example), modules: [] }),
      (d) => void pasteClip(d, clip, { parent: null })
    )
    expect('bases' in other.modules[0]!).toBe(false)
  })
})

describe('inheritance arrows', () => {
  it('draws an edge per visible base, dashed to interfaces, below the header of a container', () => {
    const p = load()
    const all = new Set(p.modules.map((m) => m.id))
    expect(inheritEdges(p, all).map((e) => [e.source, e.target, e.data])).toEqual([
      [mod(p, 'Base').id, mod(p, 'IShape').id, { realization: true }],
      // Circle is inside Base: the arrow stops below Base's header and methods.
      [
        mod(p, 'Circle').id,
        mod(p, 'Base').id,
        { realization: false, inset: contentTop(p.orientation, mod(p, 'Base')) }
      ]
    ])
    all.delete(mod(p, 'IShape').id)
    expect(inheritEdges(p, all).map((e) => e.target)).toEqual([mod(p, 'Base').id])
  })
})
