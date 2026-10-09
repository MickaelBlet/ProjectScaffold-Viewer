import type { ReactNode } from 'react'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { setSetting, useSettings } from '@/store/settings'
import { useUiStore } from '@/store/ui'
import { useProblemCounts } from '@/panels/ProblemsPanel'
import { findView } from '@/model/project'
import { showTool } from './controllers'
import { Icon } from '@/components/Icon'

export function StatusBar(): ReactNode {
  const status = useUiStore((s) => s.status)
  const zoom = useUiStore((s) => s.zoom)
  const filePath = useDoc((d) => d.filePath)
  const saved = useDoc((d) => d.savedProject)
  const selected = useDoc((d) => d.selectedIds.length)
  const viewId = useDoc((d) => d.activeViewId)
  // Narrow selections: the status bar does not render again on every edit.
  const modified = useProjectStore((s) => s.project !== saved)
  const viewName = useProjectStore((s) => findView(s.project, viewId).name)
  const snap = useSettings((s) => s.snapToGrid)
  const { errors, warnings } = useProblemCounts()
  return (
    <footer className={`statusbar ${status?.kind ?? ''}`}>
      <span className="status-text" role="status">
        {status?.text ?? 'Ready'}
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="status-item"
        title="Problems"
        aria-label={`Problems: ${errors} errors, ${warnings} warnings`}
        onClick={() => showTool('problems')}
      >
        <span className={errors ? 'error' : ''}>
          <Icon name="error" /> {errors}
        </span>{' '}
        <Icon name="warning" /> {warnings}
      </button>
      {selected > 0 && <span className="status-item">{selected} selected</span>}
      <span className="status-item" title="Focused view">
        {viewName}
      </span>
      <button
        type="button"
        className={`status-item ${snap ? 'on' : ''}`}
        title="Snap to grid"
        aria-pressed={snap}
        onClick={() => setSetting('snapToGrid', !snap)}
      >
        <Icon name="grid" /> Snap
      </button>
      <span className="status-item">{Math.round(zoom * 100)}%</span>
      <span className="status-item path" title={filePath ?? undefined}>
        {filePath ?? 'Unsaved project'}
        {modified ? ' (modified)' : ''}
      </span>
    </footer>
  )
}
