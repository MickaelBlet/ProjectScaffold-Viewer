// Views, dependencies, types, interfaces, modules and links of the active document. Click selects (Ctrl / Shift for several),
// double-click opens an editor tab, right click for more. Arrows move between items, Enter selects.
import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { endpointLabel, findView, modulePaths, newId, uniqueName } from '@/model/project'
import { removeBinary } from '@/model/binaries'
import { GLOBAL_VIEW, type Id, type Module, type View } from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import {
  addInterface,
  addType,
  addView,
  deleteItems,
  deleteView,
  getProject,
  renameView,
  update,
  useProjectStore
} from '@/store/project'
import { openContextMenu, select } from '@/store/ui'
import { commandItem } from '@/commands'
import {
  addModuleAt,
  navigate,
  newView,
  openImportSource,
  pickDependency,
  selectionOf,
  showDependency
} from '@/actions'
import { dependencyMenu } from './DependenciesPanel'
import { childrenByParent, matching } from './ModulesPanel'
import { openEditor, openView } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'

const KIND_BADGE = { struct: 'S', enum: 'E', alias: 'A', primitive: 'P' } as const

function Section(props: {
  title: string
  count?: number
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(true)
  const body = useId()
  return (
    <section className={`explorer-section ${open ? 'open' : ''}`}>
      <header>
        <button
          type="button"
          className="explorer-toggle"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen(!open)}
        >
          <span className="chevron">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          </span>
          <span className="explorer-title">{props.title}</span>
          {props.count !== undefined && <small>{props.count}</small>}
        </button>
        <span className="explorer-actions">{props.actions}</span>
      </header>
      {open && <div id={body}>{props.children}</div>}
    </section>
  )
}

/** Selectable entities of one kind: arrows move, Enter / Space select as a click does. */
function EntityList(props: { label: string; multiselectable?: boolean; children: ReactNode }): ReactNode {
  return (
    <ul
      className="entity-list"
      role="listbox"
      aria-label={props.label}
      aria-multiselectable={props.multiselectable}
      onKeyDown={onListKeyDown}
    >
      {props.children}
    </ul>
  )
}

function Item(props: {
  selected: boolean
  tabStop: boolean
  className?: string
  title?: string
  style?: CSSProperties
  onClick: (e: MouseEvent) => void
  onKeyDown?: (e: KeyboardEvent) => void
  onDoubleClick?: () => void
  onContextMenu: (e: MouseEvent) => void
  children: ReactNode
}): ReactNode {
  return (
    <li
      data-item
      role="option"
      aria-selected={props.selected}
      tabIndex={props.tabStop ? 0 : -1}
      className={props.className}
      title={props.title}
      style={props.style}
      onClick={props.onClick}
      onKeyDown={props.onKeyDown}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
    >
      {props.children}
    </li>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <li className="empty" role="presentation">
      {children}
    </li>
  )
}

/** New binary, edited in the project inspector. */
function addBinary(): void {
  update((d) => {
    const name = uniqueName(
      'Binary',
      d.binaries.map((b) => b.name)
    )
    d.binaries.push({ id: newId(), name, description: '' })
  })
  select({ kind: 'project' })
}

/** Click with Ctrl toggles, with Shift extends the selection over the list. */
function clickItem(e: MouseEvent, id: Id, list: Id[]): void {
  const doc = activeDoc()
  if (e.ctrlKey || e.metaKey) {
    const ids = doc.selectedIds.includes(id)
      ? doc.selectedIds.filter((x) => x !== id)
      : [...doc.selectedIds, id]
    return patchDoc({
      selectedIds: ids,
      selection: ids.length ? selectionOf(getProject(), ids.at(-1)!) : null
    })
  }
  if (e.shiftKey && doc.selection && 'id' in doc.selection) {
    const a = list.indexOf(doc.selection.id)
    const b = list.indexOf(id)
    if (a >= 0 && b >= 0) {
      const ids = list.slice(Math.min(a, b), Math.max(a, b) + 1)
      return patchDoc({ selectedIds: ids })
    }
  }
  const sel = selectionOf(getProject(), id)
  // Modules and links are also brought into view on the canvas.
  if (sel?.kind === 'module' || sel?.kind === 'link') return navigate(sel)
  select(sel)
}

function entityMenu(e: MouseEvent, kind: 'type' | 'interface' | 'module' | 'link', id: Id): void {
  e.preventDefault()
  if (!activeDoc().selectedIds.includes(id)) select({ kind, id })
  openContextMenu(e, [
    { label: 'Open in a tab', run: () => openEditor(kind, id) },
    { label: 'Open to the side', run: () => openEditor(kind, id, { split: true }) },
    'separator',
    commandItem('edit.cut'),
    commandItem('edit.copy'),
    commandItem('edit.paste'),
    commandItem('edit.duplicate'),
    'separator',
    commandItem('edit.delete')
  ])
}

function viewMenu(e: MouseEvent, v: View): void {
  e.preventDefault()
  const stored = v.id !== GLOBAL_VIEW
  openContextMenu(e, [
    { label: 'Open', run: () => openView(v.id) },
    { label: 'Open to the side', run: () => openView(v.id, { split: true }) },
    {
      label: 'Rename…',
      disabled: !stored,
      run: () => {
        const name = window.prompt('View name', v.name)
        if (name?.trim()) renameView(v.id, name.trim())
      }
    },
    {
      label: 'Duplicate',
      run: () => {
        const src = findView(getProject(), v.id)
        openView(addView(`${src.name} copy`, src.rootModuleId))
      }
    },
    'separator',
    { label: 'Delete', danger: true, disabled: !stored, run: () => deleteView(v.id) }
  ])
}

const GLOBAL: View = { id: GLOBAL_VIEW, name: 'Global', rootModuleId: null, hidden: [] }

export function ExplorerPanel(): ReactNode {
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const views = useProjectStore((s) => s.project.views)
  const modules = useProjectStore((s) => s.project.modules)
  const links = useProjectStore((s) => s.project.links)
  const dependencies = useProjectStore((s) => s.project.dependencies)
  const binaries = useProjectStore((s) => s.project.binaries)
  const [collapsed, setCollapsed] = useState<Set<Id>>(new Set())
  const selectedIds = useDoc((d) => d.selectedIds)
  const activeViewId = useDoc((d) => d.activeViewId)
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const match = (name: string): boolean => !f || name.toLowerCase().includes(f)
  const isSelected = (id: Id): boolean => selectedIds.includes(id)

  // Paths and link ends change with modules and links only, not with every edit.
  const paths = useMemo(() => modulePaths({ modules, dependencies }), [modules, dependencies])
  const moduleChildren = useMemo(() => childrenByParent(modules), [modules])
  const moduleMatches = f ? matching(moduleChildren, (m) => match(paths.get(m.id) ?? m.name)) : null
  const allLinks = useMemo(
    () =>
      links
        .map((l) => ({
          l,
          from: endpointLabel({ modules, dependencies }, paths, l.from),
          to: endpointLabel({ modules, dependencies }, paths, l.to)
        }))
        .sort((a, b) => a.l.name.localeCompare(b.l.name)),
    [links, modules, dependencies, paths]
  )

  const shownViews = [GLOBAL, ...views].filter((v) => match(v.name))
  const ownTypes = types.filter((t) => !t.dependency)
  const ownInterfaces = interfaces.filter((i) => !i.dependency)
  const shownTypes = ownTypes.filter((t) => match(t.name))
  const shownInterfaces = ownInterfaces.filter((i) => match(i.name))
  // Dependencies, each followed by its types, interfaces and placed modules (unless folded).
  const shownDependencies = dependencies.map((dep) => ({
    dep,
    entities: [...types, ...interfaces].filter((e) => e.dependency === dep.id && match(e.name)),
    placed: dep.modules.filter((m) => match(m.path))
  }))
  const dependencyIds = shownDependencies.flatMap(({ dep, entities, placed }) =>
    collapsed.has(dep.id) ? [dep.id] : [dep.id, ...entities.map((e) => e.id), ...placed.map((m) => m.id)]
  )
  const toggle = (id: Id): void => {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
  }
  // Modules as in Modules: nested under their parent, in project order (all open while filtering).
  const shownModules: { m: Module; depth: number; parent: boolean; open: boolean }[] = []
  const walk = (list: Module[], depth: number): void => {
    for (const m of list) {
      if (moduleMatches && !moduleMatches.has(m.id)) continue
      const children = moduleChildren.get(m.id) ?? []
      const open = !!moduleMatches || !collapsed.has(m.id)
      shownModules.push({ m, depth, parent: children.length > 0, open })
      if (open) walk(children, depth + 1)
    }
  }
  walk(moduleChildren.get(null) ?? [], 0)
  const shownBinaries = binaries.filter((b) => match(b.name))
  const binaryIds = shownBinaries.map((b) => b.id)
  const shownLinks = allLinks.filter((x) => match(x.l.name) || match(x.from) || match(x.to))
  const typeIds = shownTypes.map((t) => t.id)
  const interfaceIds = shownInterfaces.map((i) => i.id)
  const moduleIds = shownModules.map((x) => x.m.id)
  const linkIds = shownLinks.map((x) => x.l.id)
  const viewStop = tabStop(
    shownViews.map((v) => v.id),
    (id) => id === activeViewId
  )
  const typeStop = tabStop(typeIds, isSelected)
  const interfaceStop = tabStop(interfaceIds, isSelected)
  const dependencyStop = tabStop(dependencyIds, isSelected)
  const moduleStop = tabStop(moduleIds, isSelected)
  const binaryStop = tabStop(binaryIds, () => false)
  const linkStop = tabStop(linkIds, isSelected)

  return (
    <div className="explorer">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter"
          aria-label="Filter the explorer"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <Section
        title="Views"
        count={views.length + 1}
        actions={
          <button type="button" className="icon" title="New view" onClick={newView}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Views">
          {shownViews.map((v) => {
            const root = modules.find((m) => m.id === v.rootModuleId)
            return (
              <Item
                key={v.id}
                selected={v.id === activeViewId}
                tabStop={v.id === viewStop}
                className={v.id === activeViewId ? 'current' : ''}
                onClick={() => openView(v.id)}
                onContextMenu={(e) => viewMenu(e, v)}
              >
                <span className={`kind-badge view ${root ? 'drill' : ''}`}>
                  {root ? <Icon name="expand" /> : 'V'}
                </span>
                {v.name}
                <small>
                  {root ? root.name : ''}
                  {v.hidden.length ? ` −${v.hidden.length}` : ''}
                </small>
              </Item>
            )
          })}
        </EntityList>
      </Section>

      <Section
        title="Dependencies"
        count={dependencies.length}
        actions={
          <button type="button" className="icon" title="Add dependency…" onClick={() => pickDependency()}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Dependencies" multiselectable>
          {shownDependencies.map(({ dep, entities, placed }) => [
            <Item
              key={dep.id}
              selected={false}
              tabStop={dep.id === dependencyStop}
              className="dependency"
              title={`${dep.file}${dep.indirect ? ' (used by another dependency)' : ''}${dep.uses.length ? `\nUses ${dep.uses.join(', ')}` : ''}`}
              onClick={() => toggle(dep.id)}
              onDoubleClick={() => showDependency(dep.id)}
              onContextMenu={(e) => dependencyMenu(e, dep)}
            >
              <Icon name={collapsed.has(dep.id) ? 'chevron-right' : 'chevron-down'} />
              <span className="kind-badge dependency">D</span>
              {dep.name}
              <small>{dep.indirect ? 'indirect' : dep.file}</small>
            </Item>,
            ...(collapsed.has(dep.id) ? [] : entities).map((e) => {
              const kind = 'messages' in e ? 'interface' : 'type'
              return (
                <Item
                  key={e.id}
                  selected={isSelected(e.id)}
                  tabStop={e.id === dependencyStop}
                  className={`nested ${isSelected(e.id) ? 'active' : ''}`}
                  onClick={(ev) => clickItem(ev, e.id, dependencyIds)}
                  onDoubleClick={() => openEditor(kind, e.id)}
                  onContextMenu={(ev) => entityMenu(ev, kind, e.id)}
                >
                  {'messages' in e ? (
                    <span className="kind-badge interface">I</span>
                  ) : (
                    <span className={`kind-badge ${e.kind}`} title={e.kind}>
                      {KIND_BADGE[e.kind]}
                    </span>
                  )}
                  {e.name}
                  {'messages' in e && <small>{e.messages.length} msg</small>}
                </Item>
              )
            }),
            ...(collapsed.has(dep.id) ? [] : placed).map((m) => (
              <Item
                key={m.id}
                selected={isSelected(m.id)}
                tabStop={m.id === dependencyStop}
                className={`nested ${isSelected(m.id) ? 'active' : ''}`}
                title={`${m.path}, placed on the canvas`}
                onClick={(ev) => clickItem(ev, m.id, dependencyIds)}
                onDoubleClick={() => navigate({ kind: 'module', id: m.id })}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  select({ kind: 'imported', id: m.id })
                  openContextMenu(ev, [
                    { label: 'Show on the canvas', run: () => navigate({ kind: 'module', id: m.id }) },
                    { label: `Open ${dep.file}`, run: () => openImportSource(dep.file) },
                    'separator',
                    { label: 'Remove from this project', danger: true, run: () => deleteItems([m.id]) }
                  ])
                }}
              >
                <span className="kind-badge mod">M</span>
                {m.path}
                <small>on canvas</small>
              </Item>
            ))
          ])}
          {!dependencies.length && <Empty>No dependencies: Insert › Add dependency…</Empty>}
        </EntityList>
      </Section>

      <Section
        title="Binaries"
        count={binaries.length}
        actions={
          <button type="button" className="icon" title="New binary" onClick={() => addBinary()}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Binaries">
          {shownBinaries.map((b) => {
            const inside = modules.filter((m) => m.binaryId === b.id)
            return (
              <Item
                key={b.id}
                selected={false}
                tabStop={b.id === binaryStop}
                title={`${b.description ? `${b.description}\n` : ''}Click: select its modules. Double-click: edit the binaries.`}
                onClick={() =>
                  patchDoc({
                    selectedIds: inside.map((m) => m.id),
                    selection: inside.length ? { kind: 'module', id: inside[0]!.id } : null
                  })
                }
                onDoubleClick={() => select({ kind: 'project' })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openContextMenu(e, [
                    { label: 'Edit binaries', run: () => select({ kind: 'project' }) },
                    'separator',
                    {
                      label: 'Remove binary',
                      danger: true,
                      run: () => update((d) => removeBinary(d, b.id))
                    }
                  ])
                }}
              >
                <span className="kind-badge binary" style={b.color ? { background: b.color } : undefined}>
                  B
                </span>
                {b.name}
                <small>{inside.length} modules</small>
              </Item>
            )
          })}
          {!shownBinaries.length && (
            <Empty>{f ? 'No match' : 'One binary: add some to split the modules into executables'}</Empty>
          )}
        </EntityList>
      </Section>

      <Section
        title="Types"
        count={ownTypes.length}
        actions={(['struct', 'enum', 'alias', 'primitive'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="icon"
            title={`New ${k}`}
            onClick={() => select({ kind: 'type', id: addType(k) })}
          >
            <Icon name="plus" />
            {KIND_BADGE[k]}
          </button>
        ))}
      >
        <EntityList label="Types" multiselectable>
          {shownTypes.map((t) => (
            <Item
              key={t.id}
              selected={isSelected(t.id)}
              tabStop={t.id === typeStop}
              className={isSelected(t.id) ? 'active' : ''}
              onClick={(e) => clickItem(e, t.id, typeIds)}
              onDoubleClick={() => openEditor('type', t.id)}
              onContextMenu={(e) => entityMenu(e, 'type', t.id)}
            >
              <span className={`kind-badge ${t.kind}`} title={t.kind}>
                {KIND_BADGE[t.kind]}
              </span>
              {t.name}
            </Item>
          ))}
          {!shownTypes.length && <Empty>{f ? 'No match' : 'No types yet'}</Empty>}
        </EntityList>
      </Section>

      <Section
        title="Interfaces"
        count={ownInterfaces.length}
        actions={
          <button
            type="button"
            className="icon"
            title="New interface"
            onClick={() => select({ kind: 'interface', id: addInterface() })}
          >
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Interfaces" multiselectable>
          {shownInterfaces.map((i) => (
            <Item
              key={i.id}
              selected={isSelected(i.id)}
              tabStop={i.id === interfaceStop}
              className={isSelected(i.id) ? 'active' : ''}
              onClick={(e) => clickItem(e, i.id, interfaceIds)}
              onDoubleClick={() => openEditor('interface', i.id)}
              onContextMenu={(e) => entityMenu(e, 'interface', i.id)}
            >
              <span className="kind-badge interface">I</span>
              {i.name}
              <small>{i.messages.length} msg</small>
            </Item>
          ))}
          {!shownInterfaces.length && <Empty>{f ? 'No match' : 'No interfaces yet'}</Empty>}
        </EntityList>
      </Section>

      <Section
        title="Modules"
        count={modules.length}
        actions={
          <button type="button" className="icon" title="New module" onClick={() => addModuleAt()}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Modules" multiselectable>
          {shownModules.map(({ m, depth, parent, open }) => (
            <Item
              key={m.id}
              selected={isSelected(m.id)}
              tabStop={m.id === moduleStop}
              className={isSelected(m.id) ? 'active' : ''}
              title={paths.get(m.id)}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={(e) => clickItem(e, m.id, moduleIds)}
              onKeyDown={(e) => {
                // Right expands, Left collapses, as in Modules.
                if (!parent || moduleMatches || e.key !== (open ? 'ArrowLeft' : 'ArrowRight')) return
                e.preventDefault()
                toggle(m.id)
              }}
              onDoubleClick={() => openEditor('module', m.id)}
              onContextMenu={(e) => entityMenu(e, 'module', m.id)}
            >
              <span
                className="chevron"
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation()
                  if (parent) toggle(m.id)
                }}
              >
                {parent && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
              </span>
              <span className="kind-badge mod" style={m.color ? { background: m.color } : undefined}>
                M
              </span>
              {m.name}
              <small>{m.ports.length ? `${m.ports.length}p` : ''}</small>
            </Item>
          ))}
          {!shownModules.length && <Empty>{f ? 'No match' : 'No modules yet'}</Empty>}
        </EntityList>
      </Section>

      <Section title="Links" count={links.length}>
        <EntityList label="Links" multiselectable>
          {shownLinks.map(({ l, from, to }) => (
            <Item
              key={l.id}
              selected={isSelected(l.id)}
              tabStop={l.id === linkStop}
              className={isSelected(l.id) ? 'active' : ''}
              title={`${from} → ${to}`}
              onClick={(e) => clickItem(e, l.id, linkIds)}
              onDoubleClick={() => openEditor('link', l.id)}
              onContextMenu={(e) => entityMenu(e, 'link', l.id)}
            >
              <span className="kind-badge link">L</span>
              {l.name}
              <small>
                <Icon
                  name={l.constraints.direction === 'bidirectional' ? 'arrow-left-right' : 'arrow-right'}
                />
              </small>
            </Item>
          ))}
          {!shownLinks.length && <Empty>{f ? 'No match' : 'No links yet'}</Empty>}
        </EntityList>
      </Section>
    </div>
  )
}
