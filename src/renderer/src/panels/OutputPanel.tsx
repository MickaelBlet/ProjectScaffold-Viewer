// Log of code generation, status messages and dialogs; generated files open from their entries.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { clearOutput, clockTime, useOutput, type OutputLevel, type OutputSource } from '@/store/output'
import { useDocs } from '@/store/documents'
import { openTextFile } from '@/textFileOps'

const LEVEL_ICONS = { info: 'dot', warning: 'warning', error: 'error' } as const

export function OutputPanel(): ReactNode {
  const entries = useOutput((s) => s.entries)
  const activeId = useDocs((s) => s.activeId)
  const [source, setSource] = useState<OutputSource | 'all'>('all')
  const [show, setShow] = useState<Record<OutputLevel, boolean>>({ info: true, warning: true, error: true })
  const [filter, setFilter] = useState('')
  const list = useRef<HTMLUListElement>(null)
  // Follows new entries unless scrolled up.
  const atBottom = useRef(true)

  const f = filter.trim().toLowerCase()
  const shown = entries.filter(
    (e) =>
      show[e.level] && (source === 'all' || e.source === source) && (!f || e.text.toLowerCase().includes(f))
  )
  const count = (level: OutputLevel): number => entries.filter((e) => e.level === level).length

  useLayoutEffect(() => {
    const el = list.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [shown.length, entries])

  const toggle = (level: OutputLevel): void => setShow((s) => ({ ...s, [level]: !s[level] }))

  return (
    <section className="problems output">
      <header>
        <select
          aria-label="Source of the messages shown"
          value={source}
          onChange={(e) => setSource(e.target.value as OutputSource | 'all')}
        >
          <option value="all">All</option>
          <option value="generation">Code generation</option>
          <option value="app">Messages</option>
        </select>
        {(['error', 'warning', 'info'] as const).map((level) => (
          <button
            key={level}
            type="button"
            className={`count ${level} ${count(level) ? '' : 'zero'} ${show[level] ? 'on' : ''}`}
            title={`Show ${level === 'info' ? 'information' : `${level}s`}`}
            aria-pressed={show[level]}
            onClick={() => toggle(level)}
          >
            <Icon name={LEVEL_ICONS[level]} /> {count(level)}
          </button>
        ))}
        <input
          type="search"
          data-autofocus
          placeholder="Filter"
          aria-label="Filter the output"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="link-button" onClick={clearOutput} title="Clear the output">
          Clear
        </button>
      </header>
      <ul
        ref={list}
        aria-label="Output"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
        }}
      >
        {shown.map((e) => {
          const openable = e.path !== undefined && e.doc === activeId
          return (
            <li key={e.id} className={e.level}>
              <time>{clockTime(e.time)}</time>
              <span className="sev">
                <Icon name={LEVEL_ICONS[e.level]} title={e.level} />
              </span>
              {openable ? (
                <button
                  type="button"
                  className="output-text link-button"
                  title={`Open ${e.path} (Alt+click: to the side)`}
                  onClick={(ev) =>
                    void openTextFile({ source: 'output', path: e.path! }, { split: ev.altKey })
                  }
                >
                  {e.text}
                </button>
              ) : (
                <span
                  className="output-text"
                  title={e.path ? 'Generated for another document: activate it to open the file' : undefined}
                >
                  {e.text}
                </span>
              )}
            </li>
          )
        })}
        {!entries.length && (
          <li className="empty muted" role="presentation">
            No output yet.
          </li>
        )}
      </ul>
    </section>
  )
}
