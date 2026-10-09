import { useState } from 'react'

/**
 * Local edit of `value`, reset whenever `value` changes. The reset happens while rendering (React's
 * "adjusting state when a prop changes"), not in an effect that would render the stale draft first.
 */
export function useDraft<T>(value: T): [T, (draft: T) => void] {
  const [draft, setDraft] = useState(value)
  const [source, setSource] = useState(value)
  if (!Object.is(value, source)) {
    setSource(value)
    setDraft(value)
  }
  return [draft, setDraft]
}
