import { useState, type ReactNode } from 'react'
import { useUiStore, select } from '@/store/ui'
import type { Problem } from '@/model/validate'

export function ProblemsPanel({ problems }: { problems: Problem[] }): ReactNode {
  const [open, setOpen] = useState(true)
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors

  const go = (p: Problem): void => {
    const t = p.target
    if (t.kind === 'type') useUiStore.setState({ sidebarTab: 'types' })
    if (t.kind === 'interface') useUiStore.setState({ sidebarTab: 'interfaces' })
    select(t.kind === 'project' ? { kind: 'project' } : t)
  }

  return (
    <section className={`problems ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} Problems</span>
        <span className={`count error ${errors ? '' : 'zero'}`}>✖ {errors}</span>
        <span className={`count warning ${warnings ? '' : 'zero'}`}>⚠ {warnings}</span>
      </header>
      {open && (
        <ul>
          {problems.map((p, i) => (
            <li key={i} className={p.severity} onClick={() => go(p)}>
              <span className="sev">{p.severity === 'error' ? '✖' : '⚠'}</span>
              {p.message}
            </li>
          ))}
          {!problems.length && <li className="ok">No problems — ready to export.</li>}
        </ul>
      )}
    </section>
  )
}
