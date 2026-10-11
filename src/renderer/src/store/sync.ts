// Changes made in a document reach the open documents depending on it: its renames of modules,
// ports, types and interfaces, then its types, interfaces and placed modules as they are now. Each
// document gets the change as an undoable edit of its own; closed files catch up on Refresh.
import { produce } from 'immer'
import { applyDependencyRenames, refreshDependencies } from '@/model/dependencies'
import { baseName, diffRenames, isDependencyFile } from '@/model/sync'
import type { Id, Project } from '@/model/types'
import { docTitle } from '@/fileOps'
import { findDoc, projectListeners, useDocs } from './documents'
import { setStatus } from './ui'

/** Documents whose last push to their dependents left conflicts, shown in the status bar. */
const conflicted = new Set<Id>()

/** Nesting of pushes: a push changes dependents, whose listeners must not re-check conflicts. */
let pushing = 0

function carryRenames(docId: Id, prev: Project, next: Project): void {
  // What dependents read: definitions, modules and ports, and the dependencies carried along.
  if (
    prev.types === next.types &&
    prev.interfaces === next.interfaces &&
    prev.consts === next.consts &&
    prev.modules === next.modules &&
    prev.dependencies === next.dependencies
  )
    return
  // Any such change (undo included) may resolve the conflicts of other documents: a cycle broken,
  // a name defined differently here renamed or removed.
  if (!pushing)
    for (const id of conflicted) {
      if (id === docId) continue
      const doc = findDoc(id)
      if (doc) pushToDependents(id, null, doc.store.getState().project)
      else conflicted.delete(id)
    }
  pushToDependents(docId, prev, next)
}

/** The dependency of the project saved as `from` on the file at `path`. */
const dependencyOn = (
  from: string | null,
  p: Project,
  path: string
): Project['dependencies'][number] | undefined =>
  p.dependencies.find((x) => isDependencyFile(from, x.file, path))

/** Update the open documents depending on `docId`, carrying its renames since `prev` when given. */
function pushToDependents(docId: Id, prev: Project | null, next: Project): void {
  const file = findDoc(docId)?.filePath ?? null
  if (!file) return void conflicted.delete(docId)
  const linked = useDocs
    .getState()
    .docs.filter((d) => d.id !== docId && dependencyOn(d.filePath, d.store.getState().project, file))

  const renames = prev && linked.length ? diffRenames(prev, next) : null
  const updated: string[] = []
  const conflicts: string[] = []
  pushing++
  try {
    for (const d of linked) {
      const p = d.store.getState().project
      const q = produce(p, (draft) => {
        const dep = dependencyOn(d.filePath, draft, file)!
        if (renames) applyDependencyRenames(draft, dep.file, renames)
        const self = d.filePath ? baseName(d.filePath) : null
        conflicts.push(...refreshDependencies(draft, new Map([[dep.id, next]]), self).conflicts)
      })
      if (q === p) continue
      d.store.setState({ project: q })
      updated.push(docTitle(d))
    }
  } finally {
    pushing--
  }
  if (conflicts.length) {
    conflicted.add(docId)
    return setStatus('error', `Not taken from this project: ${conflicts.join('; ')}`)
  }
  if (conflicted.delete(docId))
    setStatus('info', `No more conflicts with the documents using ${baseName(file)}`)
  else if (updated.length && renames)
    setStatus('info', `Renamed in dependent documents: ${updated.join(', ')}`)
}

/** Carry renames to the linked documents from now on. */
export function installRenameSync(): () => void {
  projectListeners.add(carryRenames)
  return () => void projectListeners.delete(carryRenames)
}
