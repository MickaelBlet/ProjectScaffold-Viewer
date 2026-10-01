import type { ReactNode } from 'react'
import { nameError } from '@/model/project'
import { valueErrors, valueExample } from '@/model/defaults'
import { dependencyOf } from '@/model/dependencies'
import type { ConstDef } from '@/model/types'
import { deleteConst, update, useProjectStore } from '@/store/project'
import { CommitInput, Row, Section, TextArea } from '@/components/fields'
import { TypeEditor } from '@/components/TypeEditor'
import { DependencyBanner } from './DependencyBanner'
import { DefaultInput } from './TypeInspector'

function withConst(id: string, fn: (c: ConstDef) => void): void {
  update((d) => {
    const c = d.consts.find((c) => c.id === id)
    if (c) fn(c)
  })
}

export function ConstInspector({ id, onDeleted }: { id: string; onDeleted?: () => void }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const c = project.consts.find((c) => c.id === id)
  if (!c) return <p className="muted">Constant deleted.</p>
  const dependency = dependencyOf(project, id)

  return (
    <>
      <h2>
        constant <small className="muted">{c.name}</small>
      </h2>
      {dependency && <DependencyBanner dependency={dependency} />}
      <fieldset className="readonly" disabled={!!dependency}>
        <Row label="Name">
          <CommitInput
            value={c.name}
            validate={(n) => nameError(project, { kind: 'const', id }, n)}
            onCommit={(n) => withConst(id, (x) => void (x.name = n))}
          />
        </Row>
        <TextArea value={c.description} onChange={(v) => withConst(id, (x) => void (x.description = v))} />
        <Section title="Value">
          <Row label="Type">
            <TypeEditor
              value={c.type}
              onChange={(t) =>
                withConst(id, (x) => {
                  x.type = t
                  // Keep the value when it still fits the new type.
                  if (valueErrors(x.value, t, project.types).length) x.value = valueExample(t, project.types)
                })
              }
            />
          </Row>
          <Row label="Value">
            <DefaultInput
              field={{ ...c, default: c.value }}
              types={project.types}
              onChange={(v) =>
                withConst(id, (x) => void (x.value = v ?? valueExample(x.type, project.types)))
              }
            />
          </Row>
        </Section>
      </fieldset>

      <div className="actions" hidden={!!dependency}>
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteConst(id)
            onDeleted?.()
          }}
        >
          Delete constant
        </button>
      </div>
    </>
  )
}
