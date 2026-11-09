import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DslError, dslLineOfPath, parseDsl, stringifyDsl } from '@/model/dsl'
import { formatFromPath, fromFile, LoadError, loadText, parseText, saveText, toFile } from '@/model/serialize'

const roots = ['examples', ...(process.env.DSL_EXTRA_ROOTS?.split(':') ?? [])]
const files = roots.flatMap((root) =>
  (readdirSync(root, { recursive: true }) as string[])
    .map((f) => join(root, f).split('\\').join('/'))
    .filter((f) => /\.scaffold\.(yaml|json)$/.test(f))
    .sort()
)
const data = (file: string): unknown => parseText(readFileSync(file, 'utf8'), formatFromPath(file))

describe('round trip', () => {
  it.each(files)('%s as read', (file) => {
    const d = data(file)
    expect(parseDsl(stringifyDsl(d))).toEqual(d)
  })
  it.each(files)('%s as saved', (file) => {
    const d = toFile(fromFile(data(file)), { editor: true })
    const text = stringifyDsl(d)
    expect(parseDsl(text)).toEqual(JSON.parse(JSON.stringify(d)))
    expect(stringifyDsl(parseDsl(text))).toBe(text)
  })
})

describe('syntax', () => {
  const minimal = 'syntax = "scaffold1";\nproject "P";\n'
  it('reads a small project', () => {
    const d = parseDsl(`${minimal}
enum State : int8 { Off = -1; On = 1; }
/// One sample
struct Reading {
  float64 value = 1.5 [constraints = { min: 0 }];
  State state = On;
  map<string, int32> tags = { a: 1 };
  optional<string> note = null;
}
interface Query { bool get(string key, out float64 value); }
interface Sink { void push(Reading r); }
abstract module Plant : Base implements Query {
  in Sink feed;
  in Query query;
  static const uint32 count = 0;
  virtual pure void run();
  module Store { in Sink \`in\`; in Query query; }
}
link plant_query: Plant.query <-> Plant.Store.query ack 20 low remote tcp;
`)
    expect(d.types).toMatchObject([
      {
        kind: 'enum',
        name: 'State',
        underlying: 'int8',
        values: [
          { name: 'Off', value: -1 },
          { name: 'On', value: 1 }
        ]
      },
      { kind: 'struct', name: 'Reading', description: 'One sample' }
    ])
    expect((d.modules as never[])[0]).toMatchObject({
      name: 'Plant',
      kind: 'abstract',
      bases: ['Base'],
      implements: ['Query'],
      attributes: [{ name: 'count', static: true, const: true, default: 0 }],
      methods: [{ name: 'run', virtual: true, pure: true, params: [], returns: null }],
      modules: [{ name: 'Store', ports: [{ name: 'in', role: 'in', interface: 'Sink' }, { name: 'query' }] }]
    })
    expect((d.links as never[])[0]).toMatchObject({
      from: { module: 'Plant', port: 'query' },
      to: { module: 'Plant.Store', port: 'query' },
      constraints: {
        direction: 'bidirectional',
        ack: { required: true, timeoutMs: 20 },
        performance: { class: 'low' },
        remote: { enabled: true, transport: 'tcp' }
      }
    })
  })
  it('reports errors with their line', () => {
    expect(() => parseDsl(`${minimal}struct A {\n  int32;\n}`)).toThrow(
      new DslError("expected a name, found ';'", 4)
    )
    try {
      parseDsl(`${minimal}\nmodule M {\n  bogus x y;\n}`)
    } catch (e) {
      expect((e as DslError).line).toBe(5)
    }
  })
  it('locates data paths', () => {
    const text = `${minimal}\nmodule M {\n  in ? p;\n}\n`
    expect(dslLineOfPath(text, ['modules', 0, 'ports', 0, 'interface'])).toBe(5)
    expect(dslLineOfPath(text, ['modules', 0, 'name'])).toBe(4)
  })
})

describe('serialize', () => {
  it('loads and saves .scaffold files', () => {
    expect(formatFromPath('a/robot.scaffold')).toBe('dsl')
    const p = loadText('syntax = "scaffold1";\nproject "P";\nmodule M {}\n', 'dsl')
    expect(p.modules.map((m) => m.name)).toEqual(['M'])
    expect(saveText(p, 'dsl', { editor: false })).toBe(
      'syntax = "scaffold1";\n\nproject "P";\n\nmodule M {}\n'
    )
  })
  it('locates schema errors', () => {
    try {
      loadText('syntax = "scaffold1";\nproject "P";\n\nmodule M {\n  in Sink 1;\n}\n', 'dsl')
      expect.unreachable()
    } catch (e) {
      expect((e as LoadError).problems[0]).toMatch(/^Line 5: Invalid Scaffold text: expected a name/)
    }
    try {
      loadText('syntax = "scaffold1";\nproject "P";\n\nmodule M {\n  color = 3;\n}\n', 'dsl')
      expect.unreachable()
    } catch (e) {
      expect((e as LoadError).problems[0]).toMatch(/^Line 5: /)
    }
  })
})
