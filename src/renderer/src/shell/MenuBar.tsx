import { useEffect, useRef, useState, type ReactNode } from 'react'
import { commandItem, commands, type Category } from '@/commands'
import { MenuList } from '@/components/ContextMenu'
import { fileName, openRecentProject } from '@/fileOps'
import { useDoc } from '@/store/documents'
import { useUiStore, type MenuItem } from '@/store/ui'

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
      'file.exportYaml',
      'file.exportJson',
      'file.exportPng',
      'file.exportSvg',
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
      'insert.imported',
      'insert.refreshImports'
    ]
  ],
  [
    'View',
    [
      'view.global',
      'view.openModule',
      'view.openModuleSplit',
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
      'view.zoomReset',
      '-',
      'view.minimap',
      'view.badges',
      'view.autoOrient',
      '-',
      'view.themeSystem',
      'view.themeLight',
      'view.themeDark'
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
      'window.outline',
      'window.links',
      'window.inspector',
      'window.problems',
      'window.search',
      'window.settings',
      '-',
      'window.nextDoc',
      'window.prevDoc',
      '-',
      'window.resetLayout'
    ]
  ],
  ['Help', ['help.shortcuts', 'view.palette', 'help.about']]
]

// Every listed command must exist.
for (const [, ids] of MENUS)
  for (const id of ids)
    if (id !== '-' && id !== 'recent' && !commands.some((c) => c.id === id)) throw new Error(id)

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
      {MENUS.map(([cat, ids]) => (
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
