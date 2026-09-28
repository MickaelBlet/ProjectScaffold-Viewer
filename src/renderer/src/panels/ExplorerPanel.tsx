// Views, types, interfaces, modules and links of the active document. Click selects (Ctrl / Shift for several),
// double-click opens an editor tab, right click for more.
import { useState, type MouseEvent, type ReactNode } from 'react'
import { findPort, findView, modulePath } from '@/model/project'
import { GLOBAL_VIEW, type Id } from '@/model/types'
import { activeDoc, patchDoc, useDoc } from '@/store/documents'
import {
  addInterface,
  addType,
  addView,
  deleteView,
  getProject,
  renameView,
  useProjectStore
} from '@/store/project'
import { openContextMenu, select } from '@/store/ui'
import { commandItem } from '@/commands'
import { addModuleAt, navigate, newView, selectionOf } from '@/actions'
import { openEditor, openView } from '@/shell/controllers'
import { Icon } from '@/components/Icon'

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
        <span className="chevron">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </span>
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

export function ExplorerPanel(): ReactNode {
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const views = useProjectStore((s) => s.project.views)
  const project = useProjectStore((s) => s.project)
  const { modules, links } = project
  const selectedIds = useDoc((d) => d.selectedIds)
  const activeViewId = useDoc((d) => d.activeViewId)
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const match = (name: string): boolean => !f || name.toLowerCase().includes(f)
  const shownTypes = types.filter((t) => match(t.name))
  const shownInterfaces = interfaces.filter((i) => match(i.name))
  const typeIds = shownTypes.map((t) => t.id)
  const interfaceIds = shownInterfaces.map((i) => i.id)
  const shownModules = modules
    .map((m) => ({ m, path: modulePath(project, m.id) }))
    .filter((x) => match(x.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const moduleIds = shownModules.map((x) => x.m.id)
  const endpoint = (e: (typeof links)[number]['from']): string =>
    `${modulePath(project, e.moduleId)}:${findPort(project, e.moduleId, e.portId)?.name ?? '?'}`
  const shownLinks = links
    .map((l) => ({ l, from: endpoint(l.from), to: endpoint(l.to) }))
    .filter((x) => match(x.l.name) || match(x.from) || match(x.to))
    .sort((a, b) => a.l.name.localeCompare(b.l.name))
  const linkIds = shownLinks.map((x) => x.l.id)
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
            <Icon name="plus" />
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
                  <span className={`kind-badge view ${root ? 'drill' : ''}`}>
                    {root ? <Icon name="expand" /> : 'V'}
                  </span>
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
            <Icon name="plus" />
            {KIND_BADGE[k]}
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
            <Icon name="plus" />
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

      <Section
        title="Modules"
        count={modules.length}
        actions={
          <button type="button" className="icon" title="New module" onClick={() => addModuleAt()}>
            <Icon name="plus" />
          </button>
        }
      >
        <ul className="entity-list">
          {shownModules.map(({ m, path }) => (
            <li
              key={m.id}
              className={selectedIds.includes(m.id) ? 'active' : ''}
              title={path}
              onClick={(e) => clickItem(e, m.id, moduleIds)}
              onDoubleClick={() => openEditor('module', m.id)}
              onContextMenu={(e) => entityMenu(e, 'module', m.id)}
            >
              <span className="kind-badge mod">M</span>
              {m.name}
              <small>{path.slice(0, -m.name.length - 1)}</small>
            </li>
          ))}
          {!shownModules.length && <li className="empty">{f ? 'No match' : 'No modules yet'}</li>}
        </ul>
      </Section>

      <Section title="Links" count={links.length}>
        <ul className="entity-list">
          {shownLinks.map(({ l, from, to }) => (
            <li
              key={l.id}
              className={selectedIds.includes(l.id) ? 'active' : ''}
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
            </li>
          ))}
          {!shownLinks.length && <li className="empty">{f ? 'No match' : 'No links yet'}</li>}
        </ul>
      </Section>
    </div>
  )
}
