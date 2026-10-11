// Contracts of modules and methods: preconditions, postconditions and invariants, free expressions
// whose names are checked against what they may use.

/** Words of the expressions that name nothing of the project: literals, operators, usual functions. */
export const CONTRACT_WORDS = new Set([
  'true',
  'false',
  'null',
  'nullptr',
  'None',
  'and',
  'or',
  'not',
  'in',
  'is',
  'implies',
  'this',
  'self',
  'old',
  'len',
  'size',
  'length',
  'count',
  'empty',
  'abs',
  'min',
  'max',
  'sum',
  'all',
  'any',
  'exists',
  'forall',
  'contains'
])

/**
 * Names an expression uses: identifiers outside of string literals, not after `.` or `::` (members
 * of what comes before) nor numbers.
 */
export function contractNames(expression: string): string[] {
  const text = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  const names: string[] = []
  const re = /[A-Za-z_][A-Za-z0-9_]*/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index)
    // Members of what comes before, and the exponent of a number (`1e5`).
    if (/(\.|::)\s*$/.test(before) || /[0-9]$/.test(before)) continue
    if (!names.includes(m[0])) names.push(m[0])
  }
  return names
}

/** Names of an expression not in `known` nor usual words. */
export function unknownNames(expression: string, known: ReadonlySet<string>): string[] {
  return contractNames(expression).filter((n) => !known.has(n) && !CONTRACT_WORDS.has(n))
}
