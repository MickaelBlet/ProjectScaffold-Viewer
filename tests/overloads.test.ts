import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, reloadText, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { overloadName, unimplementedMethods } from '@/model/project'
import type { Project } from '@/model/types'

const int32 = { kind: 'primitive', name: 'int32' }
const text = { kind: 'primitive', name: 'string' }
const source = `
schemaVersion: 1
project:
  name: Overloads
types: []
interfaces: []
modules:
  - name: Writer
    kind: abstract
    methods:
      - name: write
        virtual: true
        pure: true
        params:
          - { name: value, type: ${JSON.stringify(int32)} }
        returns: null
      - name: write
        virtual: true
        pure: true
        params:
          - { name: value, type: ${JSON.stringify(text)} }
          - { name: repeat, type: ${JSON.stringify(int32)}, default: 1 }
        returns: null
    ports: []
  - name: Console
    bases: [Writer]
    methods:
      - name: write
        virtual: true
        override: true
        params:
          - { name: value, type: ${JSON.stringify(int32)} }
        returns: null
      - name: write
        virtual: true
        override: true
        params:
          - { name: value, type: ${JSON.stringify(text)} }
          - { name: repeat, type: ${JSON.stringify(int32)}, default: 1 }
        returns: null
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

describe('overloaded methods', () => {
  it('loads overloads with parameter defaults and writes them back', () => {
    const p = load()
    expect(mod(p, 'Console').methods.map(overloadName)).toEqual(['write(int32)', 'write(string, int32)'])
    expect(mod(p, 'Console').methods[1]!.params[1]!.default).toBe(1)
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(
      toFile(fromFile(toFile(p, { editor: false })), { editor: false }).modules
    )
    expect(toFile(p, { editor: false }).modules[1]!.methods![1]!.params[1]).toEqual({
      name: 'repeat',
      type: int32,
      default: 1
    })
  })

  it('keeps the ids of each overload on reload', () => {
    const p = load()
    const again = reloadText(saveText(p, 'yaml', { editor: true }), 'yaml', p)
    expect(mod(again, 'Console').methods.map((x) => x.id)).toEqual(mod(p, 'Console').methods.map((x) => x.id))
    expect(new Set(mod(p, 'Console').methods.map((x) => x.id)).size).toBe(2)
  })

  it('flags overloads of the same parameters', () => {
    const p = load()
    mod(p, 'Console').methods[1]!.params.pop()
    mod(p, 'Console').methods[1]!.params[0]!.type = { kind: 'primitive', name: 'int32' }
    expect(messages(p)).toContain("Console: duplicate method 'write'")
  })

  it('matches overrides and pure methods by their parameters', () => {
    const p = load()
    mod(p, 'Console').methods.pop()
    expect(unimplementedMethods(p, mod(p, 'Console').id).map((u) => overloadName(u.method))).toEqual([
      'write(string, int32)'
    ])
    mod(p, 'Console').methods[0]!.params[0]!.type = { kind: 'primitive', name: 'bool' }
    expect(messages(p)).toContain('Console.write: signature differs from Writer.write it overrides')
  })
})

describe('parameter defaults', () => {
  it('checks defaults against types and directions', () => {
    const p = load()
    const [value, repeat] = mod(p, 'Console').methods[1]!.params
    repeat!.default = 'many'
    expect(messages(p)).toEqual(['Console.write(repeat) default: Expected an integer, got text many'])
    repeat!.default = 1
    repeat!.direction = 'out'
    expect(messages(p)).toContain('Console.write(repeat): an out parameter cannot have a default')
    repeat!.direction = 'in'
    value!.default = 'hello'
    delete repeat!.default
    expect(messages(p)).toContain(
      'Console.write(repeat): needs a default or to move before value, which has one'
    )
  })
})
