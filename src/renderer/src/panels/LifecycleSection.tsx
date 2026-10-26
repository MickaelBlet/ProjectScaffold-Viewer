// Inspector section of a module's lifecycle: instantiation, copy and move, destructor, constructors.
import type { ReactNode } from 'react'
import { DESTRUCTOR_MEMBER, newId, setAccess } from '@/model/project'
import {
  INSTANTIATIONS,
  PARAM_DIRECTIONS,
  SPECIAL_MEMBERS,
  type Constructor,
  type Module,
  type Project,
  type SpecialMember
} from '@/model/types'
import {
  AccessToggles,
  IconButton,
  QualifierToggles,
  Row,
  Section,
  Select,
  TextArea
} from '@/components/fields'
import { Icon } from '@/components/Icon'
import { useSettings } from '@/store/settings'
import { DefaultInput, FieldList, setDefault } from './TypeInspector'

type WithModule = (fn: (m: Module, d: Project) => void) => void

const SPECIAL_OPTIONS = [
  { value: '', label: 'implicit' },
  ...SPECIAL_MEMBERS.map((v) => ({ value: v, label: v }))
]

const DESTRUCTORS = [
  { value: '', label: 'implicit' },
  { value: 'auto', label: 'declared' },
  { value: 'virtual', label: 'virtual' },
  { value: 'plain', label: 'not virtual' }
] as const
type DestructorChoice = (typeof DESTRUCTORS)[number]['value']

/** Toggles of the flags of a constructor. */
const CONSTRUCTOR_FLAGS = ['explicit', 'defaulted', 'deleted'] as const

export function LifecycleSection(props: {
  mod: Module
  types: Project['types']
  withModule: WithModule
  /** Constructor or destructor selected on the canvas, highlighted. */
  focused?: string
}): ReactNode {
  const { mod, types, withModule, focused } = props
  const on = useSettings((s) => s.featureLifecycle)
  if (!on && !mod.instantiation && !mod.copy && !mod.move && !mod.destructor && !mod.constructors?.length)
    return null
  const ctors = mod.constructors ?? []
  const d = mod.destructor
  const destructor: DestructorChoice = !d
    ? ''
    : d.virtual === undefined
      ? 'auto'
      : d.virtual
        ? 'virtual'
        : 'plain'
  const setSpecial = (key: 'copy' | 'move', v: SpecialMember | ''): void =>
    withModule((m) => {
      if (v) m[key] = v
      else delete m[key]
    })
  const withCtor = (cid: string, fn: (c: Constructor) => void): void =>
    withModule((m) => {
      const c = m.constructors?.find((x) => x.id === cid)
      if (c) fn(c)
    })
  return (
    <Section
      title="Lifecycle"
      actions={
        mod.kind !== 'interface' && (
          <button
            type="button"
            onClick={() =>
              withModule(
                (m) => void (m.constructors ??= []).push({ id: newId(), description: '', params: [] })
              )
            }
          >
            <Icon name="plus" /> constructor
          </button>
        )
      }
    >
      <Row label="Instances">
        <Select
          value={mod.instantiation ?? ''}
          options={[{ value: '', label: 'free' }, ...INSTANTIATIONS.map((v) => ({ value: v, label: v }))]}
          onChange={(v) =>
            withModule((m) => {
              if (v) m.instantiation = v
              else delete m.instantiation
            })
          }
        />
      </Row>
      <Row label="Copy">
        <Select
          value={mod.copy ?? ''}
          options={SPECIAL_OPTIONS}
          onChange={(v) => setSpecial('copy', v as SpecialMember | '')}
        />
      </Row>
      <Row label="Move">
        <Select
          value={mod.move ?? ''}
          options={SPECIAL_OPTIONS}
          onChange={(v) => setSpecial('move', v as SpecialMember | '')}
        />
      </Row>
      <Row label="Destructor" member={DESTRUCTOR_MEMBER} focused={focused === DESTRUCTOR_MEMBER}>
        <span className="row-inline">
          <Select
            value={destructor}
            options={[...DESTRUCTORS]}
            onChange={(v) =>
              withModule((m) => {
                if (!v) return void delete m.destructor
                const access = m.destructor?.access
                m.destructor = {
                  ...(access && { access }),
                  ...(v !== 'auto' && { virtual: v === 'virtual' })
                }
              })
            }
          />
          {d && (
            <AccessToggles
              value={d.access}
              onChange={(v) => withModule((m) => m.destructor && setAccess(m.destructor, v))}
            />
          )}
        </span>
      </Row>
      {ctors.map((c) => (
        <div className={`card ${focused === c.id ? 'focused' : ''}`} key={c.id} data-member={c.id}>
          <div className="card-header">
            <span className="card-title">
              {mod.name}({c.params.map((prm) => prm.name).join(', ')})
            </span>
            <AccessToggles value={c.access} onChange={(v) => withCtor(c.id, (x) => setAccess(x, v))} />
            <IconButton
              icon="x"
              title="Delete constructor"
              danger
              onClick={() =>
                withModule((m) => {
                  m.constructors = m.constructors?.filter((x) => x.id !== c.id)
                  if (!m.constructors?.length) delete m.constructors
                })
              }
            />
          </div>
          <TextArea value={c.description} onChange={(v) => withCtor(c.id, (x) => void (x.description = v))} />
          <span className="qualifiers">
            {CONSTRUCTOR_FLAGS.map((k) => (
              <button
                type="button"
                key={k}
                className={`qualifier ${c[k] ? 'on' : ''}`}
                aria-pressed={!!c[k]}
                onClick={() =>
                  withCtor(c.id, (x) => {
                    if (x[k]) delete x[k]
                    else {
                      x[k] = true
                      // Defaulted and deleted exclude each other.
                      if (k === 'defaulted') delete x.deleted
                      if (k === 'deleted') delete x.defaulted
                    }
                  })
                }
              >
                {k}
              </button>
            ))}
          </span>
          <h4>Parameters</h4>
          <FieldList
            fields={c.params}
            addLabel="Add parameter"
            extra={{ direction: 'in' }}
            column={(prm, idx) => (
              <Select
                value={prm.direction}
                options={PARAM_DIRECTIONS}
                onChange={(v) => withCtor(c.id, (x) => void (x.params[idx]!.direction = v))}
              />
            )}
            before={(prm, idx) =>
              prm.direction === 'in' && (
                <QualifierToggles
                  qualifiers={['const']}
                  value={prm}
                  short
                  onChange={(_, on) =>
                    withCtor(c.id, (x) => {
                      if (on) x.params[idx]!.const = true
                      else delete x.params[idx]!.const
                    })
                  }
                />
              )
            }
            value={(prm, idx) =>
              prm.direction === 'in' && (
                <DefaultInput
                  field={prm}
                  types={types}
                  onChange={(v) => withCtor(c.id, (x) => setDefault(x.params[idx]!, v))}
                />
              )
            }
            onChange={(fn) => withCtor(c.id, (x) => fn(x.params))}
          />
          <small className="muted">A parameter named like an attribute sets it.</small>
        </div>
      ))}
    </Section>
  )
}
