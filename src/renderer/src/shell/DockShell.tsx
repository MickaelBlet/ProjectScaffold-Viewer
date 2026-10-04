// Outer layout: tool panels docked, tabbed or floating around the editor area.
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps
} from 'dockview-react'
import { Icon, type IconName } from '@/components/Icon'
import { openContextMenu } from '@/store/ui'
import { ExplorerPanel } from '@/panels/ExplorerPanel'
import { Inspector } from '@/panels/Inspector'
import { ProblemsPanel, useProblemCounts } from '@/panels/ProblemsPanel'
import { SearchPanel } from '@/panels/SearchPanel'
import { SettingsPanel } from '@/panels/SettingsPanel'
import { GenerationPanel } from '@/panels/GenerationPanel'
import { OutputPanel } from '@/panels/OutputPanel'
import { EditorArea } from './EditorArea'
import {
  EDITOR_AREA,
  keepSizes,
  loadOuterLayout,
  lockEditorArea,
  saveOuterLayout,
  setOuterApi,
  type ToolId
} from './controllers'
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
  const { errors, warnings } = useProblemCounts()
  useEffect(
    () => api.setTitle(errors + warnings ? `Problems (${errors}✖ ${warnings}⚠)` : 'Problems'),
    [api, errors, warnings]
  )
  return null
}

const ProblemsTool = tool('problems', ProblemsPanel)

function ProblemsToolPanel(props: IDockviewPanelProps): ReactNode {
  return (
    <>
      <ProblemsTitle {...props} />
      <ProblemsTool />
    </>
  )
}

export const TOOL_ICONS: Record<ToolId, IconName> = {
  explorer: 'tree',
  generation: 'code',
  inspector: 'info',
  problems: 'warning',
  output: 'output',
  search: 'search',
  settings: 'gear'
}

function ProblemsBadge(): ReactNode {
  const { errors, warnings } = useProblemCounts()
  if (!errors && !warnings) return null
  return <span className={`tool-tab-badge ${errors ? 'error' : 'warning'}`}>{errors || warnings}</span>
}

/** Tool tabs show an icon, the title is the tooltip; middle click or the context menu closes them. */
function ToolTab({ api }: IDockviewPanelHeaderProps): ReactNode {
  const title = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const d = api.onDidTitleChange(onChange)
        return () => d.dispose()
      },
      [api]
    ),
    () => api.title ?? ''
  )
  const icon = TOOL_ICONS[api.id as ToolId] as IconName | undefined
  return (
    <div
      className="dv-default-tab tool-tab"
      title={title}
      aria-label={title}
      onPointerUp={(e) => {
        if (e.button === 1) api.close()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [{ label: 'Close', run: () => api.close() }])
      }}
    >
      <span className="dv-default-tab-content">{icon ? <Icon name={icon} /> : title}</span>
      {api.id === 'problems' && <ProblemsBadge />}
    </div>
  )
}

const components = {
  editorArea: EditorArea,
  explorer: tool('explorer', ExplorerPanel),
  generation: tool('generation', GenerationPanel),
  inspector: tool('inspector', Inspector),
  problems: ProblemsToolPanel,
  output: tool('output', OutputPanel),
  search: tool('search', SearchPanel),
  settings: tool('settings', SettingsPanel)
}

export function DockShell(): ReactNode {
  const onReady = useCallback((e: DockviewReadyEvent): void => {
    setOuterApi(e.api)
    loadOuterLayout(e.api)
    e.api.onDidLayoutChange(saveOuterLayout)
    keepSizes(e.api)
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
  return (
    <DockviewReact
      className="dock"
      components={components}
      defaultTabComponent={ToolTab}
      onReady={onReady}
      theme={dockTheme}
    />
  )
}
