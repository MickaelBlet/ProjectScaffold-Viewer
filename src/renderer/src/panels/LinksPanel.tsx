// Every link of the project at a glance: filter, select, open.
import { useMemo, useState, type ReactNode } from 'react'
import { endpointLabel, findPort, modulePaths } from '@/model/project'
import type { Project } from '@/model/types'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { commandItem } from '@/commands'
import { navigate } from '@/actions'
import { openEditor } from '@/shell/controllers'
import { Icon } from '@/components/Icon'
import { onListKeyDown, tabStop } from '@/components/listKeys'

interface Row {
  id: string
  name: string
  from: string
  to: string
  iface: string
  bidirectional: boolean
}

function rows(p: Pick<Project, 'links' | 'modules' | 'dependencies' | 'interfaces'>): Row[] {
  const paths = modulePaths(p)
  return p.links
    .map((l) => {
      const port = findPort(p, l.from.moduleId, l.from.portId)
      return {
        id: l.id,
        name: l.name,
        from: endpointLabel(p, paths, l.from),
        to: endpointLabel(p, paths, l.to),
        iface: p.interfaces.find((i) => i.id === port?.interfaceId)?.name ?? '',
        bidirectional: l.constraints.direction === 'bidirectional'
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function LinksPanel(): ReactNode {
  const links = useProjectStore((s) => s.project.links)
  const modules = useProjectStore((s) => s.project.modules)
  const dependencies = useProjectStore((s) => s.project.dependencies)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const selection = useDoc((d) => d.selection)
  const [filter, setFilter] = useState('')
  // Rebuilt when links, modules or interfaces change, not on every edit.
  const all = useMemo(
    () => rows({ links, modules, dependencies, interfaces }),
    [links, modules, dependencies, interfaces]
  )
  const f = filter.trim().toLowerCase()
  const shown = f
    ? all.filter((r) => [r.name, r.from, r.to, r.iface].some((s) => s.toLowerCase().includes(f)))
    : all
  const selectedId = selection?.kind === 'link' ? selection.id : null
  const stop = tabStop(
    shown.map((r) => r.id),
    (id) => id === selectedId
  )

  return (
    <div className="links-panel">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter links, modules, ports, interfaces"
          aria-label="Filter links"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {f && (
        <p className="muted count">
          {shown.length} / {all.length} links
        </p>
      )}
      <ul className="results" role="listbox" aria-label="Links" onKeyDown={onListKeyDown}>
        {shown.map((r) => (
          <li
            key={r.id}
            data-item
            role="option"
            aria-selected={r.id === selectedId}
            tabIndex={r.id === stop ? 0 : -1}
            className={r.id === selectedId ? 'active' : ''}
            onClick={() => navigate({ kind: 'link', id: r.id })}
            onDoubleClick={() => openEditor('link', r.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              navigate({ kind: 'link', id: r.id })
              openContextMenu(e, [
                { label: 'Open editor', run: () => openEditor('link', r.id) },
                'separator',
                commandItem('edit.delete')
              ])
            }}
          >
            <span className="kind-badge link">L</span>
            <span className="result-label">{r.name}</span>
            {r.iface && <small>{r.iface}</small>}
            <span className="result-text">
              {r.from} <Icon name={r.bidirectional ? 'arrow-left-right' : 'arrow-right'} /> {r.to}
            </span>
          </li>
        ))}
        {!all.length && (
          <li className="empty muted" role="presentation">
            No links. Drag from a port to another to add one.
          </li>
        )}
      </ul>
    </div>
  )
}
