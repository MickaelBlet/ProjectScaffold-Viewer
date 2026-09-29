import type { ReactNode } from 'react'
import { IDENTIFIER_RE, newId, uniqueName } from '@/model/project'
import { CommitInput, IconButton, Select, TextArea } from '@/components/fields'
import { TypeEditor } from '@/components/TypeEditor'
import { PARAM_DIRECTIONS, type Message } from '@/model/types'
import { FieldList } from './TypeInspector'

/** Append an empty message named after `base`, unique in `list`. */
export function addMessage(list: Message[], base: string): void {
  list.push({
    id: newId(),
    name: uniqueName(
      base,
      list.map((m) => m.name)
    ),
    description: '',
    params: [],
    returns: null
  })
}

/** Editor of interface messages or module methods: name, description, parameters and return type. */
export function MessageList<M extends Message>(props: {
  messages: M[]
  /** Kind of the entries, in delete button titles. */
  noun: string
  onChange: (fn: (messages: M[]) => void) => void
  /** Show that out parameters and return values need a bidirectional link. */
  linkHints?: boolean
  /** Extra settings of an entry, below its description. */
  extra?: (m: M, change: (fn: (m: M) => void) => void) => ReactNode
  /** Extra settings of a parameter, left of its type. */
  paramExtra?: (
    prm: M['params'][number],
    change: (fn: (prm: M['params'][number]) => void) => void
  ) => ReactNode
}): ReactNode {
  const { messages, onChange, paramExtra } = props
  const withMessage = (mid: string, fn: (m: M) => void): void =>
    onChange((ms) => {
      const m = ms.find((m) => m.id === mid)
      if (m) fn(m)
    })
  return messages.map((m) => (
    <div className="card" key={m.id}>
      <div className="card-header">
        <CommitInput
          value={m.name}
          validate={(n) => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')}
          onCommit={(n) => withMessage(m.id, (x) => void (x.name = n))}
        />
        <IconButton
          icon="x"
          title={`Delete ${props.noun}`}
          danger
          onClick={() =>
            onChange((ms) => {
              const i = ms.findIndex((x) => x.id === m.id)
              if (i >= 0) ms.splice(i, 1)
            })
          }
        />
      </div>
      <TextArea value={m.description} onChange={(v) => withMessage(m.id, (x) => void (x.description = v))} />
      {props.extra?.(m, (fn) => withMessage(m.id, fn))}
      <h4>Parameters</h4>
      <FieldList
        fields={m.params}
        addLabel="Add parameter"
        extra={{ direction: 'in' }}
        column={(prm, idx) => (
          <Select
            value={prm.direction}
            options={PARAM_DIRECTIONS}
            onChange={(v) => withMessage(m.id, (x) => void (x.params[idx]!.direction = v))}
          />
        )}
        before={
          paramExtra && ((prm, idx) => paramExtra(prm, (fn) => withMessage(m.id, (x) => fn(x.params[idx]!))))
        }
        onChange={(fn) => withMessage(m.id, (x) => fn(x.params))}
      />
      {props.linkHints && m.params.some((prm) => prm.direction !== 'in') && (
        <small className="muted">out / inout parameters require a bidirectional link</small>
      )}
      <h4>
        <label className="check">
          <input
            type="checkbox"
            checked={m.returns !== null}
            onChange={(e) =>
              withMessage(
                m.id,
                (x) => void (x.returns = e.target.checked ? { kind: 'primitive', name: 'bool' } : null)
              )
            }
          />
          Returns a value
          {props.linkHints && <small className="muted"> (requires a bidirectional link)</small>}
        </label>
      </h4>
      {m.returns && (
        <TypeEditor value={m.returns} onChange={(t) => withMessage(m.id, (x) => void (x.returns = t))} />
      )}
    </div>
  ))
}
