// Type parameters of a generic module, and the type arguments of its generic bases.
import type { ReactNode } from 'react'
import { IDENTIFIER_RE, memberNames, newId, typeParamsOf, uniqueName } from '@/model/project'
import { parseTypeExpr, printTypeRef, mapTypeRef, TypeExprError } from '@/model/typeExpr'
import {
  TYPE_CONSTRAINTS,
  type Id,
  type Module,
  type PrimitiveDef,
  type Project,
  type TypeRef
} from '@/model/types'
import { update } from '@/store/project'
import { CommitInput, IconButton, Section, Select } from '@/components/fields'
import { TypeEditor, useTypeScope } from '@/components/TypeEditor'
import { Icon } from '@/components/Icon'

const withParam = (pid: Id, fn: (t: PrimitiveDef) => void): void =>
  update((d) => {
    const t = d.types.find((x) => x.id === pid)
    if (t?.kind === 'primitive' && t.typeParam) fn(t)
  })

export function TypeParamsSection(props: { mod: Module; project: Project }): ReactNode {
  const { mod, project } = props
  const params = typeParamsOf(project, mod.id)
  const modules = project.modules.filter((m) => m.id !== mod.id)
  return (
    <Section
      title={`Type parameters (${params.length})`}
      actions={
        <button
          type="button"
          title="Makes the module generic: Box<T>"
          onClick={() =>
            update((d) => {
              const taken = [
                ...d.types.filter((t) => t.module === mod.id).map((t) => t.name),
                ...memberNames(d, mod)
              ]
              d.types.push({
                id: newId(),
                kind: 'primitive',
                name: uniqueName('T', taken),
                description: '',
                module: mod.id,
                access: 'private',
                typeParam: {}
              })
            })
          }
        >
          <Icon name="plus" /> parameter
        </button>
      }
    >
      {params.map((t) => {
        const tp = t.typeParam!
        return (
          <div key={t.id} className="type-param">
            <div className="row-inline">
              <CommitInput
                value={t.name}
                validate={(n) => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')}
                onCommit={(n) => withParam(t.id, (x) => void (x.name = n))}
              />
              <Select
                value={tp.constraint ?? ''}
                options={[
                  { value: '', label: 'any type' },
                  ...TYPE_CONSTRAINTS.map((c) => ({ value: c, label: c }))
                ]}
                onChange={(v) =>
                  withParam(t.id, (x) => {
                    if (v) x.typeParam!.constraint = v
                    else delete x.typeParam!.constraint
                  })
                }
              />
              <Select
                value={tp.derivesFrom ?? ''}
                options={[
                  { value: '', label: 'any module' },
                  ...modules.map((m) => ({ value: m.id, label: `derives from ${m.name}` }))
                ]}
                onChange={(v) =>
                  withParam(t.id, (x) => {
                    if (v) x.typeParam!.derivesFrom = v
                    else delete x.typeParam!.derivesFrom
                  })
                }
              />
              <IconButton
                icon="x"
                title="Delete type parameter (its uses become unknown types)"
                danger
                onClick={() => update((d) => void (d.types = d.types.filter((x) => x.id !== t.id)))}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={!!tp.default}
                onChange={(e) =>
                  withParam(t.id, (x) => {
                    if (e.target.checked) x.typeParam!.default = { kind: 'primitive', name: 'int32' }
                    else delete x.typeParam!.default
                  })
                }
              />
              Default
            </label>
            {tp.default && (
              <TypeEditor
                value={tp.default}
                onChange={(v) => withParam(t.id, (x) => void (x.typeParam!.default = v))}
              />
            )}
          </div>
        )
      })}
      {!params.length && <p className="muted">Not generic.</p>}
    </Section>
  )
}

/** Type arguments of a generic base, as text: `int32, Vec3`. */
export function BaseArgs(props: { mod: Module; base: Id; project: Project }): ReactNode {
  const { mod, base, project } = props
  const { nameOf, idOf } = useTypeScope()
  const params = typeParamsOf(project, base)
  if (!params.length) return null
  const args = mod.baseArgs?.[base] ?? []
  const text = args.map((a) => printTypeRef(a, nameOf)).join(', ')
  const parse = (s: string): TypeRef[] => {
    if (!s.trim()) return []
    const t = parseTypeExpr(`Base<${s}>`)
    return (t.kind === 'ref' ? (t.args ?? []) : []).map((a) =>
      mapTypeRef(a, (r) => {
        const id = idOf(r.name)
        if (!id) throw new TypeExprError(`Unknown type '${r.name}'`)
        return { kind: 'ref', id }
      })
    )
  }
  return (
    <CommitInput
      value={text}
      placeholder={params.map((t) => t.name).join(', ')}
      title="Type arguments"
      validate={(s) => {
        try {
          parse(s)
          return null
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
      }}
      onCommit={(s) =>
        update((d) => {
          const m = d.modules.find((x) => x.id === mod.id)
          if (!m) return
          const list = parse(s)
          m.baseArgs ??= {}
          if (list.length) m.baseArgs[base] = list
          else delete m.baseArgs[base]
          if (!Object.keys(m.baseArgs).length) delete m.baseArgs
        })
      }
    />
  )
}
