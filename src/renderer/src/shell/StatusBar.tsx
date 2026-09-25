import type { ReactNode } from 'react'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { setSetting, useSettings } from '@/store/settings'
import { useUiStore } from '@/store/ui'
import { useProblems } from '@/panels/ProblemsPanel'
import { findView } from '@/model/project'
import { showTool } from './controllers'

export function StatusBar(): ReactNode {
  const status = useUiStore((s) => s.status)
  const zoom = useUiStore((s) => s.zoom)
  const filePath = useDoc((d) => d.filePath)
  const saved = useDoc((d) => d.savedProject)
  const selected = useDoc((d) => d.selectedIds.length)
  const viewId = useDoc((d) => d.activeViewId)
  const project = useProjectStore((s) => s.project)
  const snap = useSettings((s) => s.snapToGrid)
  const problems = useProblems()
  const errors = problems.filter((p) => p.severity === 'error').length
  const view = findView(project, viewId)
  return (
    <footer className={`statusbar ${status?.kind ?? ''}`}>
      <span className="status-text">{status?.text ?? 'Ready'}</span>
      <span className="spacer" />
      <button type="button" className="status-item" title="Problems" onClick={() => showTool('problems')}>
        <span className={errors ? 'error' : ''}>✖ {errors}</span> ⚠ {problems.length - errors}
      </button>
      {selected > 0 && <span className="status-item">{selected} selected</span>}
      <span className="status-item" title="Focused view">
        {view.name}
      </span>
      <button
        type="button"
        className={`status-item ${snap ? 'on' : ''}`}
        title="Snap to grid"
        onClick={() => setSetting('snapToGrid', !snap)}
      >
        # Snap
      </button>
      <span className="status-item">{Math.round(zoom * 100)}%</span>
      <span className="status-item path" title={filePath ?? undefined}>
        {filePath ?? 'Unsaved project'}
        {saved !== project ? ' (modified)' : ''}
      </span>
    </footer>
  )
}
