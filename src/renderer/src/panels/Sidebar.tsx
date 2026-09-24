import type { ReactNode } from 'react'
import { addInterface, addType, useProjectStore } from '@/store/project'
import { select, useUiStore } from '@/store/ui'

const KIND_BADGE = { struct: 'S', enum: 'E', alias: 'A' } as const

export function Sidebar(): ReactNode {
  const tab = useUiStore((s) => s.sidebarTab)
  const selection = useUiStore((s) => s.selection)
  const types = useProjectStore((s) => s.project.types)
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const isSelected = (kind: string, id: string): boolean =>
    selection !== null && selection.kind === kind && 'id' in selection && selection.id === id

  return (
    <aside className="sidebar">
      <nav className="tabs">
        {(['types', 'interfaces'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'active' : ''}
            onClick={() => useUiStore.setState({ sidebarTab: t })}
          >
            {t === 'types' ? `Types (${types.length})` : `Interfaces (${interfaces.length})`}
          </button>
        ))}
      </nav>
      {tab === 'types' ? (
        <>
          <div className="sidebar-actions">
            {(['struct', 'enum', 'alias'] as const).map((k) => (
              <button key={k} type="button" onClick={() => select({ kind: 'type', id: addType(k) })}>
                + {k}
              </button>
            ))}
          </div>
          <ul className="entity-list">
            {types.map((t) => (
              <li
                key={t.id}
                className={isSelected('type', t.id) ? 'active' : ''}
                onClick={() => select({ kind: 'type', id: t.id })}
              >
                <span className={`kind-badge ${t.kind}`} title={t.kind}>
                  {KIND_BADGE[t.kind]}
                </span>
                {t.name}
              </li>
            ))}
            {!types.length && <li className="empty">No types yet</li>}
          </ul>
        </>
      ) : (
        <>
          <div className="sidebar-actions">
            <button type="button" onClick={() => select({ kind: 'interface', id: addInterface() })}>
              + interface
            </button>
          </div>
          <ul className="entity-list">
            {interfaces.map((i) => (
              <li
                key={i.id}
                className={isSelected('interface', i.id) ? 'active' : ''}
                onClick={() => select({ kind: 'interface', id: i.id })}
              >
                <span className="kind-badge interface">I</span>
                {i.name}
                <small>{i.messages.length} msg</small>
              </li>
            ))}
            {!interfaces.length && <li className="empty">No interfaces yet</li>}
          </ul>
        </>
      )}
    </aside>
  )
}
