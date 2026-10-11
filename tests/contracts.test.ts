import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { contractNames, unknownNames } from '@/model/contracts'
import type { Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Contracts
types:
  - kind: enum
    name: Mode
    underlying: uint8
    values:
      - name: Idle
        value: 0
      - name: Run
        value: 1
interfaces: []
constants:
  - name: Limit
    type:
      kind: primitive
      name: uint32
    value: 100
modules:
  - name: Stack
    invariants:
      - count <= Limit
      - mode != Mode.Run or count > 0
    attributes:
      - name: count
        type:
          kind: primitive
          name: uint32
        default: 0
      - name: mode
        type:
          kind: ref
          name: Mode
        default: Idle
    methods:
      - name: push
        params:
          - name: value
            type:
              kind: primitive
              name: int32
        returns: null
        pre:
          - count < Limit
        post:
          - count == old(count) + 1
      - name: top
        const: true
        params: []
        returns:
          kind: primitive
          name: int32
        pre:
          - count > 0
        post:
          - result == items[count - 1]
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const warnings = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'warning')
    .map((pr) => pr.message)

describe('contracts', () => {
  it('reads names of expressions, skipping members, strings and numbers', () => {
    expect(contractNames('a.b + f(c, "d e") >= 1e5 and x::y')).toEqual(['a', 'f', 'c', 'and', 'x'])
    expect(unknownNames('count > 0 and len(items) < max', new Set(['count']))).toEqual(['items'])
  })

  it('loads conditions and writes them back', () => {
    const p = load()
    expect(mod(p, 'Stack').invariants).toHaveLength(2)
    expect(mod(p, 'Stack').methods[0]).toMatchObject({ pre: ['count < Limit'] })
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('warns about names a condition uses that name nothing', () => {
    const p = load()
    expect(warnings(p)).toEqual(["Stack.top postcondition: 'items' names nothing here"])
    mod(p, 'Stack').methods[0]!.post = ['result > 0']
    expect(warnings(p)).toContain("Stack.push postcondition: 'result' names nothing here")
    mod(p, 'Stack').invariants = ['value > 0']
    expect(warnings(p)).toContain("Stack invariant: 'value' names nothing here")
  })
})
