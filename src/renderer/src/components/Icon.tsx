import type { ReactNode } from 'react'
import type { Access } from '@/model/types'

/** Stroked outlines on a 16×16 grid, sized by `--icon-size` (styles.css). */
const PATHS = {
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  hash: 'M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13',
  x: 'M4 4l8 8M12 4l-8 8',
  check: 'M3 8.5l3 3 7-7',
  dot: 'M8 5a3 3 0 1 0 0 6 3 3 0 1 0 0-6z',
  'chevron-right': 'M6 4l4 4-4 4',
  'chevron-down': 'M4 6l4 4 4-4',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  'arrow-left': 'M13 8H3M7 4 3 8l4 4',
  'arrow-right': 'M3 8h10M9 4l4 4-4 4',
  'selection-prev': 'M1 3h10v10h-10zM15 8H6M9 5 6 8l3 3',
  'selection-next': 'M5 3h10v10h-10zM1 8h8M7 5l3 3-3 3',
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
  states: 'M1.5 5.5h5v5h-5zM9.5 5.5h5v5h-5zM6.5 8h3M8 6.5 9.5 8 8 9.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z',
  'eye-off':
    'M2 2l12 12M6.5 3.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1M11 11.6a6 6 0 0 1-3 .9C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.7-3.2M6.6 6.6a2 2 0 0 0 2.8 2.8',
  view: 'M8 2.5 13.5 8 8 13.5 2.5 8z',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12',
  grid: 'M6 2v12M10 2v12M2 6h12M2 10h12',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9zM10.3 10.3 13.5 13.5',
  info: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 7.5v4M8 5h.01',
  output: 'M3.5 2.5h9v11h-9zM5.5 5h5M5.5 7.5h5M5.5 10h3',
  gear: 'M12.2 6.4L14.1 6.6L14.1 9.4L12.2 9.6L11.5 10.9L12.3 12.6L9.9 14L8.7 12.4L7.3 12.4L6.1 14L3.7 12.6L4.5 10.9L3.8 9.6L1.9 9.4L1.9 6.6L3.8 6.4L4.5 5.1L3.7 3.4L6.1 2L7.3 3.6L8.7 3.6L9.9 2L12.3 3.4L11.5 5.1zM8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z',
  tree: 'M3 3.5h5M5.5 3.5v9h2.5M5.5 8h2.5M10.5 8H13M10.5 12.5H13',
  folder: 'M2 4h4l1.5 1.5H14v7H2z',
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
  restore: 'M3.5 5.5h7v7h-7zM5.5 5.5v-2h7v7h-2',
  // Commands (toolbar, shell/toolbar.ts)
  'file-plus': 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M8 7v5M5.5 9.5h5',
  'file-text': 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3',
  'file-import': 'M5.5 5V1.5h4l3 3v10h-7V11M9.5 1.5v3h3M1.5 8h6M5 5.5 7.5 8 5 10.5',
  save: 'M2.5 2.5h9l2 2v9h-11zM5 2.5v3h5v-3M4.5 13.5v-4h7v4',
  'save-as': 'M8 13.5H2.5v-11h9l2 2v2M5 2.5v3h5v-3M9 14.5v-2l4-4 2 2-4 4z',
  'save-all': 'M4.5 4.5h7l2 2v7h-9zM6.5 4.5V7h4V4.5M2.5 11.5v-9h8',
  workspace: 'M1.5 2.5h13v11h-13zM5.5 2.5v11M5.5 10h9',
  'workspace-as': 'M8 13.5H1.5v-11h13v4.5M5.5 2.5v11M9 14.5v-2l4-4 2 2-4 4z',
  import: 'M8 1.5v8M5 6.5l3 3 3-3M2.5 10v3.5h11V10',
  export: 'M8 9.5v-8M5 4.5l3-3 3 3M2.5 10v3.5h11V10',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12M10.5 5a1 1 0 1 0 0 2 1 1 0 1 0 0-2z',
  vector: 'M3 11C3 6 13 10 13 5M1.5 11h3v3h-3zM11.5 2h3v3h-3z',
  scissors: 'M4.5 3a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM4.5 9a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM6.2 6 14 12M6.2 10 14 4',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  clipboard: 'M3.5 3h9v11.5h-9zM6 1.5h4v3H6zM5.5 8h5M5.5 10.5h5',
  duplicate: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3M9.5 7.5v4M7.5 9.5h4',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.75 10h6.5L12 4M6.75 6.5v5M9.25 6.5v5',
  'select-all':
    'M2.5 4.5v-2h2M6.5 2.5h3M11.5 2.5h2v2M13.5 6.5v3M13.5 11.5v2h-2M9.5 13.5h-3M4.5 13.5h-2v-2M2.5 9.5v-3M5.5 5.5h5v5h-5z',
  pencil: 'M2.5 13.5l.75-3L11 2.75 13.25 5 5.5 12.75zM9.5 4.25 11.75 6.5',
  module: 'M2 3h12v10H2zM2 6h12',
  submodule: 'M1.5 2.5h13v11h-13zM1.5 5h13M4.5 7.5h7v4h-7z',
  'port-in': 'M8.5 2.5h5v11h-5zM1.5 8h6M5 5.5 7.5 8 5 10.5',
  'port-out': 'M2.5 2.5h5v11h-5zM8.5 8h6M12 5.5l2.5 2.5-2.5 2.5',
  note: 'M2.5 2.5h11v7l-4 4h-7zM13.5 9.5h-4v4M5 5.5h6M5 8h4',
  frame: 'M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M5.5 6h5',
  link: 'M6.5 9.5l3-3M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8M5.5 8 4 9.5a2.5 2.5 0 0 0 3.5 3.5L9 11.5',
  package: 'M8 1.5l6 3v7l-6 3-6-3v-7zM2 4.5l6 3 6-3M8 7.5v7M5 3l6 3',
  command: 'M1.5 2.5h13v11h-13zM4.5 6l2 2-2 2M8 10.5h3.5',
  target: 'M8 3a5 5 0 1 0 0 10A5 5 0 1 0 8 3zM8 1.5v3.5M8 11v3.5M1.5 8H5M11 8h3.5',
  'fit-all': 'M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M5 5h3v3H5zM8.5 8.5H11V11H8.5z',
  'zoom-in': 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9zM10.3 10.3l3.2 3.2M5 7h4M7 5v4',
  'zoom-out': 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9zM10.3 10.3l3.2 3.2M5 7h4',
  'zoom-reset': 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9zM10.3 10.3l3.2 3.2M5 6h4M5 8h4',
  split: 'M1.5 2.5h13v11h-13zM8 2.5v11',
  pin: 'M5.5 1.5h5M6.75 1.5v4L4.5 9h7L9.25 5.5v-4M8 9v5.5',
  'view-plus': 'M8 2.5 13.5 8 8 13.5 2.5 8zM8 5.75v4.5M5.75 8h4.5',
  'rotate-ccw': 'M2.5 2.5V6H6M2.9 6A5.5 5.5 0 1 1 3 10.5',
  wrap: 'M2 4h12M2 8h10a2 2 0 0 1 0 4H8M9.5 10.5 8 12l1.5 1.5M2 12h3.5',
  'auto-layout': 'M6 2h4v3H6zM2 11h4v3H2zM10 11h4v3h-4zM8 5v3M4 8h8M4 8v3M12 8v3',
  'auto-layout-all':
    'M1.5 4.5v-3h3M11.5 1.5h3v3M14.5 11.5v3h-3M4.5 14.5h-3v-3M6.5 4h3v2h-3zM4 10h3v2H4zM9 10h3v2H9zM8 6v2M5.5 8h5M5.5 8v2M10.5 8v2',
  'layout-h': 'M1.5 5h4v6h-4zM10.5 5h4v6h-4zM5.5 8h5M8.5 6l2 2-2 2',
  'layout-v': 'M5 1.5h6v4H5zM5 10.5h6v4H5zM8 5.5v5M6 8.5l2 2 2-2',
  group: 'M1.5 1.5h13v13h-13zM1.5 4.5h13M4 7h3.5v3H4zM8.5 9.5H12V12H8.5z',
  guides: 'M5 5h6v6H5zM5 1.5v2M5 12.5v2M1.5 11h2M12.5 11h2',
  eraser: 'M9 2.5l4.5 4.5-6.5 6.5H4.5l-2-2zM6 5.5l4.5 4.5M7 13.5h7',
  'tab-prev': 'M1.5 13.5v-9h5l1 2h7v7zM11 10H5M7 8l-2 2 2 2',
  'tab-next': 'M1.5 13.5v-9h5l1 2h7v7zM5 10h6M9 8l2 2-2 2',
  'layout-reset': 'M6.5 13.5h-5v-11h13v5M5.5 2.5v11M11.5 9a3 3 0 1 1-2.9 2.25M8.5 8.5v2.75h2.75',
  'layout-full':
    'M1.5 2.5h13v11h-13zM4.5 5.5l2 2M4.5 5.5h2M4.5 5.5v2M11.5 10.5l-2-2M11.5 10.5h-2M11.5 10.5v-2',
  keyboard: 'M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7',
  'database-x':
    'M2.5 4c0-1.4 2.5-2 5-2s5 .6 5 2-2.5 2-5 2-5-.6-5-2zM2.5 4v8c0 1.4 2.5 2 5 2M12.5 4v4M2.5 8c0 1.4 2.5 2 5 2M10 10.5l4 4M14 10.5l-4 4',
  help: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.5M8 11.5h.01'
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

/** Icons of the UML access marks (`+ # -`). */
export const ACCESS_ICONS: Record<Access, IconName> = { public: 'plus', protected: 'hash', private: 'minus' }

/** UML access mark of a type, constant, attribute or method, as an icon. */
export function AccessIcon({ access }: { access: Access | undefined }): ReactNode {
  return <Icon name={ACCESS_ICONS[access ?? 'public']} />
}
