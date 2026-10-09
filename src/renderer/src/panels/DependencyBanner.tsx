import type { ReactNode } from 'react'
import { openImportSource, refreshDependencies, showDependency } from '@/actions'
import type { Dependency } from '@/model/types'

/** Where a dependency's type or interface comes from: it is edited in that file. */
export function DependencyBanner({ dependency }: { dependency: Dependency }): ReactNode {
  return (
    <div className="callout dependency">
      From dependency <strong>{dependency.name}</strong> ({dependency.file}): read-only here, edit it in its
      file.
      <div className="actions">
        <button type="button" onClick={() => showDependency(dependency.id)}>
          Show dependency
        </button>
        <button type="button" onClick={() => openImportSource(dependency.file)}>
          Open project
        </button>
        <button type="button" onClick={() => void refreshDependencies([dependency.id])}>
          Refresh
        </button>
      </div>
    </div>
  )
}
