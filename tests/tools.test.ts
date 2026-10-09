import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { align, distribute, sameSize } from '@/model/align'
import { fuzzyFilter, fuzzyMatch } from '@/model/fuzzy'
import { searchProject } from '@/model/search'
import { fromFile } from '@/model/serialize'
import type { Rect } from '@/model/types'

const rects = new Map<string, Rect>([
  ['a', { x: 0, y: 0, width: 100, height: 50 }],
  ['b', { x: 300, y: 40, width: 50, height: 20 }],
  ['c', { x: 120, y: 100, width: 80, height: 30 }]
])

describe('align', () => {
  it('aligns on the selection bounds', () => {
    expect([...align(rects, 'left').values()].map((r) => r.x)).toEqual([0, 0, 0])
    expect([...align(rects, 'right').values()].map((r) => r.x + r.width)).toEqual([350, 350, 350])
    expect([...align(rects, 'vcenter').values()].map((r) => r.y + r.height / 2)).toEqual([65, 65, 65])
  })

  it('distributes with equal gaps, keeping the ends', () => {
    const out = distribute(rects, 'h')
    expect(out.get('a')!.x).toBe(0)
    expect(out.get('b')!.x).toBe(300)
    // total width 230, span 350: gap 60.
    expect(out.get('c')!.x).toBe(160)
  })

  it('gives the largest size', () => {
    expect([...sameSize(rects, 'both').values()].every((r) => r.width === 100 && r.height === 50)).toBe(true)
  })
})

describe('fuzzy', () => {
  it('matches characters in order', () => {
    expect(fuzzyMatch('sav', 'Save project')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'Save project')).toBeNull()
  })

  it('ranks word starts and prefixes first', () => {
    const items = ['Export JSON', 'Open…', 'Save as…', 'Arrange selection']
    expect(fuzzyFilter('as', items, (s) => s)[0]!.item).toBe('Save as…')
    expect(fuzzyFilter('op', items, (s) => s)[0]!.item).toBe('Open…')
  })
})

describe('search', () => {
  const example = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
  it('finds names, descriptions and metadata', () => {
    expect(searchProject(example, 'operator').map((h) => h.label)).toContain('Operator')
    expect(searchProject(example, 'team-a')[0]).toMatchObject({ label: 'Core', field: 'metadata owner' })
    expect(searchProject(example, 'position').some((h) => h.label === 'Pose.position')).toBe(true)
    expect(searchProject(example, '  ')).toEqual([])
  })
})
