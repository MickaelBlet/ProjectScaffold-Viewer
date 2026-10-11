import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { methodQualifierText, setMethodQualifier } from '@/model/project'
import type { Method, Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Final
types: []
interfaces: []
modules:
  - name: Base
    kind: abstract
    methods:
      - name: run
        virtual: true
        noexcept: true
        params: []
        returns: null
      - name: size
        virtual: true
        final: true
        const: true
        nodiscard: true
        params: []
        returns:
          kind: primitive
          name: uint32
    ports: []
  - name: Leaf
    final: true
    bases:
      - Base
    methods:
      - name: run
        virtual: true
        override: true
        noexcept: true
        params: []
        returns: null
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

describe('final, noexcept and nodiscard', () => {
  it('loads them and writes them back', () => {
    const p = load()
    expect(mod(p, 'Leaf').final).toBe(true)
    expect(method(p, 'Base', 'size')).toMatchObject({ final: true, nodiscard: true })
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('keeps qualifiers consistent', () => {
    const m: Method = { id: 'm', name: 'f', description: '', params: [], returns: null }
    setMethodQualifier(m, 'final', true)
    expect(m).toMatchObject({ virtual: true, final: true })
    setMethodQualifier(m, 'pure', true)
    expect(m.final).toBeUndefined()
    setMethodQualifier(m, 'final', true)
    expect(m.pure).toBeUndefined()
    setMethodQualifier(m, 'virtual', false)
    expect(m.final).toBeUndefined()
    setMethodQualifier(m, 'final', true)
    setMethodQualifier(m, 'static', true)
    expect(m).toMatchObject({ static: true })
    expect(m.final).toBeUndefined()
  })

  it('flags derivations from final modules and abstract final modules', () => {
    const p = load()
    p.modules.push({
      ...structuredClone(mod(p, 'Leaf')),
      id: 'more',
      name: 'More',
      bases: [mod(p, 'Leaf').id]
    })
    delete p.modules.at(-1)!.final
    expect(messages(p)).toEqual(['More derives from final module Leaf'])
    mod(p, 'Base').final = true
    expect(messages(p)).toContain('Base: an abstract module cannot be final')
  })

  it('flags overrides of final methods', () => {
    const p = load()
    mod(p, 'Leaf').methods.push({ ...structuredClone(method(p, 'Base', 'size')), id: 'x', override: true })
    delete mod(p, 'Leaf').methods.at(-1)!.final
    expect(messages(p)).toEqual(['Leaf.size: overrides final Base.size'])
  })

  it('warns about noexcept lost in an override and nodiscard without result', () => {
    const p = load()
    delete method(p, 'Leaf', 'run').noexcept
    method(p, 'Base', 'run').nodiscard = true
    expect(messages(p, 'warning')).toEqual([
      'Base.run: nodiscard but returns nothing',
      'Leaf.run: not noexcept, as Base.run it overrides is'
    ])
  })

  it('draws qualifiers around the method', () => {
    const p = load()
    expect(methodQualifierText(method(p, 'Base', 'size'))).toEqual({
      before: 'nodiscard virtual ',
      after: ' const final'
    })
    expect(methodQualifierText(method(p, 'Leaf', 'run')).after).toBe(' noexcept override')
  })
})
