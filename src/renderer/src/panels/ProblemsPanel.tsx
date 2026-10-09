import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { validate, type Problem } from '@/model/validate'
import type { Project } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { navigate } from '@/actions'
import { Icon } from '@/components/Icon'
import { onListKeyDown } from '@/components/listKeys'

const validated = new WeakMap<Project, Problem[]>()

/** Problems of a project, validated once per project version. */
export function problemsOf(project: Project): Problem[] {
  let problems = validated.get(project)
  if (!problems) validated.set(project, (problems = validate(project)))
  return problems
}

/** Problems of the active document, validated once per project version. */
export function useProblems(): Problem[] {
  return useProjectStore((s) => problemsOf(s.project))
}

/** Error and warning counts only: renders again when they change, not on every edit. */
export function useProblemCounts(): { errors: number; warnings: number } {
  return useProjectStore(
    useShallow((s) => {
      const problems = problemsOf(s.project)
      const errors = problems.filter((p) => p.severity === 'error').length
      return { errors, warnings: problems.length - errors }
    })
  )
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
          aria-pressed={show.error}
          onClick={() => setShow((s) => ({ ...s, error: !s.error }))}
        >
          <Icon name="error" /> {errors}
        </button>
        <button
          type="button"
          className={`count warning ${warnings ? '' : 'zero'} ${show.warning ? 'on' : ''}`}
          title="Show warnings"
          aria-pressed={show.warning}
          onClick={() => setShow((s) => ({ ...s, warning: !s.warning }))}
        >
          <Icon name="warning" /> {warnings}
        </button>
        <input
          type="search"
          data-autofocus
          placeholder="Filter"
          aria-label="Filter problems"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>
      <ul role="listbox" aria-label="Problems" onKeyDown={onListKeyDown}>
        {shown.map((p, i) => (
          <li
            key={i}
            data-item
            role="option"
            aria-selected={false}
            tabIndex={i === 0 ? 0 : -1}
            className={p.severity}
            onClick={() => navigate(p.target)}
          >
            <span className="sev">
              <Icon name={p.severity} title={p.severity} />
            </span>
            {p.message}
          </li>
        ))}
        {!problems.length && (
          <li className="ok" role="presentation">
            No problems — ready to export.
          </li>
        )}
      </ul>
    </section>
  )
}
