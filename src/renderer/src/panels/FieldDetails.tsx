// Details of a struct field or module attribute, below its row: constraints, ownership of the modules
// its type references and, for attributes, accessors and lock.
import type { ReactNode } from 'react'
import { constrainedScalar, moduleRefs, patternError } from '@/model/constraints'
import { isModuleRef, setAttributeQualifier } from '@/model/project'
import { useProjectStore } from '@/store/project'
import { useSettings } from '@/store/settings'
import {
  ACCESSORS,
  INT_PRIMITIVES,
  OWNERSHIPS,
  type Attribute,
  type Constraints,
  type Lock,
  type ValueField
} from '@/model/types'
import { CommitInput, NumberInput, QualifierToggles, Select } from '@/components/fields'

/** Qualifiers of attributes set here, the others beside their name. */
const DETAIL_QUALIFIERS = ['mutable', 'atomic'] as const

/** Whether a field has details set: its details toggle shows it. */
export const hasDetails = (f: ValueField & Partial<Attribute>): boolean =>
  !!(f.constraints || f.ownership || f.accessors || f.guardedBy || f.mutable || f.atomic)

/** Set or clear one constraint; no constraints left: none at all. */
function setConstraint<K extends keyof Constraints>(
  f: ValueField,
  k: K,
  v: Constraints[K] | undefined
): void {
  const c: Constraints = { ...f.constraints }
  if (v === undefined || v === '') delete c[k]
  else c[k] = v
  if (Object.keys(c).length) f.constraints = c
  else delete f.constraints
}

export function FieldDetails<F extends ValueField & Partial<Attribute>>(props: {
  field: F
  change: (fn: (f: F) => void) => void
  /** Locks of the module, for an attribute. */
  locks?: readonly Lock[]
  attribute?: boolean
}): ReactNode {
  const { field: f, change } = props
  const types = useProjectStore((s) => s.project.types)
  const modules = useProjectStore((s) => s.project.modules)
  const constraintsOn = useSettings((s) => s.featureValueConstraints)
  const concurrencyOn = useSettings((s) => s.featureConcurrency)
  const scalar = constrainedScalar(f.type, types)
  const numeric = (INT_PRIMITIVES as readonly string[]).includes(scalar) || scalar.startsWith('float')
  const integer = (INT_PRIMITIVES as readonly string[]).includes(scalar)
  const text = scalar === 'string' || scalar === 'char'
  const c = f.constraints ?? {}
  const refs = moduleRefs(f.type, (id) => isModuleRef({ modules }, id))
  const rows: ReactNode[] = []
  if ((constraintsOn && numeric) || c.min !== undefined || c.max !== undefined || c.unit)
    rows.push(
      <label key="range" className="detail">
        <span>Range</span>
        <NumberInput
          value={c.min}
          integer={integer}
          placeholder="min"
          onChange={(v) => change((x) => setConstraint(x, 'min', v))}
        />
        <span className="muted">…</span>
        <NumberInput
          value={c.max}
          integer={integer}
          placeholder="max"
          onChange={(v) => change((x) => setConstraint(x, 'max', v))}
        />
        <CommitInput
          value={c.unit ?? ''}
          placeholder="unit"
          onCommit={(v) => change((x) => setConstraint(x, 'unit', v.trim()))}
        />
      </label>
    )
  if ((constraintsOn && text) || c.pattern !== undefined)
    rows.push(
      <label key="pattern" className="detail">
        <span>Pattern</span>
        <CommitInput
          value={c.pattern ?? ''}
          placeholder="regular expression, the whole value"
          validate={(v) => (v ? patternError(v) : null)}
          onCommit={(v) => change((x) => setConstraint(x, 'pattern', v))}
        />
      </label>
    )
  if (refs.length || f.ownership)
    rows.push(
      <label key="ownership" className="detail">
        <span>Ownership</span>
        <Select
          value={f.ownership ?? ''}
          options={[{ value: '', label: '—' }, ...OWNERSHIPS.map((o) => ({ value: o, label: o }))]}
          onChange={(v) =>
            change((x) => {
              if (v) x.ownership = v
              else delete x.ownership
            })
          }
        />
      </label>
    )
  if (props.attribute) {
    rows.push(
      <div key="qualifiers" className="detail">
        <span>Qualifiers</span>
        <QualifierToggles
          qualifiers={DETAIL_QUALIFIERS.filter((q) => q !== 'atomic' || concurrencyOn || f.atomic)}
          value={f}
          onChange={(q, on) => change((x) => setAttributeQualifier(x, q, on))}
        />
      </div>
    )
    rows.push(
      <label key="accessors" className="detail">
        <span>Accessors</span>
        <Select
          value={f.accessors ?? ''}
          options={[
            { value: '', label: f.const ? 'getter' : 'getter and setter' },
            // A const attribute has no setter: `read` would be a second "getter"
            ...ACCESSORS.filter((a) => a !== 'read' || !f.const || f.accessors === 'read').map((a) => ({
              value: a,
              label: a === 'read' ? 'getter' : 'none'
            }))
          ]}
          onChange={(v) =>
            change((x) => {
              if (v) x.accessors = v
              else delete x.accessors
            })
          }
        />
      </label>
    )
    if (props.locks?.length || f.guardedBy)
      rows.push(
        <label key="lock" className="detail">
          <span>Guarded by</span>
          <Select
            value={f.guardedBy ?? ''}
            options={[
              { value: '', label: '—' },
              ...(props.locks ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` }))
            ]}
            onChange={(v) =>
              change((x) => {
                if (v) x.guardedBy = v
                else delete x.guardedBy
              })
            }
          />
        </label>
      )
  }
  return (
    <div className="field-details">
      {rows.length ? rows : <span className="muted">No constraints apply to this type.</span>}
    </div>
  )
}
