// Module tree of the active document: select, reveal, hide in the focused view, drag to re-parent.
import { useState, type ReactNode } from 'react'
import {
  absolutePosition,
  childModules,
  findView,
  leafHeight,
  LAYOUT_PAD,
  portRows,
  subtreeIds
} from '@/model/project'
import type { Id, Module, Project } from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import { getProject, reparentModule, setHidden, useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { commandItem } from '@/commands'
import { navigate, openModuleView } from '@/actions'
import { addView } from '@/store/project'
import { openView } from '@/shell/controllers'
import { GLOBAL_VIEW } from '@/model/types'

const DRAG = 'application/x-module'

/** Where a module dropped into `parentId` goes: below the existing content. */
function dropPosition(p: Project, id: Id, parentId: Id | null): { x: number; y: number } {
  if (!parentId) return absolutePosition(p, id)
  const parent = p.modules.find((m) => m.id === parentId)
  const top = leafHeight(parent ? portRows(parent) : 0) + LAYOUT_PAD
  const bottom = Math.max(
    top,
    ...childModules(p, parentId)
      .filter((c) => c.id !== id)
      .map((c) => c.layout.y + c.layout.height + LAYOUT_PAD)
  )
  return { x: LAYOUT_PAD, y: bottom }
}

function canDrop(p: Project, dragged: Id, target: Id | null): boolean {
  return dragged !== target && !(target && subtreeIds(p, dragged).has(target))
}

function Node(props: { m: Module; depth: number; filter: string; hidden: Set<Id> }): ReactNode {
  const { m, depth, filter, hidden } = props
  const project = useProjectStore((s) => s.project)
  const selectedIds = useDoc((d) => d.selectedIds)
  const viewId = useDoc((d) => d.activeViewId)
  const [open, setOpen] = useState(true)
  const [over, setOver] = useState(false)
  const children = childModules(project, m.id)
  const matches = (x: Module): boolean =>
    x.name.toLowerCase().includes(filter) || childModules(project, x.id).some(matches)
  if (filter && !matches(m)) return null
  const isHidden = hidden.has(m.id)

  const toggleHidden = (): void => {
    let id = viewId
    if (id === GLOBAL_VIEW) {
      id = addView('Filtered', null)
      openView(id)
    }
    setHidden(id, [m.id], !isHidden)
  }

  return (
    <li>
      <div
        className={`tree-row ${selectedIds.includes(m.id) ? 'active' : ''} ${isHidden ? 'is-hidden' : ''} ${over ? 'drop' : ''}`}
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
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            const ids = activeDoc().selectedIds
            patchDoc({ selectedIds: ids.includes(m.id) ? ids.filter((x) => x !== m.id) : [...ids, m.id] })
          } else navigate({ kind: 'module', id: m.id })
        }}
        onDoubleClick={() => children.length && openModuleView(m.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!activeDoc().selectedIds.includes(m.id)) navigate({ kind: 'module', id: m.id })
          openContextMenu(e, [
            commandItem('view.openModule'),
            commandItem('view.openModuleSplit'),
            { label: isHidden ? 'Show in view' : 'Hide in view', run: toggleHidden },
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
        <span
          className="chevron"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {children.length ? (open || filter ? '▾' : '▸') : ''}
        </span>
        <span className="kind-badge mod" style={m.color ? { background: m.color } : undefined}>
          M
        </span>
        <span className="tree-name">{m.name}</span>
        <small>{m.ports.length ? `${m.ports.length}p` : ''}</small>
        <button
          type="button"
          className="icon eye"
          title={isHidden ? 'Show in view' : 'Hide in view'}
          onClick={(e) => {
            e.stopPropagation()
            toggleHidden()
          }}
        >
          {isHidden ? '◌' : '◉'}
        </button>
      </div>
      {(open || filter) && children.length > 0 && (
        <ul>
          {children.map((c) => (
            <Node key={c.id} m={c} depth={depth + 1} filter={filter} hidden={hidden} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function OutlinePanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const viewId = useDoc((d) => d.activeViewId)
  const [filter, setFilter] = useState('')
  const [over, setOver] = useState(false)
  const view = findView(project, viewId)
  const hidden = new Set(view.hidden)
  const roots = childModules(project, null)
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
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <ul className="tree">
        {roots.map((m) => (
          <Node key={m.id} m={m} depth={0} filter={filter.trim().toLowerCase()} hidden={hidden} />
        ))}
        {!roots.length && <li className="empty muted">No modules. Double-click the canvas to add one.</li>}
      </ul>
      <p className="hint muted">Drag onto a module to nest, onto empty space to move to the top level.</p>
    </div>
  )
}
