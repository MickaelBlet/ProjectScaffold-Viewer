// Views, types and interfaces of the active document. Click selects (Ctrl / Shift for several),
// double-click opens an editor tab, right click for more.
import { useState, type MouseEvent, type ReactNode } from 'react'
import { findView } from '@/model/project'
import { GLOBAL_VIEW, type Id } from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import { addInterface, addType, addView, deleteView, renameView, useProjectStore } from '@/store/project'
import { openContextMenu, select, type Selection } from '@/store/ui'
import { commandItem } from '@/commands'
import { newView, selectionOf } from '@/actions'
import { openEditor, openView } from '@/shell/controllers'
import { getProject } from '@/store/project'

const KIND_BADGE = { struct: 'S', enum: 'E', alias: 'A' } as const

function Section(props: {
  title: string
  count?: number
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(true)
  return (
    <section className={`explorer-section ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="explorer-title">{props.title}</span>
        {props.count !== undefined && <small>{props.count}</small>}
        <span className="explorer-actions" onClick={(e) => e.stopPropagation()}>
          {props.actions}
        </span>
      </header>
      {open && props.children}
    </section>
  )
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
  select(selectionOf(getProject(), id) as Selection)
}

function entityMenu(e: MouseEvent, kind: 'type' | 'interface', id: Id): void {
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

export function ExplorerPanel(): ReactNode {
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const views = useProjectStore((s) => s.project.views)
  const modules = useProjectStore((s) => s.project.modules)
  const selectedIds = useDoc((d) => d.selectedIds)
  const activeViewId = useDoc((d) => d.activeViewId)
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const match = (name: string): boolean => !f || name.toLowerCase().includes(f)
  const shownTypes = types.filter((t) => match(t.name))
  const shownInterfaces = interfaces.filter((i) => match(i.name))
  const typeIds = shownTypes.map((t) => t.id)
  const interfaceIds = shownInterfaces.map((i) => i.id)
  const allViews = [{ id: GLOBAL_VIEW, name: 'Global', rootModuleId: null, hidden: [] }, ...views]

  return (
    <div className="explorer">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <Section
        title="Views"
        count={allViews.length}
        actions={
          <button type="button" className="icon" title="New view" onClick={newView}>
            +
          </button>
        }
      >
        <ul className="entity-list">
          {allViews
            .filter((v) => match(v.name))
            .map((v) => {
              const root = modules.find((m) => m.id === v.rootModuleId)
              return (
                <li
                  key={v.id}
                  className={v.id === activeViewId ? 'current' : ''}
                  onClick={() => openView(v.id)}
                  onContextMenu={(e) => {
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
                  }}
                >
                  <span className={`kind-badge view ${root ? 'drill' : ''}`}>{root ? '⤢' : 'V'}</span>
                  {v.name}
                  <small>
                    {root ? root.name : ''}
                    {v.hidden.length ? ` −${v.hidden.length}` : ''}
                  </small>
                </li>
              )
            })}
        </ul>
      </Section>

      <Section
        title="Types"
        count={types.length}
        actions={(['struct', 'enum', 'alias'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="icon"
            title={`New ${k}`}
            onClick={() => select({ kind: 'type', id: addType(k) })}
          >
            +{KIND_BADGE[k]}
          </button>
        ))}
      >
        <ul className="entity-list">
          {shownTypes.map((t) => (
            <li
              key={t.id}
              className={selectedIds.includes(t.id) ? 'active' : ''}
              onClick={(e) => clickItem(e, t.id, typeIds)}
              onDoubleClick={() => openEditor('type', t.id)}
              onContextMenu={(e) => entityMenu(e, 'type', t.id)}
            >
              <span className={`kind-badge ${t.kind}`} title={t.kind}>
                {KIND_BADGE[t.kind]}
              </span>
              {t.name}
            </li>
          ))}
          {!shownTypes.length && <li className="empty">{f ? 'No match' : 'No types yet'}</li>}
        </ul>
      </Section>

      <Section
        title="Interfaces"
        count={interfaces.length}
        actions={
          <button
            type="button"
            className="icon"
            title="New interface"
            onClick={() => select({ kind: 'interface', id: addInterface() })}
          >
            +
          </button>
        }
      >
        <ul className="entity-list">
          {shownInterfaces.map((i) => (
            <li
              key={i.id}
              className={selectedIds.includes(i.id) ? 'active' : ''}
              onClick={(e) => clickItem(e, i.id, interfaceIds)}
              onDoubleClick={() => openEditor('interface', i.id)}
              onContextMenu={(e) => entityMenu(e, 'interface', i.id)}
            >
              <span className="kind-badge interface">I</span>
              {i.name}
              <small>{i.messages.length} msg</small>
            </li>
          ))}
          {!shownInterfaces.length && <li className="empty">{f ? 'No match' : 'No interfaces yet'}</li>}
        </ul>
      </Section>
    </div>
  )
}
