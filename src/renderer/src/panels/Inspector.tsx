import type { ReactNode } from 'react'
import { useUiStore } from '@/store/ui'
import { ProjectInspector } from './ProjectInspector'
import { ModuleInspector } from './ModuleInspector'
import { LinkInspector } from './LinkInspector'
import { TypeInspector } from './TypeInspector'
import { InterfaceInspector } from './InterfaceInspector'

export function Inspector(): ReactNode {
  const sel = useUiStore((s) => s.selection)
  return (
    <aside className="inspector">
      {!sel || sel.kind === 'project' ? (
        <ProjectInspector />
      ) : sel.kind === 'module' ? (
        <ModuleInspector key={sel.id} id={sel.id} />
      ) : sel.kind === 'link' ? (
        <LinkInspector key={sel.id} id={sel.id} />
      ) : sel.kind === 'type' ? (
        <TypeInspector key={sel.id} id={sel.id} />
      ) : (
        <InterfaceInspector key={sel.id} id={sel.id} />
      )}
    </aside>
  )
}
