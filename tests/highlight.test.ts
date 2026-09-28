import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { highlight, layoutLines, type Token } from '@/components/highlight'

const colored = (tokens: Token[]) => tokens.filter((t) => t.kind).map((t) => [t.kind, t.text])

describe('highlight', () => {
  it('covers the whole text', () => {
    const yaml = readFileSync('examples/robot.scaffold.yaml', 'utf8')
    expect(
      highlight(yaml, 'yaml')
        .map((t) => t.text)
        .join('')
    ).toBe(yaml)
    const json = JSON.stringify({ a: [1, 'x', null], 'b c': { d: true } }, null, 2)
    expect(
      highlight(json, 'json')
        .map((t) => t.text)
        .join('')
    ).toBe(json)
  })

  it('colors YAML keys, scalars, comments and block scalars', () => {
    const text = [
      '- name: Core # top',
      '  width: 120',
      "  ok: 'it''s'",
      '  on: true',
      '  list: [a, 2]',
      '  text: |-',
      '    key: not a key',
      '  next: ~'
    ].join('\n')
    expect(colored(highlight(text, 'yaml'))).toEqual([
      ['punct', '-'],
      ['key', 'name'],
      ['punct', ':'],
      ['string', 'Core'],
      ['comment', ' # top'],
      ['key', 'width'],
      ['punct', ':'],
      ['number', '120'],
      ['key', 'ok'],
      ['punct', ':'],
      ['string', "'it''s'"],
      ['key', 'on'],
      ['punct', ':'],
      ['literal', 'true'],
      ['key', 'list'],
      ['punct', ':'],
      ['punct', '['],
      ['string', 'a'],
      ['punct', ','],
      ['number', '2'],
      ['punct', ']'],
      ['key', 'text'],
      ['punct', ':'],
      ['punct', '|-'],
      ['string', 'key: not a key'],
      ['key', 'next'],
      ['punct', ':'],
      ['literal', '~']
    ])
  })

  it('tells JSON keys from string values', () => {
    expect(colored(highlight('{"a": "b", "n": -1.5e3}', 'json'))).toEqual([
      ['punct', '{'],
      ['key', '"a"'],
      ['punct', ':'],
      ['string', '"b"'],
      ['punct', ','],
      ['key', '"n"'],
      ['punct', ':'],
      ['number', '-1.5e3'],
      ['punct', '}']
    ])
  })

  it('marks indent guides, blank lines, trailing spaces and tabs', () => {
    const lines = layoutLines(['a:', '  b:', '', '    c: 1 ', '\td: x'].join('\n'), 'yaml')
    const marks = lines.map((l) =>
      l
        .map((p) =>
          p.guide ? '|' : p.ws === 'space' ? '.' : p.ws === 'tab' ? '>' : p.virtual ? '_' : p.text
        )
        .join('')
    )
    expect(marks).toEqual(['a:', '|.b:', '|_', '|.|.c: 1.', '>d: x'])
  })
})
