import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import type { Project } from '@/model/types'

const file = () => ({
  schemaVersion: 1,
  project: { name: 'Active' },
  types: [],
  interfaces: [{ name: 'Sink', messages: [{ name: 'push', params: [], returns: null }] }],
  modules: [
    {
      name: 'Worker',
      active: true,
      ports: [{ name: 'in', role: 'in', interface: 'Sink' }]
    },
    {
      name: 'Logger',
      active: { queue: 8, timeoutMs: 100, overflow: 'drop' },
      ports: [{ name: 'in', role: 'in', interface: 'Sink' }]
    }
  ],
  links: []
})

const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const messages = (p: Project, severity: string) =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('active modules', () => {
  it('loads active modules and writes them back', () => {
    const p = fromFile(file())
    expect(mod(p, 'Worker').active).toEqual({})
    expect(mod(p, 'Logger').active).toEqual({
      queue: 8,
      timeoutMs: 100,
      overflow: 'drop'
    })
    expect(validate(p)).toEqual([])
    const back = toFile(p, { editor: false }).modules
    expect(back[0]!.active).toBe(true)
    expect(back[1]!.active).toEqual({
      queue: 8,
      timeoutMs: 100,
      overflow: 'drop'
    })
  })

  it('checks active modules', () => {
    const p = fromFile(file())
    mod(p, 'Worker').kind = 'abstract'
    mod(p, 'Logger').instantiation = 'utility'
    expect(messages(p, 'error')).toContain('Worker: an active module is a class (not abstract)')
    expect(messages(p, 'error')).toContain('Logger: a utility module is not active')
    mod(p, 'Worker').ports = []
    expect(messages(p, 'warning')).toContain('Worker: active, without in ports to run calls of')
  })
})
