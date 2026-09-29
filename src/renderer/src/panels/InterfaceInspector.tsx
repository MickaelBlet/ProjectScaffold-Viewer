import type { ReactNode } from 'react'
import { modulePath, nameError } from '@/model/project'
import { deleteInterface, update, useProjectStore } from '@/store/project'
import { dependencyOf } from '@/model/dependencies'
import { DependencyBanner } from './DependencyBanner'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import { CommitInput, Row, Section, TextArea } from '@/components/fields'
import type { Interface } from '@/model/types'
import { addMessage, MessageList } from './MessageList'
import { Icon } from '@/components/Icon'

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

  const dependency = dependencyOf(project, id)

  return (
    <>
      <h2>
        Interface <small className="muted">{iface.name}</small>
      </h2>
      {dependency && <DependencyBanner dependency={dependency} />}
      <fieldset className="readonly" disabled={!!dependency}>
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
            <button type="button" onClick={() => withInterface(id, (i) => addMessage(i.messages, 'message'))}>
              <Icon name="plus" /> message
            </button>
          }
        >
          <MessageList
            messages={iface.messages}
            noun="message"
            linkHints
            onChange={(fn) => withInterface(id, (i) => fn(i.messages))}
          />
        </Section>
      </fieldset>

      <Section title={`Used by (${users.length})`}>
        <ul className="plain">
          {users.map(({ module, port }) => (
            <li key={port.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'module', id: module.id })}
              >
                {modulePath(project, module.id)}:{port.name}
              </button>{' '}
              <small className="muted">{port.role}</small>
            </li>
          ))}
        </ul>
      </Section>

      <div className="actions" hidden={!!dependency}>
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
