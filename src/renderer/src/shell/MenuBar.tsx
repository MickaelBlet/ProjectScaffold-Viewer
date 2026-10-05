import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { commandItem, commands, type Category } from '@/commands'
import { MenuList } from '@/components/ContextMenu'
import { Icon } from '@/components/Icon'
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
      'view.resetLayout',
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

/** Room left in the toolbar beside its items (what its spacers take), negative when they overflow. */
function freeRoom(toolbar: HTMLElement): number {
  const style = getComputedStyle(toolbar)
  const items = [...toolbar.children].filter((c) => !c.classList.contains('spacer'))
  return (
    toolbar.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight) -
    parseFloat(style.columnGap || '0') * (toolbar.children.length - 1) -
    items.reduce((w, c) => w + c.getBoundingClientRect().width, 0)
  )
}

/** Whether the menus are folded into one button: once the toolbar has no room left, until it has
 *  room for them unfolded. */
function useFolded(ref: RefObject<HTMLDivElement | null>): boolean {
  const [folded, setFolded] = useState(false)
  const unfolded = useRef(0)
  useLayoutEffect(() => {
    const menubar = ref.current
    const toolbar = menubar?.parentElement
    if (!menubar || !toolbar) return
    const check = (): void => {
      const free = freeRoom(toolbar)
      const width = menubar.getBoundingClientRect().width
      if (!folded) {
        unfolded.current = width
        if (free < 1) setFolded(true)
      } else if (free - (unfolded.current - width) >= 1) setFolded(false)
    }
    const observer = new ResizeObserver(check)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [ref, folded])
  return folded
}

/** Open menu: a category, or 'all' for the folded menus. */
type Open = Category | 'all' | null

export function MenuBar(): ReactNode {
  const [state, setOpen] = useState<Open>(null)
  const ref = useRef<HTMLDivElement>(null)
  const folded = useFolded(ref)
  // Closed when the menus fold or unfold.
  const open = folded === (state === 'all') ? state : null
  const recent = useUiStore((s) => s.recent)
  const filePath = useDoc((d) => d.filePath)
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

  const items = (ids: string[]): MenuItem[] =>
    ids.map((id): MenuItem =>
      id === '-' ? 'separator' : id === 'recent' ? recentItem(recent, filePath) : commandItem(id)
    )
  const dropdown = (
    key: Exclude<Open, null>,
    label: ReactNode,
    title: string | undefined,
    list: () => MenuItem[]
  ): ReactNode => (
    <div className="dropdown" key={key}>
      <button
        type="button"
        className={`menubar-item ${open === key ? 'open' : ''}`}
        role="menuitem"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open === key}
        onClick={() => setOpen(open === key ? null : key)}
        onMouseEnter={() => open && setOpen(key)}
      >
        {label}
      </button>
      {open === key && (
        <div className="dropdown-menu context-menu" role="menu" aria-label={title ?? key}>
          <MenuList items={list()} onDone={() => setOpen(null)} />
        </div>
      )}
    </div>
  )

  return (
    <div className="menubar" ref={ref} role="menubar">
      {folded
        ? dropdown('all', <Icon name="menu" />, 'Menu', () =>
            menus.map(([cat, ids]): MenuItem => ({ label: cat, submenu: items(ids) }))
          )
        : menus.map(([cat, ids]) => dropdown(cat, cat, undefined, () => items(ids)))}
    </div>
  )
}
