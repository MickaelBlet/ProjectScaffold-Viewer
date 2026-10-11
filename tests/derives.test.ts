import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import type { Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Derives
types:
  - kind: struct
    name: Point
    derives: [equality, ordering, hash]
    fields:
      - name: x
        type:
          kind: primitive
          name: int32
  - kind: struct
    name: Tags
    fields:
      - name: names
        type:
          kind: map
          key:
            kind: primitive
            name: string
          value:
            kind: primitive
            name: int32
interfaces: []
modules:
  - name: Marker
    derives: [equality, string]
    attributes:
      - name: at
        type:
          kind: ref
          name: Point
      - name: count
        static: true
        type:
          kind: ref
          name: Tags
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const errors = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'error')
    .map((pr) => pr.message)

describe('derived operations', () => {
  it('loads them and writes them back', () => {
    const p = load()
    expect(p.modules[0]!.derives).toEqual(['equality', 'string'])
    expect(errors(p)).toEqual([])
    const file = toFile(p, { editor: false })
    expect(file.modules).toEqual(example.modules)
    expect(file.types).toEqual(example.types)
  })

  it('checks that members support them', () => {
    const p = load()
    p.modules[0]!.derives = ['ordering', 'hash']
    p.modules[0]!.attributes[1]!.static = false
    expect(errors(p)).toEqual([
      'Marker: derives ordering, which needs equality',
      'Marker: derives hash, which needs equality',
      "Marker.count: struct 'Tags' does not derive ordering, no ordering",
      "Marker.count: struct 'Tags' does not derive hash, no hash"
    ])
    const tags = p.types[1]!
    if (tags.kind === 'struct') tags.derives = ['equality', 'hash']
    expect(errors(p)).toContain("Struct 'Tags'.names: a map, no hash")
    p.modules[0]!.kind = 'abstract'
    expect(errors(p)).toContain('Marker: an abstract module derives no operations')
  })
})
