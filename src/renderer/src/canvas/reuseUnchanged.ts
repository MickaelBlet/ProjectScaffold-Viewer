// Stable React Flow items: an edit rebuilds the nodes and edges, only the changed ones get new objects.

/** Structural equality of plain data (numbers, strings, arrays, plain objects). */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return (
    ka.length === kb.length &&
    ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  )
}

/**
 * `next`, keeping the previous object of every item whose given fields did not change (fields
 * React Flow adds, like `measured`, are not compared), and `prev` itself when nothing changed:
 * React Flow then leaves the unchanged nodes and edges alone instead of rendering them again.
 */
export function reuseUnchanged<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const byId = new Map(prev.map((x) => [x.id, x]))
  let same = prev.length === next.length
  const out = next.map((x, i) => {
    const old = byId.get(x.id)
    const kept =
      old &&
      Object.keys(x).every((k) =>
        equal((old as Record<string, unknown>)[k], (x as Record<string, unknown>)[k])
      )
        ? old
        : x
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? prev : out
}
