import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { searchProject } from '@/model/search'
import { useProjectStore } from '@/store/project'
import { navigate } from '@/actions'

function Mark({ text, query }: { text: string; query: string }): ReactNode {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0 || !query) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

export function SearchPanel(): ReactNode {
  const project = useProjectStore((s) => s.project)
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const hits = useMemo(() => searchProject(project, deferred), [project, deferred])
  return (
    <div className="search-panel">
      <div className="panel-filter">
        <input
          data-autofocus
          type="search"
          placeholder="Search names, descriptions, metadata"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {deferred && <p className="muted count">{hits.length} results</p>}
      <ul className="results">
        {hits.map((h, i) => (
          <li key={i} onClick={() => navigate(h.target)}>
            <span className={`kind-badge ${h.target.kind === 'module' ? 'mod' : h.target.kind}`}>
              {h.target.kind[0]!.toUpperCase()}
            </span>
            <span className="result-label">{h.label}</span>
            <small>{h.field}</small>
            {h.text !== h.label.split(/[.:]/).pop() && (
              <span className="result-text">
                <Mark text={h.text} query={deferred} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
