// Collapsible panel section whose header drags to reorder it among the sections of the same drag type
// (Alt+Up / Alt+Down on its toggle as well). Used by the Explorer and the Code generation panel.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { Icon } from './Icon'

/** Saved order of `all`; sections it lacks (added later) go after the section preceding them by default. */
export function sectionOrder<T extends string>(saved: readonly string[], all: readonly T[]): T[] {
  const order = [...new Set(saved.filter((s): s is T => (all as readonly string[]).includes(s)))]
  all.forEach((id, i) => {
    if (!order.includes(id)) order.splice(i ? order.indexOf(all[i - 1]!) + 1 : 0, 0, id)
  })
  return order
}

/** `order` with `id` just before or after `target`. */
export function placed<T extends string>(order: readonly T[], id: T, target: T, after: boolean): T[] {
  const rest = order.filter((s) => s !== id)
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id)
  return rest
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement)
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p
  return null
}

/** Scrolls the body of the section headed by `header` just under it when none of it shows (between this
 * header and the next section's, sticky or not); false when some of it shows. */
function revealBody(header: HTMLElement, body: HTMLElement): boolean {
  const scroller = scrollParent(header)
  if (!scroller) return false
  const view = scroller.getBoundingClientRect()
  const h = header.getBoundingClientRect()
  const b = body.getBoundingClientRect()
  const next = header.parentElement?.nextElementSibling?.querySelector(':scope > header')
  const top = Math.max(b.top, h.bottom, view.top)
  const bottom = Math.min(b.bottom, next?.getBoundingClientRect().top ?? Infinity, view.bottom)
  if (bottom - top > 1) return false
  const stuck = parseFloat(getComputedStyle(header).top) || 0
  scroller.scrollBy({ top: b.top - (view.top + stuck + h.height) })
  return true
}

/** Scrolling list of fold sections whose headers all stay in view: each sticks below the headers before it
 * and above the headers after it, offsets measured as headers wrap or sections move. */
export function StackedSections({ children }: { children: ReactNode }): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const headers = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(':scope > section > header')]
    // Exact heights (fractional when zoomed), offsets rounded down: neighbors overlap by less than a pixel
    // rather than leave a gap showing the list behind.
    const place = (): void => {
      const all = headers().map((h) => [h, h.getBoundingClientRect().height] as const)
      let top = 0
      for (const [h, height] of all) {
        h.style.top = `${Math.floor(top)}px`
        top += height
      }
      let bottom = 0
      for (const [h, height] of all.reverse()) {
        h.style.bottom = `${Math.floor(bottom)}px`
        bottom += height
      }
    }
    const resized = new ResizeObserver(place)
    const observe = (): void => {
      resized.disconnect()
      headers().forEach((h) => resized.observe(h))
      place()
    }
    const moved = new MutationObserver(observe)
    moved.observe(el, { childList: true })
    observe()
    return () => {
      resized.disconnect()
      moved.disconnect()
    }
  }, [])
  return (
    <div ref={list} className="stacked-sections">
      {children}
    </div>
  )
}

export function FoldSection(props: {
  id: string
  /** Data type of the header drag: sections take drops of their own type only. */
  dragType: string
  /** Toggle content after the chevron. */
  title: ReactNode
  actions?: ReactNode
  className?: string
  /** Puts section `from` before or after this one. */
  onPlace: (from: string, after: boolean) => void
  /** Moves this section past its neighbor above (-1) or below (1). */
  onStep: (step: -1 | 1) => void
  onContextMenu?: (e: MouseEvent) => void
  /** A click on the header of an open section none of whose content shows scrolls to it, not folds it. */
  revealOnClick?: boolean
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(true)
  const [drop, setDrop] = useState<'before' | 'after' | null>(null)
  const body = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const dropSide = (e: DragEvent): 'before' | 'after' => {
    // A section without a box of its own (display: contents) spans its children.
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const top = r.height || !el.firstElementChild ? r.top : el.firstElementChild.getBoundingClientRect().top
    const bottom =
      r.height || !el.lastElementChild ? r.bottom : el.lastElementChild.getBoundingClientRect().bottom
    return e.clientY < (top + bottom) / 2 ? 'before' : 'after'
  }
  return (
    <section
      className={`explorer-section ${props.className ?? ''} ${open ? 'open' : ''} ${drop ? `drop-${drop}` : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(props.dragType)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDrop(dropSide(e))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
      }}
      onDrop={(e) => {
        setDrop(null)
        const from = e.dataTransfer.getData(props.dragType)
        if (!from) return
        e.preventDefault()
        if (from !== props.id) props.onPlace(from, dropSide(e) === 'after')
      }}
    >
      <header
        draggable
        title={`Drag to move the section${props.onContextMenu ? ', right click for more' : ''}`}
        onDragStart={(e) => {
          e.dataTransfer.setData(props.dragType, props.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onContextMenu={props.onContextMenu}
        onClick={(e) => {
          // The whole header folds the section, but for its controls.
          const target = e.target as Element
          if (!target.closest('button, input, select, a, label')) toggle.current?.click()
        }}
      >
        <button
          ref={toggle}
          type="button"
          className="explorer-toggle"
          aria-expanded={open}
          aria-controls={body}
          onClick={(e) => {
            const header = e.currentTarget.parentElement
            const content = document.getElementById(body)
            if (open && props.revealOnClick && header && content && revealBody(header, content)) return
            setOpen(!open)
          }}
          onKeyDown={(e) => {
            // Alt+Up / Alt+Down move the section; focus stays on its toggle.
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
            e.preventDefault()
            const button = e.currentTarget
            props.onStep(e.key === 'ArrowUp' ? -1 : 1)
            requestAnimationFrame(() => button.focus())
          }}
        >
          <span className="chevron">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          </span>
          {props.title}
        </button>
        <span className="explorer-actions">{props.actions}</span>
      </header>
      {open && <div id={body}>{props.children}</div>}
    </section>
  )
}
