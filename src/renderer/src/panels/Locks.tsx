// Locks of a module guarding its attributes (`guardedBy`), below them in the inspector.
import type { ReactNode } from 'react'
import { IDENTIFIER_RE } from '@/model/project'
import { LOCK_KINDS, type Module, type Project } from '@/model/types'
import { CommitInput, IconButton, Select } from '@/components/fields'

export function Locks(props: {
  mod: Module
  withModule: (fn: (m: Module, d: Project) => void) => void
}): ReactNode {
  const { mod, withModule } = props
  const locks = mod.locks ?? []
  if (!locks.length) return null
  const withLock = (lid: string, fn: (l: (typeof locks)[number]) => void): void =>
    withModule((m) => {
      const l = m.locks?.find((x) => x.id === lid)
      if (l) fn(l)
    })
  return (
    <>
      <h4>Locks</h4>
      <ul className="plain locks">
        {locks.map((l) => (
          <li key={l.id} className="row-inline">
            <CommitInput
              value={l.name}
              validate={(n) => (IDENTIFIER_RE.test(n) ? null : 'Must be an identifier')}
              onCommit={(n) => withLock(l.id, (x) => void (x.name = n))}
            />
            <Select
              value={l.kind}
              options={LOCK_KINDS}
              onChange={(k) => withLock(l.id, (x) => void (x.kind = k))}
            />
            <IconButton
              icon="x"
              title="Delete lock (its attributes are no longer guarded)"
              danger
              onClick={() =>
                withModule((m) => {
                  m.locks = m.locks?.filter((x) => x.id !== l.id)
                  if (!m.locks?.length) delete m.locks
                  for (const a of m.attributes) if (a.guardedBy === l.id) delete a.guardedBy
                })
              }
            />
          </li>
        ))}
      </ul>
    </>
  )
}
