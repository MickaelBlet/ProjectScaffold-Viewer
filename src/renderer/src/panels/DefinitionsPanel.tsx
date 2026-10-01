// Definitions tab: every constant, type and interface of the document in one list (filter, kinds,
// usages, problems), beside the editor of the chosen one.
import { useState, type MouseEvent, type ReactNode } from 'react'
import { allTypeRefs } from '@/model/project'
import { walkTypeRef } from '@/model/typeExpr'
import { formatValue } from '@/model/defaults'
import type { ConstDef, Id, Interface, Project, TypeDef } from '@/model/types'
import type { Problem, Severity } from '@/model/validate'
import { useDoc } from '@/store/documents'
import { addConst, addInterface, addType, deleteConst, useProjectStore } from '@/store/project'
import { openContextMenu, select, type MenuItem } from '@/store/ui'
import { commandItem } from '@/commands'
import { openEditor } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'
import { useProblems } from './ProblemsPanel'
import { TypeInspector } from './TypeInspector'
import { InterfaceInspector } from './InterfaceInspector'
import { ConstInspector } from './ConstInspector'

const TYPE_KINDS = ['struct', 'enum', 'bitmask', 'union', 'exception', 'alias', 'primitive'] as const

const KIND_BADGE = {
  struct: 'S',
  enum: 'E',
  bitmask: 'B',
  union: 'U',
  exception: 'X',
  alias: 'A',
  primitive: 'P'
} as const

type Category = 'const' | 'type' | 'interface'
type Current = { kind: 'const'; id: Id } | { kind: 'type'; id: Id } | { kind: 'interface'; id: Id }
type Entry =
  { kind: 'const'; e: ConstDef } | { kind: 'type'; e: TypeDef } | { kind: 'interface'; e: Interface }

const CATEGORIES: { kind: Category; title: string }[] = [
  { kind: 'const', title: 'Constants' },
  { kind: 'type', title: 'Types' },
  { kind: 'interface', title: 'Interfaces' }
]

const counted = new WeakMap<Project, Map<Id, number>>()

/** Number of places using each type (references) and interface (ports), once per project version. */
function usageCounts(p: Project): Map<Id, number> {
  const counts = counted.get(p)
  if (counts) return counts
  const out = new Map<Id, number>()
  const add = (id: Id): void => void out.set(id, (out.get(id) ?? 0) + 1)
  for (const { ref } of allTypeRefs(p)) {
    const ids = new Set<Id>()
    walkTypeRef(ref, (n) => n.kind === 'ref' && ids.add(n.id))
    ids.forEach(add)
  }
  for (const m of p.modules) for (const port of m.ports) if (port.interfaceId) add(port.interfaceId)
  counted.set(p, out)
  return out
}

/** Worst problem of each entity. */
function severities(problems: Problem[]): Map<Id, Severity> {
  const out = new Map<Id, Severity>()
  for (const { target, severity } of problems)
    if ('id' in target && out.get(target.id) !== 'error') out.set(target.id, severity)
  return out
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

function summary(x: Entry): string {
  if (x.kind === 'const') return `= ${formatValue(x.e.value)}`
  if (x.kind === 'interface') return `${x.e.messages.length} msg`
  const t = x.e
  switch (t.kind) {
    case 'struct':
    case 'exception':
      return count(t.fields.length, 'field')
    case 'enum':
      return count(t.values.length, 'value')
    case 'bitmask':
      return count(t.flags.length, 'flag')
    case 'union':
      return count(t.cases.length, 'case')
    default:
      return ''
  }
}

function badge(x: Entry): ReactNode {
  if (x.kind === 'const') return <span className="kind-badge const">C</span>
  if (x.kind === 'interface') return <span className="kind-badge interface">I</span>
  return (
    <span className={`kind-badge ${x.e.kind}`} title={x.e.kind}>
      {KIND_BADGE[x.e.kind]}
    </span>
  )
}

/** Choose an entry: types and interfaces become the selection (copy, delete act on them). */
function choose(x: Current, set: (c: Current) => void): void {
  set(x)
  select(x.kind === 'const' ? { kind: 'project' } : x)
}

function newMenu(set: (c: Current) => void): MenuItem[] {
  return [
    ...TYPE_KINDS.map((k) => ({
      label: `New ${k}`,
      run: () => choose({ kind: 'type', id: addType(k) }, set)
    })),
    'separator',
    { label: 'New interface', run: () => choose({ kind: 'interface', id: addInterface() }, set) },
    { label: 'New constant', run: () => choose({ kind: 'const', id: addConst() }, set) }
  ]
}

function entryMenu(e: MouseEvent, x: Entry, set: (c: Current) => void): void {
  e.preventDefault()
  choose({ kind: x.kind, id: x.e.id }, set)
  const readonly = !!x.e.dependency
  openContextMenu(
    e,
    x.kind === 'const'
      ? [{ label: 'Delete constant', danger: true, disabled: readonly, run: () => deleteConst(x.e.id) }]
      : [
          { label: 'Open in a tab', run: () => openEditor(x.kind, x.e.id) },
          { label: 'Open to the side', run: () => openEditor(x.kind, x.e.id, { split: true }) },
          'separator',
          commandItem('edit.copy'),
          commandItem('edit.duplicate'),
          'separator',
          commandItem('edit.delete')
        ]
  )
}

export function DefinitionsPanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const usages = useProjectStore((s) => usageCounts(s.project))
  const problems = severities(useProblems())
  const selection = useDoc((d) => d.selection)
  const [current, setCurrent] = useState<Current | null>(
    selection?.kind === 'type' || selection?.kind === 'interface' ? selection : null
  )
  const [filter, setFilter] = useState('')
  const [only, setOnly] = useState<Category | null>(null)
  const [withDependencies, setWithDependencies] = useState(false)

  // Follows the types and interfaces selected elsewhere (Explorer, Used by, Search).
  const [seen, setSeen] = useState(selection)
  if (selection !== seen) {
    setSeen(selection)
    if (selection?.kind === 'type' || selection?.kind === 'interface') setCurrent(selection)
  }

  const f = filter.trim().toLowerCase()
  const shown = (e: ConstDef | TypeDef | Interface): boolean =>
    (withDependencies || !e.dependency) && (!f || e.name.toLowerCase().includes(f))
  const groups = CATEGORIES.filter((c) => !only || only === c.kind).map(({ kind, title }) => {
    const entries: Entry[] =
      kind === 'const'
        ? project.consts.filter(shown).map((e) => ({ kind, e }))
        : kind === 'type'
          ? project.types.filter(shown).map((e) => ({ kind, e }))
          : project.interfaces.filter(shown).map((e) => ({ kind, e }))
    return { kind, title, entries }
  })
  const ids = groups.flatMap((g) => g.entries.map((x) => x.e.id))
  const stop = tabStop(ids, (id) => id === current?.id)
  const exists =
    !!current &&
    (current.kind === 'const'
      ? project.consts
      : current.kind === 'type'
        ? project.types
        : project.interfaces
    ).some((e) => e.id === current.id)

  return (
    <div className="definitions">
      <div className="def-list">
        <div className="panel-filter">
          <div className="row-inline">
            <input
              data-autofocus
              type="search"
              placeholder="Filter"
              aria-label="Filter the definitions"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              type="button"
              title="New definition"
              onClick={(e) => openContextMenu(e, newMenu(setCurrent))}
            >
              <Icon name="plus" /> New
            </button>
          </div>
          <div className="def-kinds" role="group" aria-label="Show">
            {[{ kind: null, title: 'All' }, ...CATEGORIES].map((c) => (
              <button
                key={c.title}
                type="button"
                className={only === c.kind ? 'on' : ''}
                aria-pressed={only === c.kind}
                onClick={() => setOnly(c.kind)}
              >
                {c.title}
              </button>
            ))}
            <label className="check" title="Also list what the dependencies define (read-only)">
              <input
                type="checkbox"
                checked={withDependencies}
                onChange={(e) => setWithDependencies(e.target.checked)}
              />
              Dependencies
            </label>
          </div>
        </div>
        {groups.map(({ kind, title, entries }) => (
          <section key={kind} className="explorer-section open">
            <header>
              <span className="explorer-title">{title}</span>
              <small>{entries.length}</small>
            </header>
            <ul className="entity-list" role="listbox" aria-label={title} onKeyDown={onListKeyDown}>
              {entries.map((x) => {
                const id = x.e.id
                const severity = problems.get(id)
                const used = usages.get(id) ?? 0
                return (
                  <li
                    key={id}
                    data-item
                    role="option"
                    aria-selected={id === current?.id}
                    tabIndex={id === stop ? 0 : -1}
                    className={`${id === current?.id ? 'active' : ''} ${x.e.dependency ? 'dependency' : ''}`}
                    title={x.e.description || undefined}
                    onClick={() => choose({ kind, id }, setCurrent)}
                    onDoubleClick={() => kind !== 'const' && openEditor(kind, id)}
                    onContextMenu={(e) => entryMenu(e, x, setCurrent)}
                  >
                    {badge(x)}
                    <span className="def-name">{x.e.name}</span>
                    {severity && <Icon name={severity} title={severity} />}
                    <small>{summary(x)}</small>
                    {kind !== 'const' && (
                      <small className={`def-used ${used ? '' : 'unused'}`} title={`Used ${used} times`}>
                        {used}×
                      </small>
                    )}
                  </li>
                )
              })}
              {!entries.length && (
                <li className="empty" role="presentation">
                  {f ? 'No match' : `No ${title.toLowerCase()} yet`}
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
      <div className="def-main inspector">
        {exists && current ? (
          current.kind === 'const' ? (
            <ConstInspector key={current.id} id={current.id} onDeleted={() => setCurrent(null)} />
          ) : current.kind === 'type' ? (
            <TypeInspector key={current.id} id={current.id} />
          ) : (
            <InterfaceInspector key={current.id} id={current.id} />
          )
        ) : (
          <div className="def-empty">
            <p className="muted">
              {project.consts.length} constants · {project.types.length} types · {project.interfaces.length}{' '}
              interfaces
            </p>
            <p className="muted">Choose a definition in the list, or create one.</p>
            <div className="button-grid">
              {newMenu(setCurrent).map(
                (m) =>
                  m !== 'separator' &&
                  'run' in m && (
                    <button key={m.label} type="button" onClick={m.run}>
                      <Icon name="plus" /> {m.label.replace('New ', '')}
                    </button>
                  )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
