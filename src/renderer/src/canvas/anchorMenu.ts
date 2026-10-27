// Menu choosing where the end of a link or inheritance line attaches on its module.
import type { BaseRoute, LinkAnchor, Side } from '@/model/types'
import type { MenuItem } from '@/store/ui'

const SIDES: [Side, string][] = [
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['left', 'Left'],
  ['right', 'Right']
]

/** Items attaching an end automatically (`auto`: its label), or at the middle of a side of its module. */
export function anchorItems(
  current: LinkAnchor | undefined,
  auto: string,
  set: (anchor: LinkAnchor | undefined) => void
): MenuItem[] {
  return [
    { label: auto, checked: !current, run: () => set(undefined) },
    'separator',
    ...SIDES.map(([side, label]): MenuItem => ({
      label,
      checked: current?.side === side,
      title: 'At the middle of the side',
      run: () => set({ side, at: 0.5 })
    }))
  ]
}

/**
 * Items of the menu of a link or inheritance line shaped as `route`: a submenu per end (`labels`),
 * putting the attachments back automatically, and resetting the shape.
 */
export function attachItems(
  route: BaseRoute | undefined,
  labels: [string, string],
  auto: string,
  set: (route: BaseRoute | undefined) => void
): MenuItem[] {
  const base = route ?? { points: [] }
  return [
    ...(['from', 'to'] as const).map((which, i): MenuItem => ({
      label: labels[i]!,
      submenu: anchorItems(base[which], auto, (a) => set({ ...base, [which]: a }))
    })),
    ...(route?.from || route?.to
      ? [{ label: 'Reset attachments', run: () => set({ ...base, from: undefined, to: undefined }) }]
      : []),
    ...(route ? [{ label: 'Reset shape', run: () => set(undefined) }] : [])
  ]
}
