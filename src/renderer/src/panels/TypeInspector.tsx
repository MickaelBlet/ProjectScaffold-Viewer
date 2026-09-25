import { useState, type ReactNode } from 'react'
import { nameError, newId, typeUsageTargets, uniqueName } from '@/model/project'
import { deleteType, update, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import { CommitInput, IconButton, NumberInput, Row, Section, Select, TextArea } from '@/components/fields'
import { TypeEditor } from '@/components/TypeEditor'
import { INT_PRIMITIVES, type Field, type TypeDef } from '@/model/types'
import { IDENTIFIER_RE } from '@/model/project'

function withType<K extends TypeDef['kind']>(
  id: string,
  fn: (t: Extract<TypeDef, { kind: K }>) => void
): void {
  update((d) => {
    const t = d.types.find((t) => t.id === id)
    if (t) fn(t as Extract<TypeDef, { kind: K }>)
  })
}

const identifier = (n: string): string | null => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')

function move<T>(list: T[], i: number, delta: number): void {
  const j = i + delta
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j]!, list[i]!]
}

/** Editable list of named, typed fields (struct fields, message params). */
export function FieldList(props: {
  fields: Field[]
  onChange: (fn: (fields: Field[]) => void) => void
  addLabel: string
}): ReactNode {
  const { fields, onChange } = props
  return (
    <>
      <table className="grid fields">
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.id}>
              <td>
                <CommitInput
                  value={f.name}
                  validate={identifier}
                  onCommit={(n) => onChange((fs) => void (fs[i]!.name = n))}
                />
              </td>
              <td className="wide">
                <TypeEditor value={f.type} onChange={(t) => onChange((fs) => void (fs[i]!.type = t))} />
              </td>
              <td className="nowrap">
                <IconButton
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => onChange((fs) => move(fs, i, -1))}
                >
                  ↑
                </IconButton>
                <IconButton
                  title="Move down"
                  disabled={i === fields.length - 1}
                  onClick={() => onChange((fs) => move(fs, i, 1))}
                >
                  ↓
                </IconButton>
                <IconButton title="Remove" danger onClick={() => onChange((fs) => void fs.splice(i, 1))}>
                  ×
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="link-button"
        onClick={() =>
          onChange(
            (fs) =>
              void fs.push({
                id: newId(),
                name: uniqueName(
                  'field',
                  fs.map((f) => f.name)
                ),
                type: { kind: 'primitive', name: 'uint32' },
                description: ''
              })
          )
        }
      >
        + {props.addLabel}
      </button>
    </>
  )
}

export function TypeInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const [blocked, setBlocked] = useState<string[]>([])
  const t = project.types.find((t) => t.id === id)
  if (!t) return <p className="muted">Type deleted.</p>
  const usages = typeUsageTargets(project, id)

  return (
    <>
      <h2>
        {t.kind} <small className="muted">{t.name}</small>
      </h2>
      <Row label="Name">
        <CommitInput
          value={t.name}
          validate={(n) => nameError(project, { kind: 'type', id }, n)}
          onCommit={(n) => withType(id, (x) => void (x.name = n))}
        />
      </Row>
      <TextArea value={t.description} onChange={(v) => withType(id, (x) => void (x.description = v))} />

      {t.kind === 'struct' && (
        <Section title={`Fields (${t.fields.length})`}>
          <FieldList
            fields={t.fields}
            addLabel="Add field"
            onChange={(fn) => withType<'struct'>(id, (x) => fn(x.fields))}
          />
        </Section>
      )}

      {t.kind === 'enum' && (
        <Section title={`Values (${t.values.length})`}>
          <Row label="Underlying">
            <Select
              value={t.underlying}
              options={INT_PRIMITIVES}
              onChange={(v) => withType<'enum'>(id, (x) => void (x.underlying = v))}
            />
          </Row>
          <table className="grid">
            <tbody>
              {t.values.map((v, i) => (
                <tr key={v.id}>
                  <td>
                    <CommitInput
                      value={v.name}
                      validate={identifier}
                      onCommit={(n) => withType<'enum'>(id, (x) => void (x.values[i]!.name = n))}
                    />
                  </td>
                  <td>
                    <NumberInput
                      value={v.value}
                      integer
                      onChange={(n) =>
                        n !== undefined && withType<'enum'>(id, (x) => void (x.values[i]!.value = n))
                      }
                    />
                  </td>
                  <td>
                    <IconButton
                      title="Remove"
                      danger
                      onClick={() => withType<'enum'>(id, (x) => void x.values.splice(i, 1))}
                    >
                      ×
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="link-button"
            onClick={() =>
              withType<'enum'>(id, (x) => {
                const next = x.values.length ? Math.max(...x.values.map((v) => v.value)) + 1 : 0
                x.values.push({
                  id: newId(),
                  name: uniqueName(
                    'Value',
                    x.values.map((v) => v.name)
                  ),
                  value: next
                })
              })
            }
          >
            + Add value
          </button>
        </Section>
      )}

      {t.kind === 'alias' && (
        <Section title="Aliased type">
          <TypeEditor value={t.type} onChange={(nt) => withType<'alias'>(id, (x) => void (x.type = nt))} />
        </Section>
      )}

      <Section title={`Used by (${usages.length})`}>
        <ul className="plain">
          {usages.map((u) => (
            <li key={u.where}>
              <button type="button" className="link-button" onClick={() => navigate(u.owner)}>
                {u.where}
              </button>
            </li>
          ))}
        </ul>
        {!usages.length && <p className="muted">Not used.</p>}
      </Section>

      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={() => {
            const usages = deleteType(id)
            setBlocked(usages)
            if (!usages.length) select(null)
          }}
        >
          Delete type
        </button>
      </div>
      {blocked.length > 0 && (
        <div className="callout error">
          Cannot delete: used by
          <ul>
            {blocked.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
