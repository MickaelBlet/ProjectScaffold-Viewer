import { useState, type ReactNode } from 'react'
import { validate, type Problem } from '@/model/validate'
import type { Project } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { navigate } from '@/actions'
import { Icon } from '@/components/Icon'

const validated = new WeakMap<Project, Problem[]>()

/** Problems of the active document, validated once per project version. */
export function useProblems(): Problem[] {
  const project = useProjectStore((s) => s.project)
  let problems = validated.get(project)
  if (!problems) validated.set(project, (problems = validate(project)))
  return problems
}

export function ProblemsPanel(): ReactNode {
  const problems = useProblems()
  const [show, setShow] = useState({ error: true, warning: true })
  const [filter, setFilter] = useState('')
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  const f = filter.trim().toLowerCase()
  const shown = problems.filter((p) => show[p.severity] && (!f || p.message.toLowerCase().includes(f)))

  return (
    <section className="problems">
      <header>
        <button
          type="button"
          className={`count error ${errors ? '' : 'zero'} ${show.error ? 'on' : ''}`}
          title="Show errors"
          onClick={() => setShow((s) => ({ ...s, error: !s.error }))}
        >
          <Icon name="error" /> {errors}
        </button>
        <button
          type="button"
          className={`count warning ${warnings ? '' : 'zero'} ${show.warning ? 'on' : ''}`}
          title="Show warnings"
          onClick={() => setShow((s) => ({ ...s, warning: !s.warning }))}
        >
          <Icon name="warning" /> {warnings}
        </button>
        <input
          type="search"
          data-autofocus
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>
      <ul>
        {shown.map((p, i) => (
          <li key={i} className={p.severity} onClick={() => navigate(p.target)}>
            <span className="sev">
              <Icon name={p.severity} />
            </span>
            {p.message}
          </li>
        ))}
        {!problems.length && <li className="ok">No problems — ready to export.</li>}
      </ul>
    </section>
  )
}
