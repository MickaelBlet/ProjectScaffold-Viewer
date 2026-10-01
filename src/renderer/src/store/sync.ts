// Changes made in a document reach the open documents depending on it: its renames of modules,
// ports, types and interfaces, then its types, interfaces and placed modules as they are now. Each
// document gets the change as an undoable edit of its own; closed files catch up on Refresh.
import { produce } from 'immer'
import { applyDependencyRenames, refreshDependencies } from '@/model/dependencies'
import { baseName, diffRenames, sameFile } from '@/model/sync'
import type { Id, Project } from '@/model/types'
import { docTitle } from '@/fileOps'
import { findDoc, projectListeners, useDocs } from './documents'
import { setStatus } from './ui'

function carryRenames(docId: Id, prev: Project, next: Project): void {
  const file = findDoc(docId)?.filePath ?? null
  if (!file) return
  // What dependents read: definitions, modules and ports, and the dependencies carried along.
  if (
    prev.types === next.types &&
    prev.interfaces === next.interfaces &&
    prev.consts === next.consts &&
    prev.modules === next.modules &&
    prev.dependencies === next.dependencies
  )
    return
  const linked = useDocs
    .getState()
    .docs.filter(
      (d) => d.id !== docId && d.store.getState().project.dependencies.some((x) => sameFile(x.file, file))
    )
  if (!linked.length) return

  const renames = diffRenames(prev, next)
  const updated: string[] = []
  const conflicts: string[] = []
  for (const d of linked) {
    const p = d.store.getState().project
    const q = produce(p, (draft) => {
      if (renames) applyDependencyRenames(draft, file, renames)
      const dep = draft.dependencies.find((x) => sameFile(x.file, file))!
      const self = d.filePath ? baseName(d.filePath) : null
      conflicts.push(...refreshDependencies(draft, new Map([[dep.id, next]]), self).conflicts)
    })
    if (q === p) continue
    d.store.setState({ project: q })
    updated.push(docTitle(d))
  }
  if (conflicts.length) return setStatus('error', `Not taken from this project: ${conflicts.join('; ')}`)
  if (updated.length && renames) setStatus('info', `Renamed in dependent documents: ${updated.join(', ')}`)
}

/** Carry renames to the linked documents from now on. */
export function installRenameSync(): () => void {
  projectListeners.add(carryRenames)
  return () => void projectListeners.delete(carryRenames)
}
