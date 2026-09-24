import type { ReactNode } from 'react'
import { IDENTIFIER_RE, modulePath, nameError, newId, uniqueName } from '@/model/project'
import { deleteInterface, update, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { CommitInput, IconButton, Row, Section, TextArea } from '@/components/fields'
import { TypeEditor } from '@/components/TypeEditor'
import type { Interface, Message } from '@/model/types'
import { FieldList } from './TypeInspector'

function withInterface(id: string, fn: (i: Interface) => void): void {
  update((d) => {
    const i = d.interfaces.find((i) => i.id === id)
    if (i) fn(i)
  })
}

export function InterfaceInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const iface = project.interfaces.find((i) => i.id === id)
  if (!iface) return <p className="muted">Interface deleted.</p>
  const users = project.modules.flatMap((m) =>
    m.ports.filter((p) => p.interfaceId === id).map((p) => ({ module: m, port: p }))
  )
  const withMessage = (mid: string, fn: (m: Message) => void): void =>
    withInterface(id, (i) => {
      const m = i.messages.find((m) => m.id === mid)
      if (m) fn(m)
    })

  return (
    <>
      <h2>
        Interface <small className="muted">{iface.name}</small>
      </h2>
      <Row label="Name">
        <CommitInput
          value={iface.name}
          validate={(n) => nameError(project, { kind: 'interface', id }, n)}
          onCommit={(n) => withInterface(id, (i) => void (i.name = n))}
        />
      </Row>
      <TextArea
        value={iface.description}
        onChange={(v) => withInterface(id, (i) => void (i.description = v))}
      />

      <Section
        title={`Messages (${iface.messages.length})`}
        actions={
          <button
            type="button"
            onClick={() =>
              withInterface(
                id,
                (i) =>
                  void i.messages.push({
                    id: newId(),
                    name: uniqueName(
                      'message',
                      i.messages.map((m) => m.name)
                    ),
                    description: '',
                    params: [],
                    returns: null
                  })
              )
            }
          >
            + message
          </button>
        }
      >
        {iface.messages.map((m) => (
          <div className="card" key={m.id}>
            <div className="card-header">
              <CommitInput
                value={m.name}
                validate={(n) => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')}
                onCommit={(n) => withMessage(m.id, (x) => void (x.name = n))}
              />
              <IconButton
                title="Delete message"
                danger
                onClick={() =>
                  withInterface(id, (i) => void (i.messages = i.messages.filter((x) => x.id !== m.id)))
                }
              >
                ×
              </IconButton>
            </div>
            <TextArea
              value={m.description}
              onChange={(v) => withMessage(m.id, (x) => void (x.description = v))}
            />
            <h4>Parameters</h4>
            <FieldList
              fields={m.params}
              addLabel="Add parameter"
              onChange={(fn) => withMessage(m.id, (x) => fn(x.params))}
            />
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
                Returns a value <small className="muted">(requires a bidirectional link)</small>
              </label>
            </h4>
            {m.returns && (
              <TypeEditor
                value={m.returns}
                onChange={(t) => withMessage(m.id, (x) => void (x.returns = t))}
              />
            )}
          </div>
        ))}
      </Section>

      <Section title={`Used by (${users.length})`}>
        <ul className="plain">
          {users.map(({ module, port }) => (
            <li key={port.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => select({ kind: 'module', id: module.id })}
              >
                {modulePath(project, module.id)}:{port.name}
              </button>{' '}
              <small className="muted">{port.role}</small>
            </li>
          ))}
        </ul>
      </Section>

      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteInterface(id)
            select(null)
          }}
        >
          Delete interface
        </button>
      </div>
    </>
  )
}
