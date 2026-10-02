import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { idlProblems, liquidProblems, userSections } from '@/components/fileDiagnostics'

describe('liquidProblems', () => {
  it('accepts the built-in templates', () => {
    for (const f of ['interface.hpp.liquid', '_value.liquid', 'CMakeLists.txt.liquid'])
      expect(liquidProblems(readFileSync(`templates/cpp17/${f}`, 'utf8'))).toEqual([])
  })

  it('gives the line of an unclosed tag', () => {
    const [p] = liquidProblems('a\nb\n{% if x %}\nc\n')
    expect(p).toMatchObject({ line: 3, severity: 'error' })
  })

  it('reports unknown filters and unclosed user sections', () => {
    expect(liquidProblems('{{ x | nope }}')).toHaveLength(1)
    expect(liquidProblems("{% user 'a' %}\nx\n")).toHaveLength(1)
  })
})

describe('idlProblems', () => {
  it('accepts the examples', () => {
    const text = readFileSync('examples/idl/robot_control.idl', 'utf8')
    expect(idlProblems(text, 'robot_control.idl').filter((p) => p.severity === 'error')).toEqual([])
  })

  it('gives the line of a syntax error', () => {
    const [p] = idlProblems('module A {\n  struct S { long x; };\n  interface I { void f(in long); };\n};\n', 'a.idl')
    expect(p).toMatchObject({ line: 3, severity: 'error' })
  })
})

describe('userSections', () => {
  it('finds the sections of a generated file', () => {
    const text = 'int f() {\n  // <user:body>\n  return 1;\n  // </user:body>\n}\n'
    const { sections, problems } = userSections(text)
    expect(problems).toEqual([])
    expect(sections).toMatchObject([{ id: 'body', start: 1, end: 3 }])
  })

  it('reads Python markers', () => {
    expect(userSections('# <user:a>\nx = 1\n# </user:a>\n').sections).toHaveLength(1)
  })

  it('reports broken markers on their line', () => {
    expect(userSections('// <user:a>\n// <user:b>\n').problems).toMatchObject([{ line: 2 }])
  })
})
