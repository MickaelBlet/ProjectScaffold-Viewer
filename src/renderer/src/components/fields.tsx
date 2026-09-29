import type { ReactNode } from 'react'
import { PALETTE } from '@/model/project'
import type { Qualifier } from '@/model/types'
import { Icon, type IconName } from './Icon'
import { useDraft } from './useDraft'

/** Text input that keeps a local draft and commits on blur / Enter, rejecting invalid values. */
export function CommitInput(props: {
  value: string
  onCommit: (value: string) => void
  validate?: (value: string) => string | null
  placeholder?: string
  title?: string
  className?: string
  autoFocus?: boolean
  list?: string
}): ReactNode {
  const { value, onCommit, validate } = props
  const [draft, setDraft] = useDraft(value)
  const error = draft !== value && validate ? validate(draft) : null
  const commit = (): void => {
    if (draft === value) return
    if (error) setDraft(value)
    else onCommit(draft)
  }
  return (
    <span className={`field ${props.className ?? ''}`}>
      <input
        className={error ? 'invalid' : ''}
        value={draft}
        placeholder={props.placeholder}
        title={props.title}
        autoFocus={props.autoFocus}
        list={props.list}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </span>
  )
}

export function TextArea(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): ReactNode {
  return (
    <textarea
      rows={2}
      value={props.value}
      placeholder={props.placeholder ?? 'Description'}
      onChange={(e) => props.onChange(e.target.value)}
    />
  )
}

/** Optional number input: empty means undefined. */
export function NumberInput(props: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  integer?: boolean
  min?: number
  placeholder?: string
}): ReactNode {
  const text = props.value === undefined ? '' : String(props.value)
  const [draft, setDraft] = useDraft(text)
  const parse = (s: string): number | undefined | null => {
    if (s.trim() === '') return undefined
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    if (props.integer && !Number.isSafeInteger(n)) return null
    if (props.min !== undefined && n < props.min) return null
    return n
  }
  const parsed = parse(draft)
  return (
    <input
      className={`number ${parsed === null ? 'invalid' : ''}`}
      value={draft}
      placeholder={props.placeholder}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = parse(e.target.value)
        if (n !== null) props.onChange(n)
      }}
      onBlur={() => parsed === null && setDraft(text)}
    />
  )
}

export function Select<T extends string>(props: {
  value: T
  options: readonly T[] | { value: T; label: string }[]
  onChange: (v: T) => void
}): ReactNode {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        )
      })}
    </select>
  )
}

/** Toggle buttons of the qualifiers of an attribute, method or parameter; `short` labels them by initial. */
export function QualifierToggles(props: {
  qualifiers: readonly Qualifier[]
  value: { [K in Qualifier]?: boolean }
  onChange: (q: Qualifier, on: boolean) => void
  short?: boolean
}): ReactNode {
  return (
    <span className="qualifiers">
      {props.qualifiers.map((q) => {
        const on = !!props.value[q]
        return (
          <button
            type="button"
            key={q}
            className={`qualifier ${on ? 'on' : ''}`}
            aria-pressed={on}
            title={props.short ? q : undefined}
            onClick={() => props.onChange(q, !on)}
          >
            {props.short ? q[0]!.toUpperCase() : q}
          </button>
        )
      })}
    </span>
  )
}

export function Row(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="row">
      <span className="row-label">{props.label}</span>
      <span className="row-value">{props.children}</span>
    </label>
  )
}

export function Section(props: { title: string; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="section">
      <header>
        <h3>{props.title}</h3>
        <span className="section-actions">{props.actions}</span>
      </header>
      {props.children}
    </section>
  )
}

export function IconButton(props: {
  title: string
  onClick: () => void
  icon: IconName
  danger?: boolean
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      className={`icon ${props.danger ? 'danger' : ''}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  )
}

export function MetadataEditor(props: {
  value: Record<string, string>
  onChange: (fn: (m: Record<string, string>) => void) => void
}): ReactNode {
  const entries = Object.entries(props.value)
  return (
    <div className="metadata">
      {entries.map(([k, v]) => (
        <div key={k} className="kv">
          <CommitInput
            value={k}
            validate={(nk) =>
              !nk.trim() ? 'Key required' : nk !== k && nk in props.value ? 'Duplicate key' : null
            }
            onCommit={(nk) =>
              props.onChange((m) => {
                // Preserve order when renaming a key.
                const copy = Object.entries(m)
                for (const key of Object.keys(m)) delete m[key]
                for (const [ok, ov] of copy) m[ok === k ? nk : ok] = ov
              })
            }
          />
          <input value={v} onChange={(e) => props.onChange((m) => void (m[k] = e.target.value))} />
          <IconButton
            icon="x"
            title="Remove entry"
            danger
            onClick={() => props.onChange((m) => void delete m[k])}
          />
        </div>
      ))}
      <button
        type="button"
        className="link-button"
        onClick={() =>
          props.onChange((m) => {
            let i = 1
            while (`key${i}` in m) i++
            m[`key${i}`] = ''
          })
        }
      >
        <Icon name="plus" /> Add entry
      </button>
    </div>
  )
}

/** Swatches plus a free color; `undefined` is no color. */
export function ColorPicker(props: {
  value: string | undefined
  onChange: (v: string | undefined) => void
}): ReactNode {
  return (
    <div className="swatches">
      <button
        type="button"
        className={`swatch none ${props.value ? '' : 'active'}`}
        title="No color"
        onClick={() => props.onChange(undefined)}
      />
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch ${props.value === c ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => props.onChange(c)}
        />
      ))}
      <input
        type="color"
        title="Custom color"
        value={props.value && /^#[0-9a-f]{6}$/i.test(props.value) ? props.value : '#888888'}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}
