// Module tree of the active document: select, reveal, hide in the focused view, drag to re-parent.
// Keyboard: arrows move (Left / Right collapse and expand), Enter selects.
import { useMemo, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { absolutePosition, belowContent, findView, LAYOUT_PAD, subtreeIds } from '@/model/project'
import { GLOBAL_VIEW, type Id, type Module, type Project } from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import { addView, getProject, reparentModule, setHidden, useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { commandItem } from '@/commands'
import { navigate, openModuleView } from '@/actions'
import { openView } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'

const DRAG = 'application/x-module'

/** Where a module dropped into `parentId` goes: below the existing content. */
function dropPosition(p: Project, id: Id, parentId: Id | null): { x: number; y: number } {
  if (!parentId) return absolutePosition(p, id)
  return { x: LAYOUT_PAD, y: belowContent(p, parentId, id) }
}

function canDrop(p: Project, dragged: Id, target: Id | null): boolean {
  return dragged !== target && !(target && subtreeIds(p, dragged).has(target))
}

/** Hide or show a module in the focused view (a stored copy of the global view is made first). */
function toggleHidden(id: Id, hidden: boolean): void {
  let viewId = activeDoc().activeViewId
  if (viewId === GLOBAL_VIEW) {
    viewId = addView('Filtered', null)
    openView(viewId)
  }
  setHidden(viewId, [id], !hidden)
}

/** Modules by parent (null: top level), in project order. */
export function childrenByParent(modules: Module[]): Map<Id | null, Module[]> {
  const map = new Map<Id | null, Module[]>()
  for (const m of modules) map.set(m.parentId, [...(map.get(m.parentId) ?? []), m])
  return map
}

/** Modules passing `test`, with their ancestors. */
export function matching(children: Map<Id | null, Module[]>, test: (m: Module) => boolean): Set<Id> {
  const shown = new Set<Id>()
  const visit = (m: Module): boolean => {
    const inside = (children.get(m.id) ?? []).map(visit).some(Boolean)
    const match = inside || test(m)
    if (match) shown.add(m.id)
    return match
  }
  for (const m of children.get(null) ?? []) visit(m)
  return shown
}

interface TreeState {
  children: Map<Id | null, Module[]>
  /** Modules shown under the filter; null without filter. */
  shown: Set<Id> | null
  collapsed: ReadonlySet<Id>
  setOpen: (id: Id, open: boolean) => void
  hidden: Set<Id>
  selected: Set<Id>
  tabStop: Id | undefined
}

/** Events of the item itself, not of the items nested in it. */
const own = (e: SyntheticEvent): boolean => (e.target as Element).closest('[data-item]') === e.currentTarget

function TreeNode({ m, depth, tree }: { m: Module; depth: number; tree: TreeState }): ReactNode {
  const [over, setOver] = useState(false)
  if (tree.shown && !tree.shown.has(m.id)) return null
  const children = tree.children.get(m.id) ?? []
  const open = !!tree.shown || !tree.collapsed.has(m.id)
  const isHidden = tree.hidden.has(m.id)
  const selected = tree.selected.has(m.id)

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (!own(e) || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
    e.preventDefault()
    if (e.key === 'ArrowRight' && children.length && !open) tree.setOpen(m.id, true)
    else if (e.key === 'ArrowLeft' && children.length && open && !tree.shown) tree.setOpen(m.id, false)
    else if (e.key === 'ArrowLeft')
      e.currentTarget.parentElement?.closest<HTMLElement>('[data-item]')?.focus()
  }

  return (
    <li
      data-item
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={children.length ? open : undefined}
      tabIndex={m.id === tree.tabStop ? 0 : -1}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (!own(e)) return
        if (e.ctrlKey || e.metaKey) {
          const ids = activeDoc().selectedIds
          patchDoc({ selectedIds: ids.includes(m.id) ? ids.filter((x) => x !== m.id) : [...ids, m.id] })
        } else navigate({ kind: 'module', id: m.id })
      }}
      onDoubleClick={(e) => own(e) && children.length && openModuleView(m.id)}
      onContextMenu={(e) => {
        if (!own(e)) return
        e.preventDefault()
        if (!activeDoc().selectedIds.includes(m.id)) navigate({ kind: 'module', id: m.id })
        openContextMenu(e, [
          commandItem('view.openModule'),
          commandItem('view.openModuleSplit'),
          { label: isHidden ? 'Show in view' : 'Hide in view', run: () => toggleHidden(m.id, isHidden) },
          'separator',
          commandItem('edit.rename'),
          commandItem('insert.submodule'),
          commandItem('edit.copy'),
          commandItem('edit.duplicate'),
          'separator',
          commandItem('edit.delete')
        ])
      }}
    >
      <div
        className={`tree-row ${selected ? 'active' : ''} ${isHidden ? 'is-hidden' : ''} ${over ? 'drop' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(DRAG, m.id)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG)) return
          e.preventDefault()
          e.stopPropagation()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          const id = e.dataTransfer.getData(DRAG)
          const p = getProject()
          if (!id || !canDrop(p, id, m.id)) return
          const pos = dropPosition(p, id, m.id)
          reparentModule(id, m.id, pos.x, pos.y)
        }}
      >
        <span
          className="chevron"
          aria-hidden
          onClick={(e) => {
            e.stopPropagation()
            tree.setOpen(m.id, !open)
          }}
        >
          {children.length > 0 && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
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
          title={isHidden ? 'Show in view' : 'Hide in view'}
          aria-label={`${isHidden ? 'Show' : 'Hide'} ${m.name} in view`}
          onClick={(e) => {
            e.stopPropagation()
            toggleHidden(m.id, isHidden)
          }}
        >
          <Icon name={isHidden ? 'eye-off' : 'eye'} />
        </button>
      </div>
      {open && children.length > 0 && (
        <ul role="group">
          {children.map((c) => (
            <TreeNode key={c.id} m={c} depth={depth + 1} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function OutlinePanel(): ReactNode {
  const modules = useProjectStore((s) => s.project.modules)
  const views = useProjectStore((s) => s.project.views)
  const viewId = useDoc((d) => d.activeViewId)
  const selectedIds = useDoc((d) => d.selectedIds)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(new Set())
  const [over, setOver] = useState(false)
  const f = filter.trim().toLowerCase()
  const children = useMemo(() => childrenByParent(modules), [modules])
  const shown = useMemo(
    () => (f ? matching(children, (m) => m.name.toLowerCase().includes(f)) : null),
    [children, f]
  )
  const hiddenIds = findView({ views }, viewId).hidden
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const roots = children.get(null) ?? []

  // Items in display order, for the one in the tab order.
  const visible: Id[] = []
  const walk = (list: Module[]): void => {
    for (const m of list) {
      if (shown && !shown.has(m.id)) continue
      visible.push(m.id)
      if (shown || !collapsed.has(m.id)) walk(children.get(m.id) ?? [])
    }
  }
  walk(roots)

  const tree: TreeState = {
    children,
    shown,
    collapsed,
    setOpen: (id, open) =>
      setCollapsed((s) => {
        const next = new Set(s)
        if (open) next.delete(id)
        else next.add(id)
        return next
      }),
    hidden,
    selected,
    tabStop: tabStop(visible, (id) => selected.has(id))
  }

  return (
    <div
      className={`outline ${over ? 'drop' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer.getData(DRAG)
        const p = getProject()
        if (!id) return
        const pos = dropPosition(p, id, null)
        reparentModule(id, null, pos.x, pos.y)
      }}
    >
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter modules"
          aria-label="Filter modules"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <ul className="tree" role="tree" aria-label="Modules" aria-multiselectable onKeyDown={onListKeyDown}>
        {roots.map((m) => (
          <TreeNode key={m.id} m={m} depth={0} tree={tree} />
        ))}
        {!roots.length && (
          <li className="empty muted" role="presentation">
            No modules. Right-click the canvas to add one.
          </li>
        )}
      </ul>
      <p className="hint muted">Drag onto a module to nest, onto empty space to move to the top level.</p>
    </div>
  )
}
