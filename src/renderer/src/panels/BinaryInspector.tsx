import type { ReactNode } from 'react'
import { binaryError } from '@/model/project'
import { removeBinary } from '@/model/binaries'
import type { Binary, Id } from '@/model/types'
import { update, useProjectStore } from '@/store/project'
import { ColorPicker, CommitInput, Row, Section, TextArea } from '@/components/fields'

function withBinary(id: string, fn: (b: Binary) => void): void {
  update((d) => {
    const b = d.binaries.find((b) => b.id === id)
    if (b) fn(b)
  })
}

/** A binary: name, description, color and the top-level modules it holds. */
export function BinaryInspector({
  id,
  onDeleted,
  onModule
}: {
  id: string
  onDeleted?: () => void
  onModule?: (id: Id) => void
}): ReactNode {
  const project = useProjectStore((s) => s.project)
  const b = project.binaries.find((b) => b.id === id)
  if (!b) return <p className="muted">Binary removed.</p>
  const inside = project.modules.filter((m) => m.binaryId === id)

  return (
    <>
      <h2>
        binary <small className="muted">{b.name}</small>
      </h2>
      <Row label="Name">
        <CommitInput
          value={b.name}
          validate={(n) => binaryError(project, n, id)}
          onCommit={(n) => withBinary(id, (x) => void (x.name = n))}
        />
      </Row>
      <TextArea value={b.description} onChange={(v) => withBinary(id, (x) => void (x.description = v))} />
      <Section title="Color">
        <ColorPicker
          value={b.color}
          onChange={(c) =>
            withBinary(id, (x) => {
              if (c) x.color = c
              else delete x.color
            })
          }
        />
      </Section>
      <Section title={`Modules (${inside.length})`}>
        {inside.length ? (
          <ul className="plain">
            {inside.map((m) => (
              <li key={m.id}>
                <button type="button" className="link-button" onClick={() => onModule?.(m.id)}>
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No module yet: a top-level module picks its binary in its inspector.</p>
        )}
      </Section>

      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={() => {
            update((d) => removeBinary(d, id))
            onDeleted?.()
          }}
        >
          Remove binary
        </button>
      </div>
    </>
  )
}
