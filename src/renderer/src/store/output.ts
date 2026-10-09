// Log of the Output panel: code generation, status messages and dialogs, oldest first. Also sent to
// the host's own log (the ProjectScaffold Output channel in VS Code).
import { create } from 'zustand'

export type OutputLevel = 'info' | 'warning' | 'error'
export type OutputSource = 'generation' | 'app'

export interface OutputEntry {
  id: number
  time: number
  level: OutputLevel
  source: OutputSource
  text: string
  /** Generated file the entry is about, relative to the output directory of document `doc`. */
  path?: string
  doc?: string
}

/** Entries kept: the oldest go first. */
const LIMIT = 2000

export const useOutput = create<{ entries: OutputEntry[] }>(() => ({ entries: [] }))

let nextId = 1

export const clockTime = (time: number): string => new Date(time).toTimeString().slice(0, 8)

export function log(
  level: OutputLevel,
  source: OutputSource,
  text: string,
  extra: { path?: string; doc?: string } = {}
): void {
  const entry: OutputEntry = { id: nextId++, time: Date.now(), level, source, text, ...extra }
  useOutput.setState((s) => ({ entries: [...s.entries.slice(-(LIMIT - 1)), entry] }))
  window.api.log?.(level, text)
}

export const clearOutput = (): void => useOutput.setState({ entries: [] })
