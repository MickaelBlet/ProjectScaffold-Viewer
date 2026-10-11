import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { navigate } from '@/actions'
import { parseTypeRef, printTypeRef, TypeExprError } from '@/model/typeExpr'
import { isModuleType, parseDependencyModuleRef, typeScope } from '@/model/project'
import type { ProblemTarget } from '@/model/validate'
import {
  BOUNDED_PRIMITIVES,
  CONTAINERS,
  PRIMITIVES,
  type Id,
  type Primitive,
  type TypeRef
} from '@/model/types'
import { Icon } from './Icon'
import { useDraft } from './useDraft'

const DEFAULT: TypeRef = { kind: 'primitive', name: 'uint8' }
/** The (qualified) name being typed before the caret. */
const NAME_END = /(?:[A-Za-z_]\w*\/)?[A-Za-z_][\w.]*$/

/**
 * Module whose types the type editors below name (its own and its bases' by their name, those of other
 * modules by their qualified name, as they may use them); null: outside modules (no types of modules).
 */
export const TypeScopeContext = createContext<Id | null>(null)

/** Names of the types in the current scope (`TypeScopeContext`), and those it may use. */
export function useTypeScope(): ReturnType<typeof typeScope> {
  const scope = useContext(TypeScopeContext)
  const project = useProjectStore((s) => s.project)
  const { types, modules, dependencies } = project
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the parts of the project names depend on
  return useMemo(() => typeScope(project, scope), [types, modules, dependencies, scope])
}

function useTypeNames(): {
  nameOf: (id: string) => string | undefined
  idOf: (n: string) => string | undefined
  names: string[]
} {
  const { nameOf, idOf, usable, modules } = useTypeScope()
  return useMemo(
    // Exceptions are only raised: not offered as types.
    () => ({
      nameOf,
      idOf,
      names: [
        ...usable.filter((u) => u.type.kind !== 'exception').map((u) => u.name),
        ...modules.map((m) => m.name)
      ]
    }),
    [nameOf, idOf, usable, modules]
  )
}

/**
 * Where a type reference leads: its type, its module, the placed module of a dependency (none
 * when not placed here).
 */
function useRefTarget(): (id: Id) => ProblemTarget | null {
  const { types, modules, dependencies } = useProjectStore((s) => s.project)
  return (id) => {
    if (types.some((t) => t.id === id)) return { kind: 'type', id }
    if (modules.some((m) => m.id === id)) return { kind: 'module', id }
    const of = parseDependencyModuleRef(id)
    const placed =
      of && dependencies.find((x) => x.id === of.dependency)?.modules.find((m) => m.path === of.path)
    return placed ? { kind: 'module', id: placed.id } : null
  }
}

/** Ids of the user types referenced by `t`, in order of appearance, without duplicates. */
function refIds(t: TypeRef, out: string[] = []): string[] {
  if (t.kind === 'ref') {
    if (!out.includes(t.id)) out.push(t.id)
  } else if ('of' in t) refIds(t.of, out)
  else if (t.kind === 'map') refIds(t.value, refIds(t.key, out))
  return out
}

/**
 * Type reference editor: a text expression with completion, plus an optional structured tree.
 * When `onToggleTree` is given the tree toggle is controlled and the caller renders `TypeTree`
 * itself (e.g. on a full-width row below a narrow table cell).
 */
export function TypeEditor(props: {
  value: TypeRef
  onChange: (t: TypeRef) => void
  tree?: boolean
  onToggleTree?: () => void
}): ReactNode {
  const { nameOf, idOf, names } = useTypeNames()
  const text = printTypeRef(props.value, nameOf)
  const [draft, setDraft] = useDraft(text)
  // Parse error of a draft of `text`: gone once the value changes.
  const [failure, setFailure] = useState<{ text: string; message: string } | null>(null)
  const error = failure?.text === text ? failure.message : null
  const setError = (message: string | null): void => setFailure(message === null ? null : { text, message })
  const [ownTree, setOwnTree] = useState(false)
  const tree = props.onToggleTree ? !!props.tree : ownTree
  const [suggest, setSuggest] = useState<{ items: string[]; index: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const targetOf = useRefTarget()
  const refs = refIds(props.value).flatMap((id) => {
    const target = nameOf(id) === undefined ? null : targetOf(id)
    return target ? [{ id, target }] : []
  })
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
    const m = NAME_END.exec(value.slice(0, caret))
    if (!m) return setSuggest(null)
    const items = candidates.filter((c) => c.startsWith(m[0]) && c !== m[0])
    setSuggest(items.length ? { items: items.slice(0, 8), index: 0 } : null)
  }

  const apply = (item: string): void => {
    const el = input.current
    if (!el) return
    const caret = el.selectionStart ?? draft.length
    const before = draft.slice(0, caret).replace(NAME_END, '')
    const next = before + item + draft.slice(caret)
    setDraft(next)
    setSuggest(null)
    requestAnimationFrame(() => {
      const pos = before.length + item.length
      el.setSelectionRange(pos, pos)
      el.focus()
    })
  }

  // Several types: a menu below the button.
  const goTo = (e: { currentTarget: Element }): void => {
    if (refs.length === 1) return navigate(refs[0]!.target)
    const r = e.currentTarget.getBoundingClientRect()
    openContextMenu(
      { clientX: r.left, clientY: r.bottom },
      refs.map(({ id, target }) => ({ label: nameOf(id)!, run: () => navigate(target) }))
    )
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
            // At once (a suggestion picked with the mouse keeps the focus): a row removed or moved by the
            // click that blurs must not take a late commit.
            onBlur={commit}
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
        {refs.length > 0 && (
          // Not a <button>: navigation stays available in read-only content (a disabled fieldset).
          <span
            role="button"
            tabIndex={0}
            className="nav-button"
            title={refs.length === 1 ? `Go to ${nameOf(refs[0]!.id)}` : 'Go to type'}
            aria-label="Go to type"
            onClick={goTo}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              goTo(e)
            }}
          >
            <Icon name="arrow-up-right" />
          </span>
        )}
        <button
          type="button"
          className={`icon ${tree ? 'active' : ''}`}
          title="Structured editor"
          aria-label="Structured editor"
          onClick={() => (props.onToggleTree ? props.onToggleTree() : setOwnTree(!ownTree))}
        >
          <Icon name="tree" />
        </button>
      </div>
      {tree && !props.onToggleTree && <TypeTree value={props.value} onChange={props.onChange} />}
    </div>
  )
}

export function TypeTree(props: {
  value: TypeRef
  onChange: (t: TypeRef) => void
  label?: string
}): ReactNode {
  const { nameOf, usable, modules } = useTypeScope()
  const types = useProjectStore((s) => s.project.types)
  const t = props.value
  const selected = t.kind === 'primitive' ? t.name : t.kind === 'ref' ? `ref:${t.id}` : t.kind

  // The bound is kept from one bounded kind to another.
  const bound = 'max' in t && t.max !== undefined ? { max: t.max } : {}
  const boundable =
    t.kind === 'primitive'
      ? (BOUNDED_PRIMITIVES as readonly string[]).includes(t.name)
      : t.kind === 'vector' || t.kind === 'list' || t.kind === 'set' || t.kind === 'map'

  const change = (v: string): void => {
    if ((PRIMITIVES as readonly string[]).includes(v))
      return props.onChange({
        kind: 'primitive',
        name: v as Primitive,
        ...((BOUNDED_PRIMITIVES as readonly string[]).includes(v) ? bound : {})
      })
    if (v.startsWith('ref:')) return props.onChange({ kind: 'ref', id: v.slice(4) })
    const inner = 'of' in t ? t.of : t.kind === 'map' ? t.value : DEFAULT
    switch (v) {
      case 'array':
        return props.onChange({ kind: 'array', of: inner, size: 'size' in t ? t.size : 1 })
      case 'map':
        return props.onChange({
          kind: 'map',
          key: { kind: 'primitive', name: 'string' },
          value: inner,
          ...bound
        })
      case 'vector':
      case 'list':
      case 'set':
        return props.onChange({ kind: v, of: inner, ...bound })
      case 'optional':
        return props.onChange({ kind: v, of: inner })
    }
  }

  const changeMax = (text: string): void => {
    if (
      t.kind !== 'primitive' &&
      t.kind !== 'vector' &&
      t.kind !== 'list' &&
      t.kind !== 'set' &&
      t.kind !== 'map'
    )
      return
    const rest = { ...t }
    delete rest.max
    const max = Math.floor(Number(text))
    if (!text.trim()) props.onChange(rest)
    else if (max > 0) props.onChange({ ...rest, max })
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
          {[false, true].map((ofModules) => {
            // Exceptions are only raised; the current type stays listed even when out of reach.
            const list = usable.filter(
              (u) => u.type.kind !== 'exception' && !!isModuleType(u.type) === ofModules
            )
            const current = t.kind === 'ref' && types.find((ut) => ut.id === t.id)
            if (
              current &&
              !!isModuleType(current) === ofModules &&
              !list.some((u) => u.type.id === current.id)
            )
              list.push({ type: current, name: nameOf(current.id)! })
            return (
              list.length > 0 && (
                <optgroup key={String(ofModules)} label={ofModules ? 'Types of modules' : 'User types'}>
                  {list.map((u) => (
                    <option key={u.type.id} value={`ref:${u.type.id}`}>
                      {u.name}
                    </option>
                  ))}
                </optgroup>
              )
            )
          })}
          {(() => {
            // The current module stays listed even when hidden by a type of the same name.
            const list = [...modules]
            if (t.kind === 'ref' && !types.some((ut) => ut.id === t.id) && !list.some((m) => m.id === t.id)) {
              const name = nameOf(t.id)
              if (name !== undefined) list.push({ id: t.id, name })
            }
            return (
              list.length > 0 && (
                <optgroup label="Modules">
                  {list.map((m) => (
                    <option key={m.id} value={`ref:${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )
            )
          })()}
          <optgroup label="Containers">
            {CONTAINERS.map((c) => (
              <option key={c} value={c}>
                {c}&lt;…&gt;
              </option>
            ))}
          </optgroup>
          {t.kind === 'ref' && nameOf(t.id) === undefined && (
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
        {boundable && (
          <input
            className="number"
            type="number"
            min={1}
            value={'max' in t ? (t.max ?? '') : ''}
            placeholder="max"
            title="Bound: most bytes of a string or bytes, most items of a container (empty: none)"
            onChange={(e) => changeMax(e.target.value)}
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
