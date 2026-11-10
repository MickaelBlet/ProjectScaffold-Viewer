import { describe, expect, it } from 'vitest'
import { filterItems } from '@/components/completion'
import { completeDsl } from '@/components/dslCompletion'
import { braceFoldAt, bracePairs } from '@/components/dslScan'

const names = {
  interfaces: ['Sink', 'Query'],
  modules: ['Plant', 'Plant.Store'],
  placed: { Robot: ['Core'] },
  types: ['Reading', 'State'],
  ports: { Plant: ['feed', 'query'], 'Plant.Store': ['query'], 'Robot/Core': ['out'] }
}

/** Completion labels at the `|` of the text, null when none. */
function at(text: string): string[] | null {
  const pos = text.indexOf('|')
  const r = completeDsl(text.replace('|', ''), pos, names)
  return r && filterItems(r).map((i) => i.label)
}

describe('Scaffold text completion', () => {
  it('completes the words starting a file statement', () => {
    expect(at('mod|')).toEqual(['module'])
    expect(at('module A {}\n|')).toContain('struct')
    expect(at('class |')).toEqual(['module'])
    expect(at('class module A |')).toEqual(['final', 'implements'])
    expect(at('module Box<T> f|')).toEqual(['final'])
  })

  it('completes module members and their types', () => {
    const labels = at('module A {\n  |\n}')!
    expect(labels).toEqual(
      expect.arrayContaining(['in', 'constructor', 'static', 'int32', 'Reading', 'Plant'])
    )
    expect(at('module A {\n  static |')).toContain('uint8')
    expect(at('module A {\n  int32 |')).toBeNull()
    expect(at('module A {\n  int32 get() |')).toEqual([
      'const',
      'noexcept',
      'raises',
      'override',
      'final',
      'pure'
    ])
    expect(at('module A {\n  int32 get() const ov|')).toEqual(['override'])
    expect(at('interface I {\n  int32 get() |')).toEqual(['raises'])
  })

  it('completes interfaces of ports and implements', () => {
    expect(at('module A {\n  in |')).toEqual(['?', 'Sink', 'Query'])
    expect(at('module A implements Sink, Q|')).toEqual(['Query'])
    expect(at('module A : Pl|')).toEqual(['Plant', 'Plant.Store'])
  })

  it('completes types in fields, type arguments and parameters', () => {
    expect(at('struct S {\n  map<string, Rea|')).toEqual(['Reading'])
    expect(at('struct S {\n  map<string, int32> |')).toBeNull()
    expect(at('interface I {\n  bool get(out |')).toContain('float64')
    expect(at('interface I {\n  bool get(out float64 |')).toBeNull()
    expect(at('interface I {\n  bool get(string key, |')).toContain('inout')
    expect(at('enum E : |')).toContain('uint16')
  })

  it('completes link ends with their ports, then clauses', () => {
    expect(at('link a: Plant.|')).toEqual(['Plant.Store', 'Plant.feed', 'Plant.query', 'Plant.Store.query'])
    expect(at('link a: Plant.feed -> Robot/|')).toEqual(['Robot/Core', 'Robot/Core.out'])
    expect(at('link a: Plant.feed -> Plant.Store.query |')).toContain('ack')
  })

  it('completes states of a state machine', () => {
    expect(at('module A {\n  statemachine {\n    state Idle;\n    initial |')).toEqual(['Idle'])
    expect(at('module A {\n  statemachine {\n    state Idle;\n    state Run;\n    Idle -> |')).toEqual([
      'Idle',
      'Run'
    ])
  })

  it('offers nothing in comments, strings, values and options', () => {
    expect(at('// mod|')).toBeNull()
    expect(at('project "mod|')).toBeNull()
    expect(at('module A [copy = |')).toBeNull()
    expect(at('x = { a: |')).toBeNull()
    expect(at('struct S {\n  int32 x = 1|')).toBeNull()
  })
})

describe('Scaffold text folding', () => {
  const text = 'module A {\n  struct S { int32 x; }\n  x = "{";\n  /* { */\n}\nenum E : int8 {\n'
  const pairs = bracePairs(text)

  it('pairs braces outside strings and comments', () => {
    expect(pairs.map((p) => [text[p.open], text[p.close]])).toEqual([
      ['{', '}'],
      ['{', '}']
    ])
  })

  it('folds blocks spanning lines only', () => {
    const line = (n: number): [number, number] => {
      const lines = text.split('\n')
      const from = lines.slice(0, n).join('\n').length + (n ? 1 : 0)
      return [from, from + lines[n]!.length]
    }
    expect(braceFoldAt(pairs, ...line(0))).toEqual({ from: 10, to: text.indexOf('}\nenum') })
    expect(braceFoldAt(pairs, ...line(1))).toBeNull()
    expect(braceFoldAt(pairs, ...line(5))).toBeNull()
  })
})
