// Dependencies of the active document, one at a time: where it comes from, the dependencies it
// uses and is used by, its types and interfaces with their members, and its modules placed here. Click selects (the Inspector shows
// it), double-click opens an editor tab, Right / Left expand and collapse.
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { typeUsageTargets } from '@/model/project'
import { dependencyEntities } from '@/model/dependencies'
import { printTypeRef } from '@/model/typeExpr'
import type { Dependency, Id, Interface, Message, Project, TypeDef, TypeRef } from '@/model/types'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { openContextMenu, select, useUiStore } from '@/store/ui'
import {
  detachDependencyAction,
  openImportSource,
  pickDependency,
  placeDependencyModule,
  refreshDependencies,
  removeDependencyAction
} from '@/actions'
import { openEditor } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'

type Entity = TypeDef | Interface

const KIND_BADGE = { struct: 'S', enum: 'E', alias: 'A', primitive: 'P' } as const

const isInterface = (e: Entity): e is Interface => 'messages' in e
const kindOf = (e: Entity): 'type' | 'interface' => (isInterface(e) ? 'interface' : 'type')

/** Names of the members of an entity, for the filter. */
function memberNames(e: Entity): string[] {
  if (isInterface(e)) return e.messages.map((m) => m.name)
  if (e.kind === 'struct') return e.fields.map((f) => f.name)
  if (e.kind === 'enum') return e.values.map((v) => v.name)
  return []
}

function summary(e: Entity, print: (t: TypeRef) => string): string {
  if (isInterface(e)) return `${e.messages.length} msg`
  switch (e.kind) {
    case 'struct':
      return `${e.fields.length} field${e.fields.length === 1 ? '' : 's'}`
    case 'enum':
      return `${e.underlying}, ${e.values.length} value${e.values.length === 1 ? '' : 's'}`
    case 'alias':
      return `= ${print(e.type)}`
    case 'primitive':
      return 'primitive'
  }
}

/** Uses of an entity outside its dependency: type references, or ports for an interface. */
function usageCount(p: Project, e: Entity, inside: Set<Id>): number {
  if (isInterface(e))
    return (
      p.modules.reduce((n, m) => n + m.ports.filter((pt) => pt.interfaceId === e.id).length, 0) +
      p.dependencies.reduce(
        (n, i) =>
          n + i.modules.reduce((k, m) => k + m.ports.filter((pt) => pt.interface === e.name).length, 0),
        0
      )
    )
  return typeUsageTargets(p, e.id).filter((u) => !inside.has(u.owner.id)).length
}

function signature(m: Message, print: (t: TypeRef) => string): ReactNode {
  return (
    <>
      <span className="lib-member-name">{m.name}</span>(
      {m.params.map((prm, i) => (
        <span key={prm.id}>
          {i > 0 && ', '}
          {prm.direction !== 'in' && <span className="lib-dir">{prm.direction} </span>}
          {prm.name}: <span className="lib-type">{print(prm.type)}</span>
        </span>
      ))}
      ){m.returns && <span className="lib-type"> → {print(m.returns)}</span>}
    </>
  )
}

function Members({ e, print }: { e: Entity; print: (t: TypeRef) => string }): ReactNode {
  const rows: { key: string; code: ReactNode; description?: string }[] = isInterface(e)
    ? e.messages.map((m) => ({ key: m.id, code: signature(m, print), description: m.description }))
    : e.kind === 'struct'
      ? e.fields.map((f) => ({
          key: f.id,
          code: (
            <>
              <span className="lib-member-name">{f.name}</span>:{' '}
              <span className="lib-type">{print(f.type)}</span>
              {f.default !== undefined && <span className="lib-default"> = {JSON.stringify(f.default)}</span>}
            </>
          ),
          description: f.description
        }))
      : e.kind === 'enum'
        ? e.values.map((v) => ({
            key: v.id,
            code: (
              <>
                <span className="lib-member-name">{v.name}</span> = {v.value}
              </>
            )
          }))
        : []
  if (!rows.length) return null
  return (
    <ul className="lib-members">
      {rows.map((r) => (
        <li key={r.key}>
          <code>{r.code}</code>
          {r.description && <small>{r.description}</small>}
        </li>
      ))}
    </ul>
  )
}

function entityMenu(ev: MouseEvent, e: Entity): void {
  ev.preventDefault()
  const kind = kindOf(e)
  select({ kind, id: e.id })
  openContextMenu(ev, [
    { label: 'Open in a tab', run: () => openEditor(kind, e.id) },
    { label: 'Open to the side', run: () => openEditor(kind, e.id, { split: true }) }
  ])
}

export function dependencyMenu(e: MouseEvent, dep: Dependency): void {
  e.preventDefault()
  openContextMenu(e, [
    { label: 'Place a module on the canvas…', run: () => placeDependencyModule(dep.id) },
    { label: `Open ${dep.file}`, run: () => openImportSource(dep.file) },
    { label: 'Refresh from its file', run: () => void refreshDependencies([dep.id]) },
    'separator',
    { label: 'Detach (make its types and interfaces own)', run: () => detachDependencyAction(dep.id) },
    { label: 'Remove', danger: true, run: () => removeDependencyAction(dep.id) }
  ])
}

const choose = (id: Id): void => useUiStore.setState({ dependency: id })

function Chips({
  label,
  names,
  dependencies
}: {
  label: string
  names: string[]
  dependencies: Dependency[]
}): ReactNode {
  return (
    <div className="lib-relation">
      <span className="muted">{label}</span>
      {names.length ? (
        names.map((n) => {
          const target = dependencies.find((l) => l.name === n)
          return (
            <button
              key={n}
              type="button"
              className="lib-chip"
              disabled={!target}
              onClick={() => target && choose(target.id)}
            >
              {n}
            </button>
          )
        })
      ) : (
        <span className="muted">none</span>
      )}
    </div>
  )
}

function Detail({ lib, filter }: { lib: Dependency; filter: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const selectedIds = useDoc((d) => d.selectedIds)
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(new Set())
  const f = filter.trim().toLowerCase()

  const all = useMemo(() => dependencyEntities(project, lib.id), [project, lib.id])
  const print = useMemo(() => {
    const names = new Map([...project.types, ...project.interfaces].map((e) => [e.id, e.name]))
    return (t: TypeRef): string => printTypeRef(t, (id) => names.get(id))
  }, [project.types, project.interfaces])
  const usages = useMemo(() => {
    const inside = new Set(all.map((e) => e.id))
    return new Map(all.map((e) => [e.id, usageCount(project, e, inside)]))
  }, [project, all])

  const shown = all.filter((e) => !f || [e.name, ...memberNames(e)].some((n) => n.toLowerCase().includes(f)))
  const types = shown.filter((e) => !isInterface(e))
  const interfaces = shown.filter(isInterface)
  const usedBy = project.dependencies.filter((l) => l.uses.includes(lib.name)).map((l) => l.name)
  const placed = lib.modules.filter((m) => !f || m.path.toLowerCase().includes(f))
  const stop = tabStop(
    [...types, ...interfaces].map((e) => e.id),
    (id) => selectedIds.includes(id)
  )
  const setOpen = (id: Id, open: boolean): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (open) next.delete(id)
      else next.add(id)
      return next
    })

  const item = (e: Entity): ReactNode => {
    // Filtering expands the entities shown, to see the members that match.
    const open = !!f || !collapsed.has(e.id)
    const members = memberNames(e).length > 0
    const used = usages.get(e.id) ?? 0
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return
      ev.preventDefault()
      setOpen(e.id, ev.key === 'ArrowRight')
    }
    return (
      <li
        key={e.id}
        data-item
        role="treeitem"
        aria-selected={selectedIds.includes(e.id)}
        aria-expanded={members ? open : undefined}
        tabIndex={e.id === stop ? 0 : -1}
        className={`lib-entity ${selectedIds.includes(e.id) ? 'active' : ''}`}
        onKeyDown={onKeyDown}
        onClick={() => select({ kind: kindOf(e), id: e.id })}
        onDoubleClick={() => openEditor(kindOf(e), e.id)}
        onContextMenu={(ev) => entityMenu(ev, e)}
      >
        <div className="lib-entity-head">
          <span
            className="chevron"
            aria-hidden
            onClick={(ev) => {
              ev.stopPropagation()
              setOpen(e.id, !open)
            }}
          >
            {members && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
          </span>
          {isInterface(e) ? (
            <span className="kind-badge interface">I</span>
          ) : (
            <span className={`kind-badge ${e.kind}`} title={e.kind}>
              {KIND_BADGE[e.kind]}
            </span>
          )}
          <span className="lib-entity-name">{e.name}</span>
          <small>{summary(e, print)}</small>
          <small className={`lib-usage ${used ? '' : 'unused'}`} title="Uses in this project">
            {used ? `used ${used}×` : 'unused'}
          </small>
        </div>
        {open && (
          <div className="lib-entity-body">
            {e.description && <p className="lib-description">{e.description}</p>}
            <Members e={e} print={print} />
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="lib-detail">
      <header className="lib-header">
        <span className="kind-badge dependency">D</span>
        <h3>{lib.name}</h3>
        <span className={`lib-tag ${lib.indirect ? 'indirect' : ''}`}>
          {lib.indirect ? 'indirect' : 'direct'}
        </span>
        <span className="explorer-actions">
          <button
            type="button"
            className="icon"
            title="Expand or collapse all"
            onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(all.map((e) => e.id)))}
          >
            <Icon name={collapsed.size ? 'chevron-down' : 'chevron-right'} />
          </button>
          <button
            type="button"
            className="icon"
            title={`Open ${lib.file}`}
            onClick={() => openImportSource(lib.file)}
          >
            <Icon name="open-tab" />
          </button>
          <button
            type="button"
            className="icon"
            title="Refresh from its file"
            onClick={() => void refreshDependencies([lib.id])}
          >
            <Icon name="refresh" />
          </button>
          <button type="button" className="icon" title="More…" onClick={(e) => dependencyMenu(e, lib)}>
            …
          </button>
        </span>
      </header>
      <p className="lib-file muted" title={lib.file}>
        {lib.file}
      </p>
      <Chips label="Uses" names={lib.uses} dependencies={project.dependencies} />
      <Chips label="Used by" names={usedBy} dependencies={project.dependencies} />
      {lib.shared.length > 0 && (
        <p className="lib-file muted">Also defines, like another dependency: {lib.shared.join(', ')}</p>
      )}

      <ul
        className="lib-entities"
        role="tree"
        aria-label={`Content of ${lib.name}`}
        onKeyDown={onListKeyDown}
      >
        {types.length > 0 && (
          <li className="lib-group" role="presentation">
            Types <small>{types.length}</small>
          </li>
        )}
        {types.map(item)}
        {interfaces.length > 0 && (
          <li className="lib-group" role="presentation">
            Interfaces <small>{interfaces.length}</small>
          </li>
        )}
        {interfaces.map(item)}
        <li className="lib-group" role="presentation">
          Modules on the canvas <small>{placed.length}</small>
          <button
            type="button"
            className="icon"
            title="Place a module on the canvas…"
            onClick={() => placeDependencyModule(lib.id)}
          >
            <Icon name="plus" />
          </button>
        </li>
        {placed.map((m) => (
          <li
            key={m.id}
            data-item
            role="treeitem"
            aria-selected={selectedIds.includes(m.id)}
            tabIndex={-1}
            className={`lib-entity ${selectedIds.includes(m.id) ? 'active' : ''}`}
            onClick={() => select({ kind: 'imported', id: m.id })}
          >
            <div className="lib-entity-head">
              <span className="chevron" aria-hidden />
              <span className="kind-badge mod">M</span>
              <span className="lib-entity-name">{m.path}</span>
              <small>
                {m.ports.length} port{m.ports.length === 1 ? '' : 's'}
              </small>
            </div>
          </li>
        ))}
        {!shown.length && !placed.length && f && (
          <li className="empty muted" role="presentation">
            No match
          </li>
        )}
      </ul>
    </div>
  )
}

export function DependenciesPanel(): ReactNode {
  const dependencies = useProjectStore((s) => s.project.dependencies)
  const chosen = useUiStore((s) => s.dependency)
  const [filter, setFilter] = useState('')
  const lib = dependencies.find((l) => l.id === chosen) ?? dependencies[0]
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const counts = useMemo(
    () => new Map(dependencies.map((l) => [l.id, dependencyEntities({ types, interfaces }, l.id).length])),
    [dependencies, types, interfaces]
  )

  return (
    <div className="libraries">
      <aside className="lib-list">
        <header>
          <span className="explorer-title">Dependencies</span>
          <span className="explorer-actions">
            <button type="button" className="icon" title="Add dependency…" onClick={() => pickDependency()}>
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="icon"
              title="Refresh all from their files"
              disabled={!dependencies.length}
              onClick={() => void refreshDependencies(dependencies.map((l) => l.id))}
            >
              <Icon name="refresh" />
            </button>
          </span>
        </header>
        <ul className="entity-list" role="listbox" aria-label="Dependencies" onKeyDown={onListKeyDown}>
          {dependencies.map((l) => (
            <li
              key={l.id}
              data-item
              role="option"
              aria-selected={l === lib}
              tabIndex={l === lib ? 0 : -1}
              className={l === lib ? 'active' : ''}
              title={`${l.file}${l.indirect ? ' (used by another dependency)' : ''}`}
              onClick={() => choose(l.id)}
              onDoubleClick={() => openImportSource(l.file)}
              onContextMenu={(e) => dependencyMenu(e, l)}
            >
              <span className="kind-badge dependency">D</span>
              <span className={l.indirect ? 'muted' : ''}>{l.name}</span>
              <small>{counts.get(l.id)}</small>
            </li>
          ))}
          {!dependencies.length && (
            <li className="empty" role="presentation">
              No dependencies: Insert › Add dependency…
            </li>
          )}
        </ul>
      </aside>
      <div className="lib-main">
        <div className="panel-filter">
          <input
            data-autofocus
            type="search"
            placeholder="Filter types, interfaces, members and modules"
            aria-label="Filter the dependency"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {lib ? (
          <Detail key={lib.id} lib={lib} filter={filter} />
        ) : (
          <p className="muted lib-none">No dependency selected.</p>
        )}
      </div>
    </div>
  )
}
