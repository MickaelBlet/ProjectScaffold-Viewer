// Views, binaries, dependencies, constants, types, interfaces, modules and links of the active document. Click selects (Ctrl / Shift for several),
// double-click opens an editor tab, right click for more. Arrows move between items, Enter selects.
// Modules: the eye hides one in the focused view, drag one onto another (or the list) to re-parent it.
// Sections can be reordered (drag their header, Alt+Up / Alt+Down) and hidden; kept in the settings.
import {
  Fragment,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { endpointLabel, findView, modulePaths, newId, uniqueName } from '@/model/project'
import { removeBinary } from '@/model/binaries'
import { formatValue } from '@/model/defaults'
import {
  GLOBAL_VIEW,
  type ConstDef,
  type Dependency,
  type Id,
  type ImportedModule,
  type Interface,
  type Module,
  type TypeDef,
  type View
} from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import {
  addConst,
  addInterface,
  addType,
  addView,
  deleteConst,
  deleteItems,
  deleteView,
  getProject,
  renameView,
  update,
  useProjectStore
} from '@/store/project'
import { openContextMenu, select, type MenuItem } from '@/store/ui'
import { setSetting, useSettings } from '@/store/settings'
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
import { dependencyMenu } from './DependencyDetail'
import { childrenByParent, dropModule, matching, MODULE_DRAG, toggleHidden } from './moduleTree'
import { openEditor, openView, revealInspector } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { FoldSection, placed, sectionOrder, StackedSections } from '@/components/FoldSection'
import { onListKeyDown, tabStop } from '@/components/listKeys'

const KIND_BADGE = {
  struct: 'S',
  enum: 'E',
  bitmask: 'B',
  union: 'U',
  exception: 'X',
  alias: 'A',
  primitive: 'P'
} as const

const SECTIONS = [
  'views',
  'binaries',
  'dependencies',
  'constants',
  'types',
  'interfaces',
  'modules',
  'links'
] as const
type SectionId = (typeof SECTIONS)[number]
const SECTION_TITLES: Record<SectionId, string> = {
  views: 'Views',
  binaries: 'Binaries',
  dependencies: 'Dependencies',
  constants: 'Constants',
  types: 'Types',
  interfaces: 'Interfaces',
  modules: 'Modules',
  links: 'Links'
}
const SECTION_DRAG = 'application/x-explorer-section'

const isSection = (s: string): s is SectionId => (SECTIONS as readonly string[]).includes(s)

/** Groups of the content of a dependency, shown in the order of the sections of the same name. */
const DEPENDENCY_GROUPS = ['constants', 'types', 'interfaces', 'modules'] as const
type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number]
const isDependencyGroup = (s: SectionId): s is DependencyGroup =>
  (DEPENDENCY_GROUPS as readonly string[]).includes(s)

/** Row of the Dependencies section; `key` is the id of the entity it shows. */
type DependencyRow = { key: string } & (
  | { kind: 'dependency'; dep: Dependency; open: boolean }
  | { kind: 'group'; dep: Dependency; group: DependencyGroup; count: number; open: boolean }
  | { kind: 'const'; dep: Dependency; c: ConstDef }
  | { kind: 'type'; e: TypeDef }
  | { kind: 'interface'; e: Interface }
  | { kind: 'module'; dep: Dependency; m: ImportedModule }
)

/** Left padding of a row of a tree at `depth`. */
const indent = (depth: number): CSSProperties => ({ paddingLeft: 6 + depth * 14 })

function shownSections(): SectionId[] {
  const { explorerOrder, explorerHidden } = useSettings.getState()
  return sectionOrder(explorerOrder, SECTIONS).filter((id) => !explorerHidden.includes(id))
}

/** Puts section `id` just before or after `target`. */
function placeSection(id: SectionId, target: SectionId, after: boolean): void {
  if (id !== target)
    setSetting(
      'explorerOrder',
      placed(sectionOrder(useSettings.getState().explorerOrder, SECTIONS), id, target, after)
    )
}

/** Moves a section past its shown neighbor above (-1) or below (1). */
function stepSection(id: SectionId, step: -1 | 1): void {
  const shown = shownSections()
  const target = shown[shown.indexOf(id) + step]
  if (target) placeSection(id, target, step > 0)
}

function setSectionHidden(id: SectionId, hide: boolean): void {
  const hidden = useSettings.getState().explorerHidden.filter((s) => s !== id)
  setSetting('explorerHidden', hide ? [...hidden, id] : hidden)
}

function resetSections(): void {
  setSetting('explorerOrder', [])
  setSetting('explorerHidden', [])
}

function showHiddenItems(hidden: SectionId[]): MenuItem[] {
  return [
    ...hidden.map((id) => ({ label: SECTION_TITLES[id], run: () => setSectionHidden(id, false) })),
    'separator',
    { label: 'Show all', run: () => setSetting('explorerHidden', []) }
  ]
}

function hiddenMenu(e: MouseEvent, hidden: SectionId[]): void {
  openContextMenu(e, showHiddenItems(hidden))
}

function sectionMenu(e: MouseEvent, id: SectionId): void {
  e.preventDefault()
  const shown = shownSections()
  const i = shown.indexOf(id)
  const hidden = sectionOrder(useSettings.getState().explorerOrder, SECTIONS).filter(
    (s) => !shown.includes(s)
  )
  openContextMenu(e, [
    { label: 'Move up', keys: 'Alt+Up', disabled: i <= 0, run: () => stepSection(id, -1) },
    { label: 'Move down', keys: 'Alt+Down', disabled: i >= shown.length - 1, run: () => stepSection(id, 1) },
    { label: 'Move to top', disabled: i <= 0, run: () => placeSection(id, shown[0]!, false) },
    {
      label: 'Move to bottom',
      disabled: i >= shown.length - 1,
      run: () => placeSection(id, shown.at(-1)!, true)
    },
    'separator',
    { label: `Hide ${SECTION_TITLES[id]}`, run: () => setSectionHidden(id, true) },
    { label: 'Show hidden sections', disabled: !hidden.length, submenu: showHiddenItems(hidden) },
    'separator',
    { label: 'Reset sections', run: resetSections }
  ])
}

/** Collapsible section; its header drags to reorder, right click for the section menu. */
function Section(props: {
  id: SectionId
  title: string
  count?: number
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <FoldSection
      id={props.id}
      dragType={SECTION_DRAG}
      title={
        <>
          <span className="explorer-title">{props.title}</span>
          {props.count !== undefined && <small>{props.count}</small>}
        </>
      }
      actions={props.actions}
      onPlace={(from, after) => isSection(from) && placeSection(from, props.id, after)}
      onStep={(step) => stepSection(props.id, step)}
      onContextMenu={(e) => sectionMenu(e, props.id)}
      revealOnClick
    >
      {props.children}
    </FoldSection>
  )
}

/** Selectable entities of one kind: arrows move, Enter / Space select as a click does. */
/** Drop target of a dragged module. */
type DropHandlers = {
  onDragOver?: (e: DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: DragEvent) => void
}

function EntityList(
  props: { label: string; multiselectable?: boolean; className?: string; children: ReactNode } & DropHandlers
): ReactNode {
  return (
    <ul
      className={`entity-list ${props.className ?? ''}`}
      role="listbox"
      aria-label={props.label}
      aria-multiselectable={props.multiselectable}
      onKeyDown={onListKeyDown}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
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
  onDragStart?: (e: DragEvent) => void
  children: ReactNode
} & DropHandlers): ReactNode {
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
      draggable={!!props.onDragStart}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
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
  revealInspector()
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

function entityMenu(e: MouseEvent, kind: 'type' | 'interface' | 'link', id: Id): void {
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

function moduleMenu(e: MouseEvent, id: Id, hidden: boolean): void {
  e.preventDefault()
  if (!activeDoc().selectedIds.includes(id)) select({ kind: 'module', id })
  openContextMenu(e, [
    { label: 'Open in a tab', run: () => openEditor('module', id) },
    { label: 'Open to the side', run: () => openEditor('module', id, { split: true }) },
    commandItem('view.openModule'),
    commandItem('view.openModuleSplit'),
    { label: hidden ? 'Show in view' : 'Hide in view', run: () => toggleHidden(id, hidden) },
    'separator',
    commandItem('edit.rename'),
    commandItem('insert.submodule'),
    commandItem('edit.cut'),
    commandItem('edit.copy'),
    commandItem('edit.paste'),
    commandItem('edit.duplicate'),
    'separator',
    commandItem('edit.delete')
  ])
}

/** Accepts a dragged module over a drop target. */
function dragOver(e: DragEvent): boolean {
  if (!e.dataTransfer.types.includes(MODULE_DRAG)) return false
  e.preventDefault()
  e.stopPropagation()
  return true
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

const GLOBAL: View = { id: GLOBAL_VIEW, name: 'Project', rootModuleId: null, hidden: [] }

export function ExplorerPanel(): ReactNode {
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const consts = useProjectStore((s) => s.project.consts)
  const views = useProjectStore((s) => s.project.views)
  const modules = useProjectStore((s) => s.project.modules)
  const links = useProjectStore((s) => s.project.links)
  const dependencies = useProjectStore((s) => s.project.dependencies)
  const binaries = useProjectStore((s) => s.project.binaries)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const selectedIds = useDoc((d) => d.selectedIds)
  // A single selected link is kept in `selection` only (`selectedIds` holds canvas nodes).
  const selectedLink = useDoc((d) => (d.selection?.kind === 'link' ? d.selection.id : null))
  const selectedDependency = useDoc((d) => (d.selection?.kind === 'dependency' ? d.selection.id : null))
  const activeViewId = useDoc((d) => d.activeViewId)
  const [filter, setFilter] = useState('')
  /** Module a dragged module would go into (null: top level). */
  const [dropTarget, setDropTarget] = useState<Id | null | undefined>(undefined)
  const hiddenIds = findView({ views, modules }, activeViewId).hidden
  const savedOrder = useSettings((s) => s.explorerOrder)
  const savedHidden = useSettings((s) => s.explorerHidden)
  const order = useMemo(() => sectionOrder(savedOrder, SECTIONS), [savedOrder])
  const hidden = order.filter((id) => savedHidden.includes(id))
  const f = filter.trim().toLowerCase()
  const match = (name: string): boolean => !f || name.toLowerCase().includes(f)
  const isSelected = (id: Id): boolean => selectedIds.includes(id) || id === selectedLink

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

  const viewItems = [
    ...(match(GLOBAL.name) ? [GLOBAL_VIEW] : []),
    ...views.filter((v) => match(v.name)).map((v) => v.id)
  ]
  const ownTypes = types.filter((t) => !t.dependency)
  const ownInterfaces = interfaces.filter((i) => !i.dependency)
  const shownTypes = ownTypes.filter((t) => match(t.name))
  const shownInterfaces = ownInterfaces.filter((i) => match(i.name))
  const ownConsts = consts.filter((c) => !c.dependency)
  const shownConsts = ownConsts.filter((c) => match(c.name))
  // Dependencies, each with its constants, types, interfaces and placed modules in groups ordered as
  // the sections; a dependency or a group folds (all open while filtering).
  const isOpen = (key: string): boolean => !!f || !collapsed.has(key)
  const dependencyRows: DependencyRow[] = []
  for (const dep of dependencies) {
    const all = match(dep.name)
    const pick = <T,>(list: T[], name: (x: T) => string): T[] =>
      all ? list : list.filter((x) => match(name(x)))
    const groups: { [G in DependencyGroup]: DependencyRow[] } = {
      constants: pick(
        consts.filter((c) => c.dependency === dep.id),
        (c) => c.name
      ).map((c) => ({ kind: 'const', key: c.id, dep, c })),
      types: pick(
        types.filter((t) => t.dependency === dep.id),
        (t) => t.name
      ).map((e) => ({ kind: 'type', key: e.id, e })),
      interfaces: pick(
        interfaces.filter((i) => i.dependency === dep.id),
        (i) => i.name
      ).map((e) => ({ kind: 'interface', key: e.id, e })),
      modules: pick(dep.modules, (m) => m.path).map((m) => ({ kind: 'module', key: m.id, dep, m }))
    }
    const shown = order.filter(isDependencyGroup).filter((g) => groups[g].length)
    if (f && !all && !shown.length) continue
    const open = isOpen(dep.id)
    dependencyRows.push({ kind: 'dependency', key: dep.id, dep, open })
    if (!open) continue
    for (const group of shown) {
      const key = `${dep.id}/${group}`
      const groupOpen = isOpen(key)
      dependencyRows.push({ kind: 'group', key, dep, group, count: groups[group].length, open: groupOpen })
      if (groupOpen) dependencyRows.push(...groups[group])
    }
  }
  const dependencyIds = dependencyRows.map((r) => r.key)
  const toggle = (id: string): void => {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
  }
  // Modules nested under their parent, in project order (all open while filtering).
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
  const viewStop = tabStop(viewItems, (id) => id === activeViewId)
  const typeStop = tabStop(typeIds, isSelected)
  const interfaceStop = tabStop(interfaceIds, isSelected)
  const dependencyStop = tabStop(dependencyIds, isSelected)
  const moduleStop = tabStop(moduleIds, isSelected)
  const binaryStop = tabStop(binaryIds, () => false)
  const constStop = tabStop(
    shownConsts.map((c) => c.id),
    () => false
  )
  const linkStop = tabStop(linkIds, isSelected)

  /** Right expands, Left collapses a dependency or a group, as a module. */
  const foldKeys = (key: string, open: boolean) => (e: KeyboardEvent) => {
    if (f || e.key !== (open ? 'ArrowLeft' : 'ArrowRight')) return
    e.preventDefault()
    toggle(key)
  }
  const chevron = (open: boolean): ReactNode => (
    <span className="chevron" aria-hidden>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} />
    </span>
  )
  const leaf = <span className="chevron" aria-hidden />
  const dependencyRow = (r: DependencyRow): ReactNode => {
    const stop = r.key === dependencyStop
    switch (r.kind) {
      case 'dependency':
        return (
          <Item
            key={r.key}
            tabStop={stop}
            selected={selectedDependency === r.dep.id}
            className={`dependency ${selectedDependency === r.dep.id ? 'active' : ''}`}
            title={`${r.dep.file}${r.dep.indirect ? ' (used by another dependency)' : ''}${r.dep.uses.length ? `\nUses ${r.dep.uses.join(', ')}` : ''}`}
            style={indent(0)}
            onClick={() => {
              revealInspector()
              select({ kind: 'dependency', id: r.dep.id })
            }}
            onKeyDown={foldKeys(r.key, r.open)}
            onDoubleClick={() => openImportSource(r.dep.file)}
            onContextMenu={(e) => dependencyMenu(e, r.dep)}
          >
            <span
              className="chevron"
              aria-hidden
              onClick={(e) => {
                e.stopPropagation()
                toggle(r.key)
              }}
            >
              <Icon name={r.open ? 'chevron-down' : 'chevron-right'} />
            </span>
            <span className="kind-badge dependency">D</span>
            {r.dep.name}
            <small>{r.dep.indirect ? 'indirect' : r.dep.file}</small>
          </Item>
        )
      case 'group':
        return (
          <Item
            key={r.key}
            tabStop={stop}
            selected={false}
            className="dependency-group"
            title={r.group === 'modules' ? 'Its modules placed on the canvas' : undefined}
            style={indent(1)}
            onClick={() => toggle(r.key)}
            onKeyDown={foldKeys(r.key, r.open)}
            onContextMenu={(e) => dependencyMenu(e, r.dep)}
          >
            {chevron(r.open)}
            {SECTION_TITLES[r.group]}
            <small>{r.count}</small>
          </Item>
        )
      case 'const':
        return (
          <Item
            key={r.key}
            tabStop={stop}
            selected={false}
            title={`${r.c.description ? `${r.c.description}\n` : ''}Shown with its dependency in the Inspector.`}
            style={indent(2)}
            onClick={() => {
              revealInspector()
              showDependency(r.dep.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              openContextMenu(e, [
                { label: 'Show its dependency', run: () => showDependency(r.dep.id) },
                { label: `Open ${r.dep.file}`, run: () => openImportSource(r.dep.file) }
              ])
            }}
          >
            {leaf}
            <span className="kind-badge const">C</span>
            {r.c.name}
            <small>{formatValue(r.c.value)}</small>
          </Item>
        )
      case 'type':
      case 'interface': {
        const { kind, e } = r
        return (
          <Item
            key={r.key}
            tabStop={stop}
            selected={isSelected(e.id)}
            className={isSelected(e.id) ? 'active' : ''}
            style={indent(2)}
            onClick={(ev) => clickItem(ev, e.id, dependencyIds)}
            onDoubleClick={() => openEditor(kind, e.id)}
            onContextMenu={(ev) => entityMenu(ev, kind, e.id)}
          >
            {leaf}
            {r.kind === 'interface' ? (
              <span className="kind-badge interface">I</span>
            ) : (
              <span className={`kind-badge ${r.e.kind}`} title={r.e.kind}>
                {KIND_BADGE[r.e.kind]}
              </span>
            )}
            {e.name}
            {r.kind === 'interface' && <small>{r.e.messages.length} msg</small>}
          </Item>
        )
      }
      case 'module': {
        const { dep, m } = r
        return (
          <Item
            key={r.key}
            tabStop={stop}
            selected={isSelected(m.id)}
            className={isSelected(m.id) ? 'active' : ''}
            title={`${m.path}, placed on the canvas`}
            style={indent(2)}
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
            {leaf}
            <span className="kind-badge mod">M</span>
            {m.path}
            <small>{m.ports.length ? `${m.ports.length}p` : ''}</small>
          </Item>
        )
      }
    }
  }

  const shownSections = order.filter((id) => !savedHidden.includes(id))
  const sections: Record<SectionId, ReactNode> = {
    views: (
      <Section
        id="views"
        title="Views"
        count={views.length + 1}
        actions={
          <button type="button" className="icon" title="New view" onClick={newView}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Views">
          {viewItems.map((id) => {
            const v = id === GLOBAL_VIEW ? GLOBAL : views.find((v) => v.id === id)!
            const root = modules.find((m) => m.id === v.rootModuleId)
            return (
              <Item
                key={v.id}
                selected={v.id === activeViewId}
                tabStop={v.id === viewStop}
                className={v.id === activeViewId ? 'current' : ''}
                onClick={() => {
                  openView(v.id)
                  if (v.id !== GLOBAL_VIEW) return
                  revealInspector()
                  select({ kind: 'project' })
                }}
                onContextMenu={(e) => viewMenu(e, v)}
              >
                <span className={`kind-badge view ${root ? 'drill' : ''}`}>
                  <Icon name={root ? 'expand' : 'view'} />
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
    ),

    dependencies: (
      <Section
        id="dependencies"
        title="Dependencies"
        count={dependencies.length}
        actions={
          <button type="button" className="icon" title="Add dependency…" onClick={() => pickDependency()}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Dependencies" multiselectable>
          {dependencyRows.map(dependencyRow)}
          {!dependencyRows.length && (
            <Empty>{dependencies.length ? 'No match' : 'No dependencies: Insert › Add dependency…'}</Empty>
          )}
        </EntityList>
      </Section>
    ),

    binaries: (
      <Section
        id="binaries"
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
                onClick={() => {
                  patchDoc({
                    selectedIds: inside.map((m) => m.id),
                    selection: inside.length ? { kind: 'module', id: inside[0]!.id } : null
                  })
                  if (inside.length) revealInspector()
                }}
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
    ),

    types: (
      <Section
        id="types"
        title="Types"
        count={ownTypes.length}
        actions={(['struct', 'enum', 'bitmask', 'union', 'exception', 'alias', 'primitive'] as const).map(
          (k) => (
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
          )
        )}
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
    ),

    interfaces: (
      <Section
        id="interfaces"
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
    ),

    constants: (
      <Section
        id="constants"
        title="Constants"
        count={ownConsts.length}
        actions={
          <button
            type="button"
            className="icon"
            title="New constant"
            onClick={() => {
              addConst()
              select({ kind: 'project' })
            }}
          >
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList label="Constants">
          {shownConsts.map((c) => (
            <Item
              key={c.id}
              selected={false}
              tabStop={c.id === constStop}
              title={`${c.description ? `${c.description}\n` : ''}Edited in the project inspector.`}
              onClick={() => {
                select({ kind: 'project' })
                revealInspector()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openContextMenu(e, [
                  { label: 'Edit constants', run: () => select({ kind: 'project' }) },
                  'separator',
                  { label: 'Delete constant', danger: true, run: () => deleteConst(c.id) }
                ])
              }}
            >
              <span className="kind-badge const">C</span>
              {c.name}
              <small>{formatValue(c.value)}</small>
            </Item>
          ))}
          {!shownConsts.length && <Empty>{f ? 'No match' : 'No constants yet'}</Empty>}
        </EntityList>
      </Section>
    ),

    modules: (
      <Section
        id="modules"
        title="Modules"
        count={modules.length}
        actions={
          <button type="button" className="icon" title="New module" onClick={() => addModuleAt()}>
            <Icon name="plus" />
          </button>
        }
      >
        <EntityList
          label="Modules"
          multiselectable
          className={dropTarget === null ? 'drop' : ''}
          onDragOver={(e) => dragOver(e) && setDropTarget(null)}
          onDragLeave={() => setDropTarget(undefined)}
          onDrop={(e) => {
            setDropTarget(undefined)
            dropModule(e.dataTransfer.getData(MODULE_DRAG), null)
          }}
        >
          {shownModules.map(({ m, depth, parent, open }) => (
            <Item
              key={m.id}
              selected={isSelected(m.id)}
              tabStop={m.id === moduleStop}
              className={`${isSelected(m.id) ? 'active' : ''} ${hiddenIds.includes(m.id) ? 'is-hidden' : ''} ${dropTarget === m.id ? 'drop' : ''}`}
              title={paths.get(m.id)}
              style={indent(depth)}
              onClick={(e) => clickItem(e, m.id, moduleIds)}
              onDragStart={(e) => e.dataTransfer.setData(MODULE_DRAG, m.id)}
              onDragOver={(e) => dragOver(e) && setDropTarget(m.id)}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDropTarget(undefined)
                dropModule(e.dataTransfer.getData(MODULE_DRAG), m.id)
              }}
              onKeyDown={(e) => {
                // Right expands, Left collapses.
                if (!parent || moduleMatches || e.key !== (open ? 'ArrowLeft' : 'ArrowRight')) return
                e.preventDefault()
                toggle(m.id)
              }}
              onDoubleClick={() => openEditor('module', m.id)}
              onContextMenu={(e) => moduleMenu(e, m.id, hiddenIds.includes(m.id))}
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
              <span className="tree-name">{m.name}</span>
              <small>{m.ports.length ? `${m.ports.length}p` : ''}</small>
              <button
                type="button"
                className="icon eye"
                tabIndex={-1}
                title={hiddenIds.includes(m.id) ? 'Show in view' : 'Hide in view'}
                aria-label={`${hiddenIds.includes(m.id) ? 'Show' : 'Hide'} ${m.name} in view`}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleHidden(m.id, hiddenIds.includes(m.id))
                }}
              >
                <Icon name={hiddenIds.includes(m.id) ? 'eye-off' : 'eye'} />
              </button>
            </Item>
          ))}
          {!shownModules.length && <Empty>{f ? 'No match' : 'No modules yet'}</Empty>}
        </EntityList>
      </Section>
    ),

    links: (
      <Section id="links" title="Links" count={links.length}>
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
    )
  }

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
      <StackedSections>
        {shownSections.map((id) => (
          <Fragment key={id}>{sections[id]}</Fragment>
        ))}
        {hidden.length > 0 && (
          <button type="button" className="explorer-hidden" onClick={(e) => hiddenMenu(e, hidden)}>
            {hidden.length} hidden {hidden.length > 1 ? 'sections' : 'section'}
          </button>
        )}
      </StackedSections>
    </div>
  )
}
