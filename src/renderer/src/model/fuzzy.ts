// Fuzzy matching for the command palette: query characters in order, rewarding consecutive
// matches and word starts.

export interface FuzzyMatch {
  score: number
  /** Indexes of the matched characters in the text. */
  positions: number[]
}

const isWordStart = (text: string, i: number): boolean =>
  i === 0 || /[\s._\-/:>(]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!))

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const t = text.toLowerCase()
  const positions: number[] = []
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    // Prefer a word start ahead, else the next occurrence.
    let i = t.indexOf(ch, from)
    if (i < 0) return null
    for (let j = i; j >= 0 && j < t.length; j = t.indexOf(ch, j + 1)) {
      if (j === prev + 1 || isWordStart(text, j)) {
        i = j
        break
      }
    }
    score += 1
    if (i === prev + 1) score += 5
    if (isWordStart(text, i)) score += 3
    positions.push(i)
    prev = i
    from = i + 1
  }
  if (t.startsWith(q)) score += 10
  score -= (text.length - q.length) * 0.05
  return { score, positions }
}

/** Items matching the query, best first. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  text: (item: T) => string
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = []
  for (const item of items) {
    const match = fuzzyMatch(query, text(item))
    if (match) out.push({ item, match })
  }
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score)
  return out
}
