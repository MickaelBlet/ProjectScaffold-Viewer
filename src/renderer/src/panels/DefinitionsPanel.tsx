// Definitions tab: every dependency, binary, type, interface, constant, module and link of the document
// in one list (filter, kinds, usages, problems), beside the editor of the chosen one.
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { allTypeRefs, endpointLabel, modulePaths, newId, uniqueName } from '@/model/project'
import { removeBinary } from '@/model/binaries'
import { dependencyEntities } from '@/model/dependencies'
import { walkTypeRef } from '@/model/typeExpr'
import { formatValue } from '@/model/defaults'
import type { Id, Module, Project } from '@/model/types'
import type { Problem, Severity } from '@/model/validate'
import { useDoc, type Selection } from '@/store/documents'
import { addConst, addInterface, addType, deleteConst, update, useProjectStore } from '@/store/project'
import { openContextMenu, select, useUiStore, type MenuItem } from '@/store/ui'
import { commandItem } from '@/commands'
import { addModuleAt, navigate, openImportSource, pickDependency } from '@/actions'
import { openEditor, type EditorKind } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'
import { childrenByParent } from './ModulesPanel'
import { dependencyMenu, DependencyDetail } from './DependenciesPanel'
import { useProblems } from './ProblemsPanel'
import { TypeInspector } from './TypeInspector'
import { InterfaceInspector } from './InterfaceInspector'
import { ConstInspector } from './ConstInspector'
import { ModuleInspector } from './ModuleInspector'
import { LinkInspector } from './LinkInspector'
import { BinaryInspector } from './BinaryInspector'

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

type Category = 'dependency' | 'binary' | 'type' | 'interface' | 'const' | 'module' | 'link'
interface Current {
  kind: Category
  id: Id
}

/** One line of the list. */
interface Row {
  kind: Category
  id: Id
  name: string
  /** Also matched by the filter (module path, link ends). */
  search: string
  title?: string
  badge: ReactNode
  summary: string
  /** Defined by a dependency (read-only). */
  dependency: boolean
  /** Nesting of modules. */
  depth?: number
}

// Same order as the Explorer's sections.
const CATEGORIES: { kind: Category; title: string }[] = [
  { kind: 'binary', title: 'Binaries' },
  { kind: 'dependency', title: 'Dependencies' },
  { kind: 'const', title: 'Constants' },
  { kind: 'type', title: 'Types' },
  { kind: 'interface', title: 'Interfaces' },
  { kind: 'module', title: 'Modules' },
  { kind: 'link', title: 'Links' }
]

/** Categories edited in the inspector and in a tab of their own: chosen there too. */
const isEditor = (k: string): k is EditorKind =>
  k === 'type' || k === 'interface' || k === 'module' || k === 'link'

/** The selection when it is one of the definitions. */
function editedIn(s: Selection): Current | null {
  return s && 'id' in s && isEditor(s.kind) ? { kind: s.kind, id: s.id } : null
}

const counted = new WeakMap<Project, Map<Id, number>>()

/** Number of places using each type (references), interface (ports) and module (links), once per project version. */
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
  for (const l of p.links) {
    add(l.from.moduleId)
    if (l.to.moduleId !== l.from.moduleId) add(l.to.moduleId)
  }
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

/** Lines of each category, the dependencies' types, interfaces and constants included. */
function rowsOf(p: Project): Record<Category, Row[]> {
  const paths = modulePaths(p)
  const modules: Row[] = []
  const children = childrenByParent(p.modules)
  const walk = (list: Module[], depth: number): void => {
    for (const m of list) {
      modules.push({
        kind: 'module',
        id: m.id,
        name: m.name,
        search: paths.get(m.id) ?? m.name,
        title: [paths.get(m.id), m.description].filter(Boolean).join('\n'),
        badge: (
          <span className="kind-badge mod" style={m.color ? { background: m.color } : undefined}>
            M
          </span>
        ),
        summary: m.ports.length ? count(m.ports.length, 'port') : '',
        dependency: false,
        depth
      })
      walk(children.get(m.id) ?? [], depth + 1)
    }
  }
  walk(children.get(null) ?? [], 0)
  return {
    dependency: p.dependencies.map((d) => ({
      kind: 'dependency',
      id: d.id,
      name: d.name,
      search: d.name,
      title: `${d.file}${d.indirect ? ' (used by another dependency)' : ''}`,
      badge: <span className="kind-badge dependency">D</span>,
      summary: d.indirect ? 'indirect' : count(dependencyEntities(p, d.id).length, 'definition'),
      dependency: d.indirect
    })),
    binary: p.binaries.map((b) => ({
      kind: 'binary',
      id: b.id,
      name: b.name,
      search: b.name,
      title: b.description || undefined,
      badge: (
        <span className="kind-badge binary" style={b.color ? { background: b.color } : undefined}>
          B
        </span>
      ),
      summary: count(p.modules.filter((m) => m.binaryId === b.id).length, 'module'),
      dependency: false
    })),
    type: p.types.map((t) => ({
      kind: 'type',
      id: t.id,
      name: t.name,
      search: t.name,
      title: t.description || undefined,
      badge: (
        <span className={`kind-badge ${t.kind}`} title={t.kind}>
          {KIND_BADGE[t.kind]}
        </span>
      ),
      summary:
        t.kind === 'struct' || t.kind === 'exception'
          ? count(t.fields.length, 'field')
          : t.kind === 'enum'
            ? count(t.values.length, 'value')
            : t.kind === 'bitmask'
              ? count(t.flags.length, 'flag')
              : t.kind === 'union'
                ? count(t.cases.length, 'case')
                : '',
      dependency: !!t.dependency
    })),
    interface: p.interfaces.map((i) => ({
      kind: 'interface',
      id: i.id,
      name: i.name,
      search: i.name,
      title: i.description || undefined,
      badge: <span className="kind-badge interface">I</span>,
      summary: `${i.messages.length} msg`,
      dependency: !!i.dependency
    })),
    const: p.consts.map((c) => ({
      kind: 'const',
      id: c.id,
      name: c.name,
      search: c.name,
      title: c.description || undefined,
      badge: <span className="kind-badge const">C</span>,
      summary: `= ${formatValue(c.value)}`,
      dependency: !!c.dependency
    })),
    module: modules,
    link: p.links
      .map((l) => {
        const from = endpointLabel(p, paths, l.from)
        const to = endpointLabel(p, paths, l.to)
        const arrow = l.constraints.direction === 'bidirectional' ? '↔' : '→'
        return {
          kind: 'link' as const,
          id: l.id,
          name: l.name,
          search: `${l.name} ${from} ${to}`,
          title: `${from} ${arrow} ${to}${l.description ? `\n${l.description}` : ''}`,
          badge: <span className="kind-badge link">L</span>,
          summary: `${from.split(':')[0]} ${arrow} ${to.split(':')[0]}`,
          dependency: false
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** New binary, returning its id. */
function addBinary(): Id {
  const id = newId()
  update((d) => {
    const name = uniqueName(
      'Binary',
      d.binaries.map((b) => b.name)
    )
    d.binaries.push({ id, name, description: '' })
  })
  return id
}

/** Choose a line: types, interfaces, modules and links become the selection (copy, delete act on them). */
function choose({ kind, id }: Current, set: (c: Current) => void): void {
  set({ kind, id })
  if (isEditor(kind)) return select({ kind, id })
  select({ kind: 'project' })
  if (kind === 'dependency') useUiStore.setState({ dependency: id })
}

function newMenu(set: (c: Current) => void): MenuItem[] {
  return [
    ...TYPE_KINDS.map((k) => ({
      label: `New ${k}`,
      run: () => choose({ kind: 'type', id: addType(k) }, set)
    })),
    'separator',
    { label: 'New interface', run: () => choose({ kind: 'interface', id: addInterface() }, set) },
    { label: 'New constant', run: () => choose({ kind: 'const', id: addConst() }, set) },
    'separator',
    { label: 'New module', run: () => choose({ kind: 'module', id: addModuleAt() }, set) },
    { label: 'New binary', run: () => choose({ kind: 'binary', id: addBinary() }, set) },
    { label: 'New dependency…', run: () => void pickDependency() }
  ]
}

function rowMenu(e: MouseEvent, x: Row, project: Project, set: (c: Current) => void): void {
  e.preventDefault()
  choose(x, set)
  const { kind, id } = x
  if (isEditor(kind))
    return openContextMenu(e, [
      { label: 'Open in a tab', run: () => openEditor(kind, id) },
      { label: 'Open to the side', run: () => openEditor(kind, id, { split: true }) },
      ...(kind === 'module' || kind === 'link'
        ? [{ label: 'Show on the canvas', run: () => navigate({ kind, id }) }]
        : []),
      'separator',
      commandItem('edit.copy'),
      commandItem('edit.duplicate'),
      'separator',
      commandItem('edit.delete')
    ])
  if (kind === 'binary')
    return openContextMenu(e, [
      { label: 'Remove binary', danger: true, run: () => update((d) => removeBinary(d, id)) }
    ])
  if (kind === 'const')
    return openContextMenu(e, [
      { label: 'Delete constant', danger: true, disabled: x.dependency, run: () => deleteConst(id) }
    ])
  const dep = project.dependencies.find((d) => d.id === id)
  if (dep) dependencyMenu(e, dep)
}

export function DefinitionsPanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const usages = useProjectStore((s) => usageCounts(s.project))
  const all = useMemo(() => rowsOf(project), [project])
  const problems = severities(useProblems())
  const selection = useDoc((d) => d.selection)
  const dependency = useUiStore((s) => s.dependency)
  const [current, setCurrent] = useState(() => editedIn(selection))
  const [filter, setFilter] = useState('')
  const [only, setOnly] = useState<Category | null>(null)
  const [withDependencies, setWithDependencies] = useState(false)

  // Follows what is selected elsewhere (Explorer, canvas, Used by, Search) and the chosen dependency.
  const [seen, setSeen] = useState({ selection, dependency })
  if (selection !== seen.selection || dependency !== seen.dependency) {
    setSeen({ selection, dependency })
    const edited = selection !== seen.selection && editedIn(selection)
    if (edited) setCurrent(edited)
    else if (dependency !== seen.dependency && dependency) setCurrent({ kind: 'dependency', id: dependency })
  }

  const f = filter.trim().toLowerCase()
  const shown = (x: Row): boolean =>
    (withDependencies || x.kind === 'dependency' || !x.dependency) &&
    (!f || x.search.toLowerCase().includes(f))
  const groups = CATEGORIES.filter((c) => !only || only === c.kind).map(({ kind, title }) => ({
    kind,
    title,
    rows: all[kind].filter(shown)
  }))
  const ids = groups.flatMap((g) => g.rows.map((x) => x.id))
  const stop = tabStop(ids, (id) => id === current?.id)
  const exists = !!current && all[current.kind].some((x) => x.id === current.id)
  const unset = (): void => setCurrent(null)
  const show = (c: Current): void => choose(c, setCurrent)

  const editor = (c: Current): ReactNode => {
    switch (c.kind) {
      case 'dependency': {
        const lib = project.dependencies.find((d) => d.id === c.id)
        return lib && <DependencyDetail key={c.id} lib={lib} filter="" />
      }
      case 'binary':
        return (
          <BinaryInspector
            key={c.id}
            id={c.id}
            onDeleted={unset}
            onModule={(id) => show({ kind: 'module', id })}
          />
        )
      case 'type':
        return <TypeInspector key={c.id} id={c.id} />
      case 'interface':
        return <InterfaceInspector key={c.id} id={c.id} />
      case 'const':
        return <ConstInspector key={c.id} id={c.id} onDeleted={unset} />
      case 'module':
        return <ModuleInspector key={c.id} id={c.id} />
      case 'link':
        return <LinkInspector key={c.id} id={c.id} />
    }
  }

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
              From dependencies
            </label>
          </div>
        </div>
        {groups.map(({ kind, title, rows }) => (
          <section key={kind} className="explorer-section open">
            <header>
              <span className="explorer-title">{title}</span>
              <small>{rows.length}</small>
            </header>
            <ul className="entity-list" role="listbox" aria-label={title} onKeyDown={onListKeyDown}>
              {rows.map((x) => {
                const severity = problems.get(x.id)
                const used = usages.get(x.id) ?? 0
                const active = x.id === current?.id
                return (
                  <li
                    key={x.id}
                    data-item
                    role="option"
                    aria-selected={active}
                    tabIndex={x.id === stop ? 0 : -1}
                    className={`${active ? 'active' : ''} ${x.dependency ? 'dependency' : ''}`}
                    title={x.title}
                    style={x.depth ? { paddingLeft: 6 + x.depth * 14 } : undefined}
                    onClick={() => show(x)}
                    onDoubleClick={() => {
                      const { kind, id } = x
                      if (isEditor(kind)) return openEditor(kind, id)
                      const file =
                        kind === 'dependency' && project.dependencies.find((d) => d.id === id)?.file
                      if (file) openImportSource(file)
                    }}
                    onContextMenu={(e) => rowMenu(e, x, project, setCurrent)}
                  >
                    {x.badge}
                    <span className="def-name">{x.name}</span>
                    {severity && <Icon name={severity} title={severity} />}
                    <small>{x.summary}</small>
                    {(x.kind === 'type' || x.kind === 'interface' || x.kind === 'module') && (
                      <small className={`def-used ${used ? '' : 'unused'}`} title={`Used ${used} times`}>
                        {used}×
                      </small>
                    )}
                  </li>
                )
              })}
              {!rows.length && (
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
          editor(current)
        ) : (
          <div className="def-empty">
            <p className="muted">
              {CATEGORIES.map(({ kind, title }) => `${all[kind].length} ${title.toLowerCase()}`).join(' · ')}
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
