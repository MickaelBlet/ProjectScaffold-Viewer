import { useEffect, useRef, useState, type ReactNode } from 'react'
import { commandItem, commands, type Category } from '@/commands'
import { MenuList } from '@/components/ContextMenu'
import { fileName, openRecentProject } from '@/fileOps'
import { useDoc } from '@/store/documents'
import { useUiStore, type MenuItem } from '@/store/ui'
import { IN_VSCODE } from '@/host'

/** Menus built from the command registry: command ids, '-' for a separator between groups of
 *  related commands, 'recent' for the recent documents submenu. */
const MENUS: [Category, string[]][] = [
  [
    'File',
    [
      'file.new',
      'file.open',
      'recent',
      '-',
      'file.save',
      'file.saveAs',
      'file.saveAll',
      '-',
      'file.saveWorkspace',
      'file.saveWorkspaceAs',
      '-',
      'file.importSettings',
      'file.exportSettings',
      '-',
      'file.openIdlText',
      '-',
      'file.exportPng',
      'file.exportSvg',
      '-',
      'file.generate',
      'file.generateInto',
      'file.codeTemplates',
      '-',
      'file.close'
    ]
  ],
  [
    'Edit',
    [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.duplicate',
      'edit.delete',
      '-',
      'edit.selectAll',
      'edit.rename',
      '-',
      'view.goto',
      'view.palette'
    ]
  ],
  [
    'Insert',
    [
      'insert.module',
      'insert.submodule',
      'insert.inPort',
      'insert.outPort',
      '-',
      'insert.note',
      'insert.frame',
      '-',
      'insert.projectContent',
      'insert.dependency',
      'insert.imported',
      'insert.refreshDependencies'
    ]
  ],
  [
    'View',
    [
      'view.global',
      'view.openModule',
      'view.openModuleSplit',
      'view.keep',
      'view.new',
      'view.source',
      '-',
      'view.hide',
      'view.showAll',
      '-',
      'view.fit',
      'view.fitAll',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomReset'
    ]
  ],
  [
    'Arrange',
    [
      'arrange.auto',
      'arrange.all',
      'arrange.horizontal',
      'arrange.vertical',
      '-',
      'arrange.group',
      '-',
      'arrange.left',
      'arrange.hcenter',
      'arrange.right',
      'arrange.top',
      'arrange.vcenter',
      'arrange.bottom',
      '-',
      'arrange.distH',
      'arrange.distV',
      'arrange.sameSize',
      '-',
      'arrange.snap',
      'arrange.guides'
    ]
  ],
  [
    'Window',
    [
      'window.explorer',
      'window.generation',
      'window.inspector',
      'window.problems',
      'window.output',
      'window.search',
      'window.settings',
      '-',
      'window.nextDoc',
      'window.prevDoc',
      '-',
      'window.resetLayout',
      'window.fullLayout'
    ]
  ],
  ['Help', ['help.shortcuts', 'view.palette', '-', 'help.resetData', '-', 'help.about']]
]

// Every listed command must exist (but those of the VS Code previews).
if (!IN_VSCODE)
  for (const [, ids] of MENUS)
    for (const id of ids)
      if (id !== '-' && id !== 'recent' && id !== 'window.fullLayout' && !commands.some((c) => c.id === id))
        throw new Error(id)

/** Menus without the commands the host leaves out (VS Code: document commands; elsewhere: VS Code
 *  commands), nor the separators they leave. */
function availableMenus(): [Category, string[]][] {
  return MENUS.map(([cat, ids]) => {
    const kept = ids.filter((id) => id === '-' || commands.some((c) => c.id === id))
    const between = (i: number): boolean =>
      kept.slice(0, i).some((x) => x !== '-') && kept[i + 1] !== undefined && kept[i + 1] !== '-'
    return [cat, kept.filter((id, i) => id !== '-' || between(i))]
  })
}

const menus = availableMenus()

function recentItem(recent: string[], filePath: string | null): MenuItem {
  return {
    label: 'Open Recent',
    disabled: !recent.length,
    submenu: [
      ...recent.map((path): MenuItem => ({
        label: fileName(path),
        title: path,
        checked: path === filePath,
        run: () => void openRecentProject(path)
      })),
      'separator',
      { label: 'Clear Recent', run: () => void window.api.clearRecent() }
    ]
  }
}

export function MenuBar(): ReactNode {
  const [open, setOpen] = useState<Category | null>(null)
  const recent = useUiStore((s) => s.recent)
  const filePath = useDoc((d) => d.filePath)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menubar" ref={ref} role="menubar">
      {menus.map(([cat, ids]) => (
        <div className="dropdown" key={cat}>
          <button
            type="button"
            className={`menubar-item ${open === cat ? 'open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === cat}
            onClick={() => setOpen(open === cat ? null : cat)}
            onMouseEnter={() => open && setOpen(cat)}
          >
            {cat}
          </button>
          {open === cat && (
            <div className="dropdown-menu context-menu" role="menu" aria-label={cat}>
              <MenuList
                items={ids.map((id): MenuItem =>
                  id === '-' ? 'separator' : id === 'recent' ? recentItem(recent, filePath) : commandItem(id)
                )}
                onDone={() => setOpen(null)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
