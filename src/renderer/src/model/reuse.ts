// Reloading a project from its file keeps the ids of the entities it already had, so that the
// selection, the open editors and the views survive edits made to the text.

/**
 * Entity of `prev` matching each of `nextKeys`: the one with the same key (in order when several
 * share it, as overloaded methods), else the one at the same position whose key is gone (renamed).
 */
export function pair<T>(
  prev: readonly T[],
  prevKey: (e: T) => string,
  nextKeys: readonly string[]
): (T | undefined)[] {
  const byKey = new Map<string, T[]>()
  for (const e of prev) {
    const list = byKey.get(prevKey(e))
    if (list) list.push(e)
    else byKey.set(prevKey(e), [e])
  }
  const kept = new Set(nextKeys)
  const used = new Set<T>()
  const take = (e: T | undefined): T | undefined => {
    if (e === undefined || used.has(e)) return undefined
    used.add(e)
    return e
  }
  const same = nextKeys.map((k) => take(byKey.get(k)?.shift()))
  return same.map((e, i) => {
    if (e !== undefined) return e
    const at = prev[i]
    return at !== undefined && !kept.has(prevKey(at)) ? take(at) : undefined
  })
}
