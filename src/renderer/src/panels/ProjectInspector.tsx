import type { ReactNode } from 'react'
import { binaryError, newId, transportError, uniqueName } from '@/model/project'
import { removeBinary } from '@/model/binaries'
import { TRANSPORTS } from '@/model/types'
import { update, useProjectStore } from '@/store/project'
import {
  ColorPicker,
  CommitInput,
  IconButton,
  MetadataEditor,
  Row,
  Section,
  TextArea
} from '@/components/fields'
import { Icon } from '@/components/Icon'

/** Rename a custom transport, and the links using it. */
function renameTransport(i: number, name: string): void {
  update((d) => {
    const was = d.transports[i]
    d.transports[i] = name
    for (const l of d.links) if (l.constraints.remote.transport === was) l.constraints.remote.transport = name
  })
}

export function ProjectInspector(): ReactNode {
  const p = useProjectStore((s) => s.project)
  return (
    <>
      <h2>Project</h2>
      <Row label="Name">
        <input value={p.name} onChange={(e) => update((d) => void (d.name = e.target.value))} />
      </Row>
      <TextArea value={p.description} onChange={(v) => update((d) => void (d.description = v))} />
      <Section title="Metadata">
        <MetadataEditor value={p.metadata} onChange={(fn) => update((d) => fn(d.metadata))} />
      </Section>
      <Section
        title={`Transports (${p.transports.length})`}
        actions={
          <button
            type="button"
            onClick={() =>
              update((d) => void d.transports.push(uniqueName('transport', [...TRANSPORTS, ...d.transports])))
            }
          >
            <Icon name="plus" /> add
          </button>
        }
      >
        <table className="grid">
          <tbody>
            {p.transports.map((t, i) => (
              <tr key={`${i}:${t}`}>
                <td>
                  <CommitInput
                    value={t}
                    validate={(n) => transportError(p, n, i)}
                    onCommit={(n) => renameTransport(i, n)}
                  />
                </td>
                <td>
                  <IconButton
                    icon="x"
                    title="Remove transport"
                    danger
                    onClick={() => update((d) => void d.transports.splice(i, 1))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Offered for remote links besides the built-in ones: {TRANSPORTS.join(', ')}.</p>
      </Section>
      <Section
        title={`Binaries (${p.binaries.length})`}
        actions={
          <button
            type="button"
            onClick={() =>
              update(
                (d) =>
                  void d.binaries.push({
                    id: newId(),
                    name: uniqueName(
                      'Binary',
                      d.binaries.map((b) => b.name)
                    ),
                    description: ''
                  })
              )
            }
          >
            <Icon name="plus" /> add
          </button>
        }
      >
        {p.binaries.map((b) => (
          <div key={b.id} className="binary-item">
            <span className="row-inline">
              <CommitInput
                value={b.name}
                validate={(n) => binaryError(p, n, b.id)}
                onCommit={(n) => update((d) => void (d.binaries.find((x) => x.id === b.id)!.name = n))}
              />
              <span className="muted">{p.modules.filter((m) => m.binaryId === b.id).length} modules</span>
              <IconButton
                icon="x"
                title="Remove binary"
                danger
                onClick={() => update((d) => removeBinary(d, b.id))}
              />
            </span>
            <ColorPicker
              value={b.color}
              onChange={(c) =>
                update((d) => {
                  const x = d.binaries.find((x) => x.id === b.id)!
                  if (c) x.color = c
                  else delete x.color
                })
              }
            />
          </div>
        ))}
        <p className="muted">
          Executables the top-level modules are split into: each module names its own, and links between two
          binaries must be remote, with a transport.
        </p>
      </Section>
      <Section title="Summary">
        <p className="muted">
          {p.modules.length} modules · {p.links.length} links · {p.types.length} types · {p.interfaces.length}{' '}
          interfaces
        </p>
        <p className="muted">
          Right-click the canvas to add a module. Drag from an <b>out</b> port (right, or bottom when
          vertical) to an <b>in</b> port (left, or top) to create a link. Drop a module onto another to nest
          it.
        </p>
      </Section>
    </>
  )
}
