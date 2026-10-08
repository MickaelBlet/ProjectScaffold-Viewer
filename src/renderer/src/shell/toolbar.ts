// Icons of the commands placed in the toolbar; the others show their title.
import type { IconName } from '@/components/Icon'

const COMMAND_ICONS: Partial<Record<string, IconName>> = {
  'file.open': 'folder',
  'file.generate': 'play',
  'file.codeTemplates': 'templates',
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'insert.refreshDependencies': 'refresh',
  'view.back': 'selection-prev',
  'view.forward': 'selection-next',
  'view.fit': 'expand',
  'view.source': 'code',
  'view.hide': 'eye-off',
  'view.showAll': 'eye',
  'arrange.left': 'align-left',
  'arrange.hcenter': 'align-hcenter',
  'arrange.right': 'align-right',
  'arrange.top': 'align-top',
  'arrange.vcenter': 'align-vcenter',
  'arrange.bottom': 'align-bottom',
  'arrange.distH': 'distribute-h',
  'arrange.distV': 'distribute-v',
  'arrange.sameSize': 'same-size',
  'arrange.snap': 'grid',
  // As the tabs of the tool panels (TOOL_ICONS, DockShell.tsx, which imports the Settings panel).
  'window.explorer': 'tree',
  'window.generation': 'code',
  'window.inspector': 'info',
  'window.problems': 'warning',
  'window.output': 'output',
  'window.search': 'search',
  'window.settings': 'gear'
}

export function commandIcon(id: string): IconName | undefined {
  return COMMAND_ICONS[id]
}
