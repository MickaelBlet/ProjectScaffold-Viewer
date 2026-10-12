import type { ReactNode } from 'react'
import { availableIds, commands, getCommand, keyLabel, runCommand } from '@/commands'
import { Icon } from '@/components/Icon'
import { useSettings } from '@/store/settings'
import { useDoc } from '@/store/documents'
import { useUiStore } from '@/store/ui'
import { useProjectStore } from '@/store/project'
import { IN_VSCODE } from '@/host'
import { commandIcon } from './toolbar'

// Every command the toolbar can show has an icon.
if (!IN_VSCODE)
  for (const c of commands) if (!c.hidden && !commandIcon(c.id)) throw new Error(`No icon for ${c.id}`)

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

/** The buttons chosen in the settings: right of the menus (`toolbar`) or at the right end (`toolbarRight`). */
export function CommandToolbar({ setting }: { setting: 'toolbar' | 'toolbarRight' }): ReactNode {
  const ids = availableIds(useSettings((s) => s[setting]))
  // Toggles show their state, read from the settings, the project or the selection.
  useSettings()
  useProjectStore((s) => s.project)
  useDoc((d) => d.selection)
  useUiStore((s) => s.tutorialStep !== null)
  return ids.map((id, i) =>
    id === '-' ? <span key={i} className="sep" /> : <CommandButton key={i} id={id} />
  )
}
