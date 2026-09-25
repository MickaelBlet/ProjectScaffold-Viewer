import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileName, openRecentProject } from '@/fileOps'
import { useUiStore } from '@/store/ui'
import { useDoc } from '@/store/documents'

/** Toolbar dropdown listing the recent documents. */
export function RecentMenu(): ReactNode {
  const recent = useUiStore((s) => s.recent)
  const filePath = useDoc((d) => d.filePath)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (path: string): void => {
    setOpen(false)
    void openRecentProject(path)
  }

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        disabled={!recent.length}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Recent documents"
        onClick={() => setOpen((o) => !o)}
      >
        Recent ▾
      </button>
      {open && (
        <div className="dropdown-menu" role="menu">
          <div className="dropdown-title">Recent documents</div>
          {recent.map((path) => {
            const name = fileName(path)
            return (
              <button
                key={path}
                type="button"
                role="menuitem"
                title={path}
                className={path === filePath ? 'active' : ''}
                onClick={() => pick(path)}
              >
                <span>{name}</span>
                {name !== path && <small>{path.slice(0, -name.length - 1)}</small>}
              </button>
            )
          })}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void window.api.clearRecent()
            }}
          >
            Clear list
          </button>
        </div>
      )}
    </div>
  )
}
