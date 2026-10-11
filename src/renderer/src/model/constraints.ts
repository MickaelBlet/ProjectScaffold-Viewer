// Constraints of fields and attributes (bounds, unit, pattern) and the ownership of the modules
// they reference: checked against their type and their default value.
import { resolve, type IsModule } from './defaults'
import { walkTypeRef } from './typeExpr'
import {
  INT_PRIMITIVES,
  INT_RANGES,
  type Constraints,
  type Id,
  type IntPrimitive,
  type Primitive,
  type TypeDef,
  type TypeRef,
  type Value
} from './types'

/**
 * What constraints apply to in a type: its value, or each item of an array, vector, list, set or
 * optional, aliases followed. A primitive's name, `enum` / `bitmask` for those, else `other`.
 */
export function constrainedScalar(
  t: TypeRef,
  types: readonly TypeDef[]
): Primitive | 'enum' | 'bitmask' | 'other' {
  const byId = new Map(types.map((d) => [d.id, d]))
  let cur: TypeRef = t
  for (;;) {
    const r = resolve(cur, byId)
    if (!r) return 'other'
    if ('id' in r && 'kind' in r && (r.kind === 'enum' || r.kind === 'bitmask')) return r.kind
    if (r.kind === 'primitive' && !('id' in r)) return r.name
    if (
      r.kind === 'array' ||
      r.kind === 'vector' ||
      r.kind === 'list' ||
      r.kind === 'set' ||
      r.kind === 'optional'
    )
      cur = r.of
    else return 'other'
  }
}

const isInt = (s: string): s is IntPrimitive => (INT_PRIMITIVES as readonly string[]).includes(s)
const isNumber = (s: string): boolean => isInt(s) || s === 'float32' || s === 'float64'
const isText = (s: string): boolean => s === 'string' || s === 'char'

/** Whether a pattern compiles: the reason when not. */
export function patternError(pattern: string): string | null {
  try {
    new RegExp(pattern, 'u')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Errors of constraints set on a field of type `t`. */
export function constraintErrors(c: Constraints, t: TypeRef, types: readonly TypeDef[]): string[] {
  const errors: string[] = []
  const scalar = constrainedScalar(t, types)
  const bounds = (['min', 'max'] as const).filter((k) => c[k] !== undefined)
  if ((bounds.length || c.unit) && !isNumber(scalar)) errors.push('min, max and unit apply to numbers')
  else if (isInt(scalar)) {
    const [lo, hi] = INT_RANGES[scalar]
    for (const k of bounds) {
      const v = c[k]!
      if (!Number.isInteger(v)) errors.push(`${k} of an integer is an integer`)
      else if (BigInt(v) < lo || BigInt(v) > hi) errors.push(`${k} ${v} is out of the range of ${scalar}`)
    }
  }
  if (c.min !== undefined && c.max !== undefined && c.min > c.max)
    errors.push(`min ${c.min} is above max ${c.max}`)
  if (c.pattern !== undefined) {
    if (!isText(scalar)) errors.push('pattern applies to text')
    else {
      const e = patternError(c.pattern)
      if (e) errors.push(`invalid pattern: ${e}`)
    }
  }
  return errors
}

/** Errors of a value (a default) against constraints: each item of a list, the value of an optional. */
export function constraintValueErrors(v: Value, c: Constraints): string[] {
  const errors: string[] = []
  const pattern =
    c.pattern !== undefined && !patternError(c.pattern) ? new RegExp(`^(?:${c.pattern})$`, 'u') : null
  const unit = c.unit ? ` ${c.unit}` : ''
  const check = (x: Value): void => {
    if (Array.isArray(x)) return x.forEach(check)
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^-?\d+$/.test(x) ? Number(x) : null
    if (n !== null) {
      if (c.min !== undefined && n < c.min) errors.push(`${n}${unit} is below min ${c.min}${unit}`)
      if (c.max !== undefined && n > c.max) errors.push(`${n}${unit} is above max ${c.max}${unit}`)
    }
    if (typeof x === 'string' && pattern && !pattern.test(x))
      errors.push(`'${x}' does not match ${c.pattern}`)
  }
  check(v)
  return errors
}

/** Modules a type references (as types), by id. */
export function moduleRefs(t: TypeRef, isModule: IsModule): Id[] {
  const out: Id[] = []
  walkTypeRef(t, (n) => {
    if (n.kind === 'ref' && isModule(n.id) && !out.includes(n.id)) out.push(n.id)
  })
  return out
}

/** UML multiplicity of the modules a type references: `1`, `0..1` (optional), `*` (containers). */
export function multiplicity(t: TypeRef): string {
  if (t.kind === 'optional') return t.of.kind === 'ref' ? '0..1' : multiplicity(t.of)
  if (t.kind === 'array') return String(t.size)
  if (t.kind === 'vector' || t.kind === 'list' || t.kind === 'set' || t.kind === 'map') return '*'
  return '1'
}
