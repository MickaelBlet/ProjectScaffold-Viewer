// State machine of a module in the inspector: its states and the transitions its methods trigger.
import type { ReactNode } from 'react'
import { IDENTIFIER_RE, newId, uniqueName } from '@/model/project'
import type { Id, Module, Project, State, StateMachine, Transition } from '@/model/types'
import { CommitInput, IconButton, Section, Select } from '@/components/fields'
import { Icon } from '@/components/Icon'
import { showTool } from '@/shell/controllers'
import { useSettings } from '@/store/settings'

type WithModule = (fn: (m: Module, d: Project) => void) => void

/** Sets an optional method reference, or leaves it out. */
function setMethod<K extends 'entry' | 'exit' | 'trigger' | 'action'>(
  e: Partial<Record<K, Id>>,
  key: K,
  id: string
): void {
  if (id) e[key] = id
  else delete e[key]
}

export function StateMachineSection(props: { mod: Module; withModule: WithModule }): ReactNode {
  const { mod, withModule } = props
  const sm = mod.stateMachine
  const on = useSettings((s) => s.featureStateMachine)
  if (!on && !sm) return null
  const withMachine = (fn: (sm: StateMachine, m: Module) => void): void =>
    withModule((m) => {
      if (m.stateMachine) fn(m.stateMachine, m)
    })
  const withState = (sid: Id, fn: (s: State) => void): void =>
    withMachine((x) => {
      const s = x.states.find((y) => y.id === sid)
      if (s) fn(s)
    })
  const withTransition = (tid: Id, fn: (t: Transition) => void): void =>
    withMachine((x) => {
      const t = x.transitions.find((y) => y.id === tid)
      if (t) fn(t)
    })
  const addState = (): void =>
    withModule((m) => {
      const x = (m.stateMachine ??= { states: [], transitions: [] })
      const id = newId()
      x.states.push({
        id,
        name: uniqueName(
          x.states.length ? 'State' : 'Idle',
          x.states.map((s) => s.name)
        ),
        description: ''
      })
      x.initial ??= id
    })
  const methods = (none: string) => [
    { value: '', label: none },
    ...mod.methods.map((x) => ({ value: x.id, label: x.name }))
  ]
  const states = sm?.states.map((s) => ({ value: s.id, label: s.name })) ?? []
  return (
    <Section
      title={sm ? `State machine (${sm.states.length})` : 'State machine'}
      actions={
        <>
          <button type="button" title="The states the module goes through" onClick={addState}>
            <Icon name="plus" /> state
          </button>
          {!!sm?.states.length && (
            <button
              type="button"
              title="A move between two states when a method is called"
              onClick={() =>
                withMachine((x) => {
                  const from = x.states[0]!.id
                  x.transitions.push({ id: newId(), from, to: x.states[1]?.id ?? from })
                })
              }
            >
              <Icon name="plus" /> transition
            </button>
          )}
          {sm && (
            <>
              <IconButton icon="eye" title="Show the diagram" onClick={() => showTool('stateMachine')} />
              <IconButton
                icon="x"
                title="Delete the state machine"
                danger
                onClick={() => withModule((m) => void delete m.stateMachine)}
              />
            </>
          )}
        </>
      }
    >
      {!sm && <p className="muted">No state machine.</p>}
      {sm && (
        <>
          <h4>States</h4>
          {sm.states.map((s) => (
            <div key={s.id} className="card state">
              <div className="row-inline">
                <CommitInput
                  value={s.name}
                  validate={(n) => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')}
                  onCommit={(n) => withState(s.id, (x) => void (x.name = n))}
                />
                <label className="check" title="The module starts in this state">
                  <input
                    type="radio"
                    checked={sm.initial === s.id}
                    onChange={() => withMachine((x) => void (x.initial = s.id))}
                  />
                  initial
                </label>
                <label className="check" title="The machine stops there: no transition leaves it">
                  <input
                    type="checkbox"
                    checked={!!s.final}
                    onChange={(e) =>
                      withState(s.id, (x) => {
                        if (e.target.checked) x.final = true
                        else delete x.final
                      })
                    }
                  />
                  final
                </label>
                <IconButton
                  icon="x"
                  title="Delete state and its transitions"
                  danger
                  onClick={() =>
                    withMachine((x) => {
                      x.states = x.states.filter((y) => y.id !== s.id)
                      x.transitions = x.transitions.filter((t) => t.from !== s.id && t.to !== s.id)
                      if (x.initial === s.id) {
                        if (x.states[0]) x.initial = x.states[0].id
                        else delete x.initial
                      }
                    })
                  }
                />
              </div>
              <div className="row-inline state-methods">
                <span className="muted">entry</span>
                <Select
                  value={s.entry ?? ''}
                  options={methods('none')}
                  onChange={(v) => withState(s.id, (x) => setMethod(x, 'entry', v))}
                />
                <span className="muted">exit</span>
                <Select
                  value={s.exit ?? ''}
                  options={methods('none')}
                  onChange={(v) => withState(s.id, (x) => setMethod(x, 'exit', v))}
                />
              </div>
            </div>
          ))}
          {!!sm.transitions.length && <h4>Transitions</h4>}
          {sm.transitions.map((t) => (
            <div key={t.id} className="card transition">
              <div className="row-inline">
                <Select
                  value={t.from}
                  options={states}
                  onChange={(v) => withTransition(t.id, (x) => void (x.from = v))}
                />
                <Icon name="arrow-right" />
                <Select
                  value={t.to}
                  options={states}
                  onChange={(v) => withTransition(t.id, (x) => void (x.to = v))}
                />
                <IconButton
                  icon="x"
                  title="Delete transition"
                  danger
                  onClick={() =>
                    withMachine((x) => void (x.transitions = x.transitions.filter((y) => y.id !== t.id)))
                  }
                />
              </div>
              <div className="row-inline state-methods">
                <span className="muted">on</span>
                <Select
                  value={t.trigger ?? ''}
                  options={methods('(entered)')}
                  onChange={(v) => withTransition(t.id, (x) => setMethod(x, 'trigger', v))}
                />
                <span className="muted">do</span>
                <Select
                  value={t.action ?? ''}
                  options={methods('nothing')}
                  onChange={(v) => withTransition(t.id, (x) => setMethod(x, 'action', v))}
                />
              </div>
              <CommitInput
                className="code"
                value={t.guard ?? ''}
                placeholder="guard (always)"
                title="Condition taking the transition: attributes, parameters of the trigger"
                onCommit={(g) =>
                  withTransition(t.id, (x) => {
                    if (g.trim()) x.guard = g
                    else delete x.guard
                  })
                }
              />
            </div>
          ))}
        </>
      )}
    </Section>
  )
}
