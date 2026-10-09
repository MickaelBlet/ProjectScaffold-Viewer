// Constants shared by the canvas components and the graph builders.
import { Position } from '@xyflow/react'
import type { PerformanceClass, Side } from '@/model/types'

/** Handle of a module itself: dragged to another module, links them through new ports. */
export const MODULE_HANDLE = 'module'

/**
 * Stacking of the canvas (zIndexMode manual): links above containers, so they show inside them,
 * but below the other modules, so the names of their ports stay readable over the links. The port
 * names of containers are drawn apart, above the links (`label`). Link badges sit with their link.
 */
export const Z = { frame: -1, container: 0, link: 500, label: 550, module: 600, note: 700 } as const

export const PERF_COLORS: Record<PerformanceClass, string> = {
  realtime: 'var(--perf-realtime)',
  low: 'var(--perf-low)',
  normal: 'var(--perf-normal)',
  bulk: 'var(--perf-bulk)'
}

export const POSITION: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom
}

export const SIDE: Record<Position, Side> = {
  [Position.Left]: 'left',
  [Position.Right]: 'right',
  [Position.Top]: 'top',
  [Position.Bottom]: 'bottom'
}

export const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }
