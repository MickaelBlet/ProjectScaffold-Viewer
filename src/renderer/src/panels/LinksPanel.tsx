// Every link of the project at a glance: filter, select, open.
import { useMemo, useState, type ReactNode } from 'react'
import { findPort, modulePath } from '@/model/project'
import type { Endpoint, Project } from '@/model/types'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { openContextMenu } from '@/store/ui'
import { commandItem } from '@/commands'
import { navigate } from '@/actions'
import { openEditor } from '@/shell/controllers'

interface Row {
  id: string
  name: string
  from: string
  to: string
  iface: string
  bidirectional: boolean
}

const endpoint = (p: Project, e: Endpoint): string =>
  `${modulePath(p, e.moduleId)}:${findPort(p, e.moduleId, e.portId)?.name ?? '?'}`

function rows(p: Project): Row[] {
  return p.links
    .map((l) => {
      const port = findPort(p, l.from.moduleId, l.from.portId)
      return {
        id: l.id,
        name: l.name,
        from: endpoint(p, l.from),
        to: endpoint(p, l.to),
        iface: p.interfaces.find((i) => i.id === port?.interfaceId)?.name ?? '',
        bidirectional: l.constraints.direction === 'bidirectional'
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function LinksPanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const selection = useDoc((d) => d.selection)
  const [filter, setFilter] = useState('')
  const all = useMemo(() => rows(project), [project])
  const f = filter.trim().toLowerCase()
  const shown = f
    ? all.filter((r) => [r.name, r.from, r.to, r.iface].some((s) => s.toLowerCase().includes(f)))
    : all
  const selectedId = selection?.kind === 'link' ? selection.id : null

  return (
    <div className="links-panel">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Filter links, modules, ports, interfaces"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {f && (
        <p className="muted count">
          {shown.length} / {all.length} links
        </p>
      )}
      <ul className="results">
        {shown.map((r) => (
          <li
            key={r.id}
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
              {r.from} {r.bidirectional ? '↔' : '→'} {r.to}
            </span>
          </li>
        ))}
        {!all.length && <li className="empty muted">No links. Drag from a port to another to add one.</li>}
      </ul>
    </div>
  )
}
