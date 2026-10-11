// Editable lists of conditions (expressions): preconditions, postconditions, invariants.
import type { ReactNode } from 'react'
import { CommitInput, IconButton } from '@/components/fields'

/** One list of conditions; an emptied one is removed. */
export function ConditionList(props: {
  label: string
  values: readonly string[]
  onChange: (values: string[]) => void
}): ReactNode {
  const { values, onChange } = props
  if (!values.length) return null
  return (
    <div className="conditions">
      <span className="conditions-label">{props.label}</span>
      {values.map((v, i) => (
        <span key={i} className="row-inline condition">
          <CommitInput
            className="code"
            value={v}
            placeholder="expression"
            onCommit={(next) =>
              onChange(
                next.trim() ? values.map((x, j) => (j === i ? next : x)) : values.filter((_, j) => j !== i)
              )
            }
          />
          <IconButton
            icon="x"
            title="Remove condition"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          />
        </span>
      ))}
    </div>
  )
}

/** Buttons adding a condition to each list, by name. */
export function AddConditions(props: { lists: { label: string; add: () => void }[] }): ReactNode {
  return (
    <span className="add-conditions">
      {props.lists.map((l) => (
        <button key={l.label} type="button" className="link-button" onClick={l.add}>
          + {l.label}
        </button>
      ))}
    </span>
  )
}

/** A list with one more condition, `true` until written. */
export const withCondition = (values: readonly string[] | undefined): string[] => [...(values ?? []), 'true']

/** Set a list of conditions, or leave it out when empty. */
export function setConditions<K extends string>(
  e: Partial<Record<K, string[]>>,
  key: K,
  values: string[]
): void {
  if (values.length) e[key] = values
  else delete e[key]
}
