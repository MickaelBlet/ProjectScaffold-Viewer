import { Fragment, useState, type ReactNode } from 'react'
import { IDENTIFIER_RE, nameError, newId, typeUsageTargets, uniqueName } from '@/model/project'
import { deleteType, update, useProjectStore } from '@/store/project'
import { dependencyOf } from '@/model/dependencies'
import { DependencyBanner } from './DependencyBanner'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import { CommitInput, IconButton, NumberInput, Row, Section, Select, TextArea } from '@/components/fields'
import { TypeEditor, TypeTree } from '@/components/TypeEditor'
import { INT_PRIMITIVES, type Field, type TypeDef, type Value, type ValueField } from '@/model/types'
import { formatValue, parseValue, valueChoices, valueErrors, valueExample } from '@/model/defaults'
import { Icon } from '@/components/Icon'

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

/**
 * Default value of a struct field or attribute: a choice for booleans and enums, a YAML flow
 * literal checked against the type otherwise (empty: no default).
 */
export function DefaultInput(props: {
  field: ValueField
  types: TypeDef[]
  onChange: (value: Value | undefined) => void
}): ReactNode {
  const { field, types, onChange } = props
  const text = field.default === undefined ? '' : formatValue(field.default)
  const choices = valueChoices(field.type, types)
  if (choices) {
    const texts = choices.map(formatValue)
    const options = [
      { value: '', label: '— no default —' },
      ...texts.map((t) => ({ value: t, label: t })),
      ...(text && !texts.includes(text) ? [{ value: text, label: `${text} (invalid)` }] : [])
    ]
    return (
      <Select
        value={text}
        options={options}
        onChange={(v) => onChange(v ? choices[texts.indexOf(v)] : undefined)}
      />
    )
  }
  const parse = (v: string): { value?: Value; error: string | null } => {
    if (!v.trim()) return { error: null }
    try {
      const value = parseValue(v)
      return { value, error: valueErrors(value, field.type, types).join('; ') || null }
    } catch (e) {
      return { error: e instanceof Error ? e.message.split('\n')[0]! : String(e) }
    }
  }
  const placeholder = formatValue(valueExample(field.type, types))
  return (
    <CommitInput
      value={text}
      placeholder={placeholder}
      title={text || placeholder}
      validate={(v) => parse(v).error}
      onCommit={(v) => onChange(parse(v).value)}
    />
  )
}

export function setDefault(f: ValueField, value: Value | undefined): void {
  if (value === undefined) delete f.default
  else f.default = value
}

/**
 * Editable list of named, typed fields (struct fields, message params). `extra` holds the
 * non-Field properties of new entries, named after `baseName`; `column` renders an additional
 * cell after the name, `before` a narrow one
 * before the type, `value` one after it.
 */
export function FieldList<F extends Field = Field>(props: {
  fields: F[]
  onChange: (fn: (fields: F[]) => void) => void
  addLabel: string
  baseName?: string
  extra?: Omit<F, keyof Field>
  column?: (f: F, i: number) => ReactNode
  value?: (f: F, i: number) => ReactNode
  before?: (f: F, i: number) => ReactNode
}): ReactNode {
  const { fields, onChange } = props
  const columns = 3 + (props.column ? 1 : 0) + (props.value ? 1 : 0) + (props.before ? 1 : 0)
  const [trees, setTrees] = useState<ReadonlySet<string>>(new Set())
  const toggleTree = (id: string): void =>
    setTrees((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })
  return (
    <>
      <table className="grid fields">
        <tbody>
          {fields.map((f, i) => (
            <Fragment key={f.id}>
              <tr>
                <td>
                  <CommitInput
                    value={f.name}
                    validate={identifier}
                    onCommit={(n) => onChange((fs) => void (fs[i]!.name = n))}
                  />
                </td>
                {props.column && <td className="extra">{props.column(f, i)}</td>}
                {props.before && <td className="extra">{props.before(f, i)}</td>}
                <td className="wide">
                  <TypeEditor
                    value={f.type}
                    onChange={(t) => onChange((fs) => void (fs[i]!.type = t))}
                    tree={trees.has(f.id)}
                    onToggleTree={() => toggleTree(f.id)}
                  />
                </td>
                {props.value && <td className="default">{props.value(f, i)}</td>}
                <td className="nowrap">
                  <IconButton
                    icon="arrow-up"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => onChange((fs) => move(fs, i, -1))}
                  />
                  <IconButton
                    icon="arrow-down"
                    title="Move down"
                    disabled={i === fields.length - 1}
                    onClick={() => onChange((fs) => move(fs, i, 1))}
                  />
                  <IconButton
                    icon="x"
                    title="Remove"
                    danger
                    onClick={() => onChange((fs) => void fs.splice(i, 1))}
                  />
                </td>
              </tr>
              {trees.has(f.id) && (
                <tr className="type-tree-row">
                  <td colSpan={columns}>
                    <TypeTree value={f.type} onChange={(t) => onChange((fs) => void (fs[i]!.type = t))} />
                  </td>
                </tr>
              )}
            </Fragment>
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
                ...props.extra,
                id: newId(),
                name: uniqueName(
                  props.baseName ?? 'field',
                  fs.map((f) => f.name)
                ),
                type: { kind: 'primitive', name: 'uint32' },
                description: ''
              } as F)
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
  const dependency = dependencyOf(project, id)

  return (
    <>
      <h2>
        {t.kind} <small className="muted">{t.name}</small>
      </h2>
      {dependency && <DependencyBanner dependency={dependency} />}
      <fieldset className="readonly" disabled={!!dependency}>
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
              value={(f, i) => (
                <DefaultInput
                  field={f}
                  types={project.types}
                  onChange={(v) => withType<'struct'>(id, (x) => setDefault(x.fields[i]!, v))}
                />
              )}
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
                        icon="x"
                        title="Remove"
                        danger
                        onClick={() => withType<'enum'>(id, (x) => void x.values.splice(i, 1))}
                      />
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
              <Icon name="plus" /> Add value
            </button>
          </Section>
        )}

        {t.kind === 'primitive' && <p className="muted">Opaque type: generators map it to a native type.</p>}

        {t.kind === 'alias' && (
          <Section title="Aliased type">
            <TypeEditor value={t.type} onChange={(nt) => withType<'alias'>(id, (x) => void (x.type = nt))} />
          </Section>
        )}
      </fieldset>

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

      <div className="actions" hidden={!!dependency}>
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
