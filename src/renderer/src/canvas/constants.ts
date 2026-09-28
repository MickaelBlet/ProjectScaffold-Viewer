// Constants shared by the canvas components and the graph builders.
import { Position } from '@xyflow/react'
import type { PerformanceClass, Side } from '@/model/types'

/** Id prefix of the stand-ins for modules outside a drill-down view. */
export const EXTERNAL = 'external:'

/** Handle of a module itself: dragged to another module, links them through new ports. */
export const MODULE_HANDLE = 'module'

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
