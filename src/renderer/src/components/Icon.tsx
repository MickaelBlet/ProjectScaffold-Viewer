import type { ReactNode } from 'react'

/** Stroked outlines on a 16×16 grid, sized by `--icon-size` (styles.css). */
const PATHS = {
  plus: 'M8 3v10M3 8h10',
  x: 'M4 4l8 8M12 4l-8 8',
  check: 'M3 8.5l3 3 7-7',
  dot: 'M8 5a3 3 0 1 0 0 6 3 3 0 1 0 0-6z',
  'chevron-right': 'M6 4l4 4-4 4',
  'chevron-down': 'M4 6l4 4 4-4',
  'arrow-left': 'M13 8H3M7 4 3 8l4 4',
  'arrow-right': 'M3 8h10M9 4l4 4-4 4',
  'arrow-left-right': 'M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3',
  'arrow-up': 'M8 13V3M4 7l4-4 4 4',
  'arrow-down': 'M8 3v10M4 9l4 4 4-4',
  'arrow-up-right': 'M5 11l6-6M6 5h5v5',
  binary: 'M2.5 3.5h11v9h-11zM2.5 6h11M5 8.5l1.5 1.5L5 11.5M8 11.5h3',
  'level-up': 'M13 13H8a3 3 0 0 1-3-3V3M2 6l3-3 3 3',
  'open-tab': 'M12 9v3.5H3.5V4H7M9 3h4v4M13 3 8 8',
  code: 'M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9 3 7 13',
  expand: 'M9 3h4v4M13 3 9 7M7 13H3V9M3 13l4-4',
  undo: 'M6 3 3 6l3 3M3 6h6.5a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10 3l3 3-3 3M13 6H6.5a3.5 3.5 0 0 0 0 7H9',
  refresh: 'M13 3v3.5H9.5M3 13V9.5h3.5M12.6 6.5A5 5 0 0 0 3.5 5.5M3.4 9.5a5 5 0 0 0 9.1 1',
  lock: 'M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2M8 9.2a.8.8 0 1 0 0 1.6.8.8 0 1 0 0-1.6zM8 10.8v1',
  unlock:
    'M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM9.5 7.5v-3a2.5 2.5 0 0 1 5 0v1M8 9.2a.8.8 0 1 0 0 1.6.8.8 0 1 0 0-1.6zM8 10.8v1',
  warning: 'M8 2.5 14 13H2zM8 6.5v3M8 11.5h.01',
  error: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11zM6 6l4 4M10 6l-4 4',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z',
  'eye-off':
    'M2 2l12 12M6.5 3.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1M11 11.6a6 6 0 0 1-3 .9C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.7-3.2M6.6 6.6a2 2 0 0 0 2.8 2.8',
  view: 'M8 2.5 13.5 8 8 13.5 2.5 8z',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12',
  arrange: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  grid: 'M6 2v12M10 2v12M2 6h12M2 10h12',
  tree: 'M3 3.5h5M5.5 3.5v9h2.5M5.5 8h2.5M10.5 8H13M10.5 12.5H13',
  folder: 'M2 4h4l1.5 1.5H14v7H2z',
  templates: 'M3.5 2h6l3 3v9h-9zM9.5 2v3h3M6.5 7.5 5 9l1.5 1.5M9.5 7.5 11 9l-1.5 1.5',
  play: 'M5 3.5v9l7-4.5z',
  'collapse-all': 'M2.5 2.5h11v11h-11zM5.5 8h5',
  'expand-all': 'M2.5 2.5h11v11h-11zM5.5 8h5M8 5.5v5',
  'fold-all': 'M2.5 8h11M5 2.5l3 3 3-3M5 13.5l3-3 3 3',
  'unfold-all': 'M2.5 8h11M5 5.5l3-3 3 3M5 10.5l3 3 3-3',
  'align-left': 'M2.5 2v12M5 4.5h7v3H5zM5 9.5h4v3H5z',
  'align-hcenter': 'M8 2v2.5M8 7.5v2M8 12.5V14M4 4.5h8v3H4zM5.5 9.5h5v3h-5z',
  'align-right': 'M13.5 2v12M4 4.5h7v3H4zM7 9.5h4v3H7z',
  'align-top': 'M2 2.5h12M4.5 5h3v7h-3zM9.5 5h3v4h-3z',
  'align-vcenter': 'M2 8h2.5M7.5 8h2M12.5 8H14M4.5 4h3v8h-3zM9.5 5.5h3v5h-3z',
  'align-bottom': 'M2 13.5h12M4.5 4h3v7h-3zM9.5 7h3v4h-3z',
  'distribute-h': 'M2.5 2v12M13.5 2v12M6.5 5h3v6h-3z',
  'distribute-v': 'M2 2.5h12M2 13.5h12M5 6.5h6v3H5z',
  'same-size': 'M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5z',
  minimize: 'M3 8h10',
  maximize: 'M3.5 3.5h9v9h-9z',
  restore: 'M3.5 5.5h7v7h-7zM5.5 5.5v-2h7v7h-2'
} as const

export type IconName = keyof typeof PATHS

/** Inline SVG icon drawn in the current text color. Decorative unless `title` is given. */
export function Icon({ name, title }: { name: IconName; title?: string }): ReactNode {
  return (
    <svg
      className={`ico ico-${name}`}
      viewBox="0 0 16 16"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  )
}
