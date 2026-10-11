import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, reloadText, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import { copyItems, pasteClip } from '@/model/clipboard'
import type { Project } from '@/model/types'

const source = `
schemaVersion: 1
project:
  name: Machines
types: []
interfaces: []
modules:
  - name: Player
    attributes:
      - name: volume
        type: { kind: primitive, name: float32 }
    methods:
      - name: play
        params:
          - { name: from, type: { kind: primitive, name: float32 } }
        returns: null
      - name: stop
        params: []
        returns: null
      - name: reset
        params: []
        returns: null
    stateMachine:
      initial: Idle
      states:
        - name: Idle
          entry: reset
        - name: Playing
        - name: Closed
          final: true
      transitions:
        - from: Idle
          to: Playing
          trigger: play
          guard: from >= 0 and volume > 0
        - from: Playing
          to: Idle
          trigger: stop
          action: reset
        - from: Idle
          to: Closed
    ports: []
links: []
`
const example = YAML.parse(source)
const load = (): Project => fromFile(structuredClone(example))
const problems = (p: Project, severity: 'error' | 'warning') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('state machines', () => {
  it('loads them and writes them back', () => {
    const p = load()
    const m = p.modules[0]!
    const [play, stop, reset] = m.methods
    const [idle, playing, closed] = m.stateMachine!.states
    expect(m.stateMachine!.initial).toBe(idle!.id)
    expect(idle!.entry).toBe(reset!.id)
    expect(closed!.final).toBe(true)
    expect(m.stateMachine!.transitions.map((t) => [t.from, t.to, t.trigger, t.action])).toEqual([
      [idle!.id, playing!.id, play!.id, undefined],
      [playing!.id, idle!.id, stop!.id, reset!.id],
      [idle!.id, closed!.id, undefined, undefined]
    ])
    expect(validate(p)).toEqual([])
    expect(toFile(p, { editor: false }).modules).toEqual(example.modules)
  })

  it('reports unknown states and methods', () => {
    const data = structuredClone(example)
    data.modules[0].stateMachine.transitions[0].to = 'Nowhere'
    expect(() => fromFile(data)).toThrow(LoadError)
    const other = structuredClone(example)
    other.modules[0].stateMachine.states[0].exit = 'nope'
    expect(() => fromFile(other)).toThrow(LoadError)
  })

  it('follows renames of states and methods', () => {
    const p = load()
    const m = p.modules[0]!
    m.methods[2]!.name = 'clear'
    m.stateMachine!.states[0]!.name = 'Ready'
    const sm = toFile(p, { editor: false }).modules[0]!.stateMachine!
    expect(sm.initial).toBe('Ready')
    expect(sm.states[0]!.entry).toBe('clear')
    expect(sm.transitions[1]).toEqual({ from: 'Playing', to: 'Ready', trigger: 'stop', action: 'clear' })
  })

  it('keeps ids on reload', () => {
    const p = load()
    const again = reloadText(saveText(p, 'yaml', { editor: true }), 'yaml', p)
    const ids = (q: Project) => {
      const sm = q.modules[0]!.stateMachine!
      return [...sm.states, ...sm.transitions].map((x) => x.id)
    }
    expect(ids(again)).toEqual(ids(p))
  })

  it('checks the machine', () => {
    const p = load()
    const m = p.modules[0]!
    const sm = m.stateMachine!
    const [idle, playing, closed] = sm.states
    sm.transitions.push(
      { id: 't4', from: idle!.id, to: playing!.id, trigger: m.methods[0]!.id },
      { id: 't5', from: closed!.id, to: idle!.id }
    )
    sm.transitions[0]!.guard = 'level > 0'
    m.methods.push({ ...m.methods[1]!, id: 'stop2', params: [{ ...m.methods[0]!.params[0]!, id: 'x' }] })
    sm.transitions[1]!.action = 'deleted'
    expect(problems(p, 'error')).toEqual([
      "Player state machine: trigger of Playing -> Idle names overloaded method 'stop'",
      'Player state machine: action of Playing -> Idle names a deleted method',
      'Player state machine: transition Closed -> Idle leaves final state Closed',
      'Player state machine: Idle has 2 transitions on play, not all guarded'
    ])
    expect(problems(p, 'warning')).toEqual([
      "Player state machine: guard of Idle -> Playing: 'level' names nothing here"
    ])
  })

  it('warns of states never reached and requires an initial state', () => {
    const p = load()
    const sm = p.modules[0]!.stateMachine!
    sm.transitions.pop()
    expect(problems(p, 'warning')).toEqual(['Player state machine: state Closed is never reached'])
    delete sm.initial
    expect(problems(p, 'error')).toEqual(['Player state machine: no initial state'])
    sm.states.push({ ...sm.states[0]!, id: 's9' })
    expect(problems(p, 'error')).toContain("Player state machine: duplicate state 'Idle'")
  })

  it('copies the machine with its own ids', () => {
    const p = load()
    const clip = copyItems(p, [p.modules[0]!.id])!
    const q = produce(p, (d) => void pasteClip(d, clip, { parent: null }))
    const copy = q.modules[1]!
    const sm = copy.stateMachine!
    expect(sm.states.map((x) => x.id)).not.toContain(p.modules[0]!.stateMachine!.states[0]!.id)
    expect(sm.initial).toBe(sm.states[0]!.id)
    expect(sm.states[0]!.entry).toBe(copy.methods[2]!.id)
    expect(sm.transitions[1]).toMatchObject({
      from: sm.states[1]!.id,
      to: sm.states[0]!.id,
      trigger: copy.methods[1]!.id,
      action: copy.methods[2]!.id
    })
    expect(problems(q, 'error')).toEqual([])
  })
})
