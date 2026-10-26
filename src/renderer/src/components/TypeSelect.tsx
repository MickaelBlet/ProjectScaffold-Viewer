import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { TYPE_KIND_BADGE } from './fields'
import { kindClass } from './typeColor'

/** Letters and titles of the kinds a type reference names besides the kinds of types (`typeColorKind`). */
const OTHER_BADGES: Record<string, { letter: string; title: string }> = {
  builtin: { letter: 'P', title: 'built-in primitive' },
  container: { letter: '<>', title: 'container' },
  mod: { letter: 'M', title: 'module' }
}

/**
 * Badge of a kind (that of the Explorer), as named by `typeColorKind`; none without a kind. `color`: that of
 * a module, over the color of its kind.
 */
export function KindBadge(props: { kind: string | undefined; color?: string }): ReactNode {
  const { kind, color } = props
  if (!kind) return <span className="kind-badge none" />
  const other = OTHER_BADGES[kind]
  const letter = other?.letter ?? TYPE_KIND_BADGE[kind as keyof typeof TYPE_KIND_BADGE] ?? '?'
  return (
    <span
      className={`kind-badge ${kind}`}
      title={other?.title ?? kind}
      style={color ? { background: color } : undefined}
    >
      {letter}
    </span>
  )
}

export interface TypeOption {
  value: string
  label: string
  /** Kind the option is colored and badged after (`typeColorKind`). */
  kind?: string
  /** Color of the badge: that of a module. */
  color?: string
}

/** Options under a heading; none without a label. */
export interface TypeOptionGroup {
  label?: string
  options: TypeOption[]
}

/** Characters typed in a row to jump to an option, forgotten after this pause (ms). */
const TYPEAHEAD_MS = 600
/** Options a Page Up / Page Down moves by. */
const PAGE = 10

/**
 * Drop-down list of types, each option with the badge of its kind: a native `<select>` cannot show them.
 * The focus stays on the button (the active option is its `aria-activedescendant`); the list is drawn over
 * the page, not to be clipped by a scrolling panel.
 */
export function TypeSelect(props: {
  value: string
  groups: TypeOptionGroup[]
  onChange: (value: string) => void
}): ReactNode {
  const { value, groups, onChange } = props
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const typed = useRef({ text: '', at: 0 })
  const options = groups.flatMap((g) => g.options)
  const currentIndex = options.findIndex((o) => o.value === value)
  const current = options[currentIndex]
  // Index of the first option of each group.
  const starts = groups.map((_, i) => groups.slice(0, i).reduce((n, g) => n + g.options.length, 0))

  const show = (index = currentIndex): void => {
    setActive(Math.max(0, index))
    setStyle({ visibility: 'hidden' })
    setOpen(true)
  }
  const pick = (o: TypeOption | undefined): void => {
    setOpen(false)
    if (o && o.value !== value) onChange(o.value)
  }

  // Below the button, or above it when there is more room there.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return
    const r = button.current.getBoundingClientRect()
    const height = list.current.scrollHeight
    const below = window.innerHeight - r.bottom - 6
    const above = r.top - 6
    const down = below >= Math.min(height, 240) || below >= above
    setStyle({
      left: r.left,
      minWidth: r.width,
      maxWidth: Math.max(r.width, window.innerWidth - r.left - 4),
      maxHeight: down ? below : above,
      ...(down ? { top: r.bottom + 2 } : { bottom: window.innerHeight - r.top + 2 })
    })
  }, [open])

  useLayoutEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, style])

  // Closed by a click elsewhere, a scroll (the list would part from its button), leaving the window.
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!button.current?.contains(t) && !list.current?.contains(t)) close()
    }
    const onScroll = (e: Event): void => {
      if (!list.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])

  /** Next option after the active one whose label starts with what was typed in a row (`now`: event time). */
  const typeahead = (key: string, now: number): number => {
    const t = typed.current
    t.text = now - t.at < TYPEAHEAD_MS ? t.text + key.toLowerCase() : key.toLowerCase()
    t.at = now
    const from = open ? active : Math.max(0, currentIndex)
    // A repeated letter (or a single one) cycles through the options it starts, from the next one.
    const cycle = [...t.text].every((c) => c === t.text[0])
    const prefix = cycle ? t.text[0]! : t.text
    for (let i = 0; i < options.length; i++) {
      const k = (from + (cycle ? 1 : 0) + i) % options.length
      if (options[k]!.label.toLowerCase().startsWith(prefix)) return k
    }
    return -1
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const n = options.length
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        show()
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = typeahead(e.key, e.timeStamp)
        if (k >= 0) show(k)
      }
      return
    }
    const move: Partial<Record<string, number>> = {
      ArrowDown: Math.min(n - 1, active + 1),
      ArrowUp: Math.max(0, active - 1),
      PageDown: Math.min(n - 1, active + PAGE),
      PageUp: Math.max(0, active - PAGE),
      Home: 0,
      End: n - 1
    }
    if (e.key in move) {
      e.preventDefault()
      setActive(move[e.key]!)
    } else if (e.key === 'Enter' || (e.key === ' ' && e.timeStamp - typed.current.at >= TYPEAHEAD_MS)) {
      e.preventDefault()
      pick(options[active])
    } else if (e.key === 'Escape') {
      // Not to close the dialog or deselect behind it.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const k = typeahead(e.key, e.timeStamp)
      if (k >= 0) setActive(k)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        className={`type-select ${kindClass(current?.kind)}`}
        title={current?.label}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <KindBadge kind={current?.kind} color={current?.color} />
        <span className="type-select-label">{current?.label}</span>
        <Icon name="chevron-down" />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="listbox"
            className="type-select-list"
            style={style}
            // The focus stays on the button; React ancestors of the button (rows) do not take the clicks.
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {groups.map((g, gi) => (
              <div key={gi} role="group" aria-label={g.label}>
                {g.label && (
                  <div className="type-select-group" aria-hidden>
                    {g.label}
                  </div>
                )}
                {g.options.map((o, oi) => {
                  const i = starts[gi]! + oi
                  return (
                    <div
                      key={o.value}
                      id={`${id}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={o.value === value}
                      className={`type-select-option ${i === active ? 'active' : ''} ${kindClass(o.kind)}`}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => {
                        pick(o)
                        button.current?.focus()
                      }}
                    >
                      <KindBadge kind={o.kind} color={o.color} />
                      <span className="type-select-label">{o.label}</span>
                      {o.value === value && <Icon name="check" />}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
