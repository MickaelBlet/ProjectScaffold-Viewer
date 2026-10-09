import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { idlProblems } from '@/components/fileDiagnostics'

describe('idlProblems', () => {
  it('accepts the examples', () => {
    const text = readFileSync('examples/idl/robot_control.idl', 'utf8')
    expect(idlProblems(text, 'robot_control.idl').filter((p) => p.severity === 'error')).toEqual([])
  })

  it('gives the line of a syntax error', () => {
    const [p] = idlProblems(
      'module A {\n  struct S { long x; };\n  interface I { void f(in long); };\n};\n',
      'a.idl'
    )
    expect(p).toMatchObject({ line: 3, severity: 'error' })
  })
})
