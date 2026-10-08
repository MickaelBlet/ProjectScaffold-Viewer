import type { ReactNode } from 'react'
import { availableIds, getCommand, keyLabel, runCommand } from '@/commands'
import { Icon } from '@/components/Icon'
import { useSettings } from '@/store/settings'
import { useDoc } from '@/store/documents'
import { useProjectStore } from '@/store/project'
import { commandIcon } from './toolbar'

function CommandButton({ id }: { id: string }): ReactNode {
  const c = getCommand(id)
  const icon = commandIcon(id)
  const title = c.keys?.[0] ? `${c.title} (${keyLabel(c.keys[0])})` : c.title
  return (
    <button
      type="button"
      className="command"
      title={title}
      aria-label={title}
      aria-pressed={c.checked?.()}
      onClick={() => runCommand(id)}
    >
      {icon ? <Icon name={icon} /> : c.title}
    </button>
  )
}

/** The buttons chosen in the settings, right of the menus. */
export function CommandToolbar(): ReactNode {
  const ids = availableIds(useSettings((s) => s.toolbar))
  // Toggles show their state, read from the settings, the project or the selection.
  useSettings()
  useProjectStore((s) => s.project)
  useDoc((d) => d.selection)
  if (!ids.length) return null
  return (
    <>
      <span className="sep" />
      {ids.map((id, i) =>
        id === '-' ? <span key={i} className="sep" /> : <CommandButton key={i} id={id} />
      )}
    </>
  )
}
