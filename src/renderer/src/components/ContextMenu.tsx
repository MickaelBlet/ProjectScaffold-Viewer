import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useUiStore, type MenuItem } from '@/store/ui'

export function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }): ReactNode {
  return (
    <>
      {items.map((it, i) =>
        it === 'separator' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onDone()
              it.run()
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            <span className="menu-label">{it.label}</span>
            {it.keys && <kbd>{it.keys}</kbd>}
          </button>
        )
      )}
    </>
  )
}

/** Right-click menu, opened with `openContextMenu`. */
export function ContextMenu(): ReactNode {
  const menu = useUiStore((s) => s.contextMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const close = (): void => useUiStore.setState({ contextMenu: null })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))
    })
    ref.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={menu.items} onDone={close} />
    </div>
  )
}
