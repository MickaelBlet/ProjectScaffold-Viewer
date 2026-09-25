import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProjectStore } from '@/store/project'
import { parseTypeRef, printTypeRef, TypeExprError } from '@/model/typeExpr'
import { CONTAINERS, PRIMITIVES, type Primitive, type TypeRef } from '@/model/types'

const DEFAULT: TypeRef = { kind: 'primitive', name: 'uint8' }

function useTypeNames(): {
  nameOf: (id: string) => string | undefined
  idOf: (n: string) => string | undefined
  names: string[]
} {
  const types = useProjectStore((s) => s.project.types)
  return useMemo(() => {
    const byId = new Map(types.map((t) => [t.id, t.name]))
    const byName = new Map(types.map((t) => [t.name, t.id]))
    return { nameOf: (id) => byId.get(id), idOf: (n) => byName.get(n), names: types.map((t) => t.name) }
  }, [types])
}

/** Type reference editor: a text expression with completion, plus an optional structured tree. */
export function TypeEditor(props: { value: TypeRef; onChange: (t: TypeRef) => void }): ReactNode {
  const { nameOf, idOf, names } = useTypeNames()
  const text = printTypeRef(props.value, nameOf)
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState<string | null>(null)
  const [tree, setTree] = useState(false)
  const [suggest, setSuggest] = useState<{ items: string[]; index: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setDraft(text)
    setError(null)
  }, [text])

  const candidates = useMemo(() => [...PRIMITIVES, ...names, ...CONTAINERS.map((c) => `${c}<`)], [names])

  const check = (s: string): TypeRef | null => {
    try {
      const t = parseTypeRef(s, idOf)
      setError(null)
      return t
    } catch (e) {
      setError(e instanceof TypeExprError ? e.message : String(e))
      return null
    }
  }

  const commit = (): void => {
    setSuggest(null)
    if (draft === text) return setError(null)
    const t = check(draft)
    if (t) props.onChange(t)
  }

  const updateSuggestions = (value: string, caret: number): void => {
    const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(value.slice(0, caret))
    if (!m) return setSuggest(null)
    const items = candidates.filter((c) => c.startsWith(m[0]) && c !== m[0])
    setSuggest(items.length ? { items: items.slice(0, 8), index: 0 } : null)
  }

  const apply = (item: string): void => {
    const el = input.current
    if (!el) return
    const caret = el.selectionStart ?? draft.length
    const before = draft.slice(0, caret).replace(/[A-Za-z_][A-Za-z0-9_]*$/, '')
    const next = before + item + draft.slice(caret)
    setDraft(next)
    setSuggest(null)
    requestAnimationFrame(() => {
      const pos = before.length + item.length
      el.setSelectionRange(pos, pos)
      el.focus()
    })
  }

  return (
    <div className="type-editor">
      <div className="type-editor-line">
        <span className="field">
          <input
            ref={input}
            className={`type-input ${error ? 'invalid' : ''}`}
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value)
              updateSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onBlur={() => setTimeout(commit, 120)}
            onKeyDown={(e) => {
              if (suggest) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const d = e.key === 'ArrowDown' ? 1 : -1
                  setSuggest({
                    ...suggest,
                    index: (suggest.index + d + suggest.items.length) % suggest.items.length
                  })
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && suggest.items[suggest.index])) {
                  e.preventDefault()
                  apply(suggest.items[suggest.index]!)
                  return
                }
                if (e.key === 'Escape') return setSuggest(null)
              }
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setDraft(text)
            }}
          />
          {suggest && (
            <ul className="suggestions">
              {suggest.items.map((s, i) => (
                <li
                  key={s}
                  className={i === suggest.index ? 'active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    apply(s)
                  }}
                >
                  {s}
                </li>
              ))}
            </ul>
          )}
          {error && <span className="field-error">{error}</span>}
        </span>
        <button
          type="button"
          className={`icon ${tree ? 'active' : ''}`}
          title="Structured editor"
          aria-label="Structured editor"
          onClick={() => setTree(!tree)}
        >
          ⋮
        </button>
      </div>
      {tree && <TypeTree value={props.value} onChange={props.onChange} />}
    </div>
  )
}

function TypeTree(props: { value: TypeRef; onChange: (t: TypeRef) => void; label?: string }): ReactNode {
  const types = useProjectStore((s) => s.project.types)
  const t = props.value
  const selected = t.kind === 'primitive' ? t.name : t.kind === 'ref' ? `ref:${t.id}` : t.kind

  const change = (v: string): void => {
    if ((PRIMITIVES as readonly string[]).includes(v))
      return props.onChange({ kind: 'primitive', name: v as Primitive })
    if (v.startsWith('ref:')) return props.onChange({ kind: 'ref', id: v.slice(4) })
    const inner = 'of' in t ? t.of : t.kind === 'map' ? t.value : DEFAULT
    switch (v) {
      case 'array':
        return props.onChange({ kind: 'array', of: inner, size: 'size' in t ? t.size : 1 })
      case 'map':
        return props.onChange({ kind: 'map', key: { kind: 'primitive', name: 'string' }, value: inner })
      case 'vector':
      case 'list':
      case 'set':
      case 'optional':
        return props.onChange({ kind: v, of: inner })
    }
  }

  return (
    <div className="type-tree">
      <div className="type-tree-node">
        {props.label && <span className="type-tree-label">{props.label}</span>}
        <select value={selected} onChange={(e) => change(e.target.value)}>
          <optgroup label="Primitives">
            {PRIMITIVES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </optgroup>
          {types.length > 0 && (
            <optgroup label="User types">
              {types.map((ut) => (
                <option key={ut.id} value={`ref:${ut.id}`}>
                  {ut.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Containers">
            {CONTAINERS.map((c) => (
              <option key={c} value={c}>
                {c}&lt;…&gt;
              </option>
            ))}
          </optgroup>
          {t.kind === 'ref' && !types.some((ut) => ut.id === t.id) && (
            <option value={selected}>&lt;deleted&gt;</option>
          )}
        </select>
        {t.kind === 'array' && (
          <input
            className="number"
            type="number"
            min={1}
            value={t.size}
            title="Array size"
            onChange={(e) => {
              const size = Math.floor(Number(e.target.value))
              if (size > 0) props.onChange({ ...t, size })
            }}
          />
        )}
      </div>
      {'of' in t && (
        <TypeTree
          label={t.kind === 'array' ? 'element' : 'of'}
          value={t.of}
          onChange={(of) => props.onChange({ ...t, of })}
        />
      )}
      {t.kind === 'map' && (
        <>
          <TypeTree label="key" value={t.key} onChange={(key) => props.onChange({ ...t, key })} />
          <TypeTree label="value" value={t.value} onChange={(value) => props.onChange({ ...t, value })} />
        </>
      )}
    </div>
  )
}
