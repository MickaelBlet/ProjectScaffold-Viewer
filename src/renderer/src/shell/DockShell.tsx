// Outer layout: tool panels docked, tabbed or floating around the editor area.
import { useCallback, useEffect, type ReactNode } from 'react'
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import { ExplorerPanel } from '@/panels/ExplorerPanel'
import { OutlinePanel } from '@/panels/OutlinePanel'
import { Inspector } from '@/panels/Inspector'
import { ProblemsPanel, useProblems } from '@/panels/ProblemsPanel'
import { SearchPanel } from '@/panels/SearchPanel'
import { SettingsPanel } from '@/panels/SettingsPanel'
import { EditorArea } from './EditorArea'
import { EDITOR_AREA, loadOuterLayout, lockEditorArea, saveOuterLayout, setOuterApi } from './controllers'
import { dockTheme } from './theme'

function tool(id: string, Content: () => ReactNode) {
  return function ToolPanel(): ReactNode {
    return (
      <div className="tool-panel" data-panel={id}>
        <Content />
      </div>
    )
  }
}

/** Keeps the Problems tab title up to date with the counts. */
function ProblemsTitle({ api }: IDockviewPanelProps): ReactNode {
  const problems = useProblems()
  const errors = problems.filter((p) => p.severity === 'error').length
  useEffect(
    () => api.setTitle(problems.length ? `Problems (${errors}✖ ${problems.length - errors}⚠)` : 'Problems'),
    [api, problems.length, errors]
  )
  return null
}

const ProblemsTool = tool('problems', ProblemsPanel)

const components = {
  editorArea: () => <EditorArea />,
  explorer: tool('explorer', ExplorerPanel),
  outline: tool('outline', OutlinePanel),
  inspector: tool('inspector', Inspector),
  problems: (props: IDockviewPanelProps) => (
    <>
      <ProblemsTitle {...props} />
      <ProblemsTool />
    </>
  ),
  search: tool('search', SearchPanel),
  settings: tool('settings', SettingsPanel)
}

export function DockShell(): ReactNode {
  const onReady = useCallback((e: DockviewReadyEvent): void => {
    setOuterApi(e.api)
    loadOuterLayout(e.api)
    e.api.onDidLayoutChange(saveOuterLayout)
    // The editor area cannot go away.
    e.api.onDidRemovePanel((p) => {
      if (p.id !== EDITOR_AREA) return
      setTimeout(() => {
        if (e.api.getPanel(EDITOR_AREA)) return
        e.api.addPanel({ id: EDITOR_AREA, component: 'editorArea', title: 'Editor' })
        lockEditorArea(e.api)
      })
    })
  }, [])
  return <DockviewReact className="dock" components={components} onReady={onReady} theme={dockTheme} />
}
