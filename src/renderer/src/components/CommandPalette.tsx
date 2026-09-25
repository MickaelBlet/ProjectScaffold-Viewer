// Ctrl+Shift+P: commands ('>' prefix). Ctrl+P: go to a module, type, interface, link or view.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { commands, keyLabel, runCommand } from '@/commands'
import { fuzzyFilter } from '@/model/fuzzy'
import { modulePath } from '@/model/project'
import { GLOBAL_VIEW } from '@/model/types'
import { getProject } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { navigate, openModuleView } from '@/actions'
import { openView } from '@/shell/controllers'

interface Entry {
  key: string
  label: string
  detail?: string
  keys?: string
  kind: string
  run: () => void
}

const RECENT_KEY = 'project-scaffold:recent-commands'

function recentCommands(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, 8))
    )
  } catch {
    // Not remembered.
  }
}

function commandEntries(): Entry[] {
  const recent = recentCommands()
  const list = commands
    .filter((c) => !c.hidden && (c.enabled?.() ?? true))
    .map((c) => ({
      key: c.id,
      label: `${c.category}: ${c.title}`,
      keys: c.keys?.[0] ? keyLabel(c.keys[0]) : undefined,
      kind: c.checked ? (c.checked() ? '✓' : '') : '',
      run: () => {
        remember(c.id)
        runCommand(c.id)
      }
    }))
  // Recently used first when there is no query.
  return list.sort((a, b) => {
    const ra = recent.indexOf(a.key)
    const rb = recent.indexOf(b.key)
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
  })
}

function entityEntries(): Entry[] {
  const p = getProject()
  return [
    ...p.modules.map((m) => ({
      key: m.id,
      label: modulePath(p, m.id),
      detail: `module · ${m.ports.length} ports`,
      kind: 'M',
      run: () => navigate({ kind: 'module', id: m.id })
    })),
    ...p.types.map((t) => ({
      key: t.id,
      label: t.name,
      detail: t.kind,
      kind: 'T',
      run: () => navigate({ kind: 'type', id: t.id })
    })),
    ...p.interfaces.map((i) => ({
      key: i.id,
      label: i.name,
      detail: `interface · ${i.messages.length} messages`,
      kind: 'I',
      run: () => navigate({ kind: 'interface', id: i.id })
    })),
    ...p.links.map((l) => ({
      key: l.id,
      label: l.name,
      detail: 'link',
      kind: 'L',
      run: () => navigate({ kind: 'link', id: l.id })
    })),
    { key: GLOBAL_VIEW, label: 'Global', detail: 'view', kind: 'V', run: () => openView(GLOBAL_VIEW) },
    ...p.views.map((v) => ({
      key: v.id,
      label: v.name,
      detail: 'view',
      kind: 'V',
      run: () => (v.rootModuleId && !p.views.includes(v) ? openModuleView(v.rootModuleId) : openView(v.id))
    }))
  ]
}

function Highlight({ text, positions }: { text: string; positions: number[] }): ReactNode {
  const set = new Set(positions)
  return <>{[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : ch))}</>
}

export function CommandPalette(): ReactNode {
  const palette = useUiStore((s) => s.palette)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (palette) {
      setQuery(palette.query)
      setActive(0)
    }
  }, [palette])

  const isCommands = query.startsWith('>')
  const entries = useMemo(
    () => (palette ? (isCommands ? commandEntries() : entityEntries()) : []),
    [palette, isCommands]
  )
  const results = useMemo(
    () => fuzzyFilter(isCommands ? query.slice(1) : query, entries, (e) => e.label).slice(0, 60),
    [entries, query, isCommands]
  )

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!palette) return null
  const close = (): void => useUiStore.setState({ palette: null })
  const pick = (e: Entry | undefined): void => {
    close()
    e?.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          spellCheck={false}
          placeholder={
            isCommands ? 'Type a command' : 'Go to module, type, interface, link, view — ">" for commands'
          }
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
            else if (e.key === 'Enter') pick(results[active]?.item)
            else return
            e.preventDefault()
          }}
        />
        <ul ref={list}>
          {results.map(({ item, match }, i) => (
            <li
              key={item.key}
              className={i === active ? 'active' : ''}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(item)}
            >
              <span className="palette-kind">{item.kind}</span>
              <span className="palette-label">
                <Highlight text={item.label} positions={match.positions} />
              </span>
              {item.detail && <small>{item.detail}</small>}
              {item.keys && <kbd>{item.keys}</kbd>}
            </li>
          ))}
          {!results.length && <li className="empty">No match</li>}
        </ul>
      </div>
    </div>
  )
}
