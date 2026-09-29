// Keyboard access to clickable lists (Explorer, Modules, Links, Search, Problems): the items are
// `[data-item]` elements, one of them in the tab order (roving tab index).
import type { KeyboardEvent } from 'react'

const items = (list: HTMLElement): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[data-item]')]

/**
 * On the list element: arrows, Home and End move the focus between items; Enter and Space click
 * the focused item (with the modifiers held, so Ctrl / Shift extend the selection as with a click).
 */
export function onListKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')
  if (!item || !e.currentTarget.contains(item) || e.altKey) return
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.target !== item) return
    e.preventDefault()
    const { ctrlKey, shiftKey, metaKey } = e
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey, shiftKey, metaKey }))
    return
  }
  const move = MOVES[e.key]
  if (!move) return
  // Handled here: the canvas shortcuts on the same keys (nudge) must not run.
  e.preventDefault()
  const all = items(e.currentTarget)
  all[move(all.indexOf(item), all.length)]?.focus()
}

/** Index of the item to focus, from the focused one's and the count. */
const MOVES: Partial<Record<string, (i: number, n: number) => number>> = {
  ArrowDown: (i) => i + 1,
  ArrowUp: (i) => i - 1,
  Home: () => 0,
  End: (_, n) => n - 1
}

/** Item of a list in the tab order: the first active one, else the first one. */
export function tabStop<T>(ids: readonly T[], active: (id: T) => boolean): T | undefined {
  return ids.find(active) ?? ids[0]
}
