// Renames made in a document are carried to the open documents linked to it: those importing it
// (module, port and interface renames) and those it imports (interface renames). Each document
// gets the change as an undoable edit of its own; closed files catch up on Refresh.
import { produce } from 'immer'
import { applySourceRenames, diffRenames, renameInterfaces, sameFile } from '@/model/sync'
import type { Id, Project } from '@/model/types'
import { docTitle } from '@/fileOps'
import { findDoc, projectListeners, useDocs } from './documents'
import { setStatus } from './ui'

function carryRenames(docId: Id, prev: Project, next: Project): void {
  const doc = findDoc(docId)
  const file = doc?.filePath ?? null
  const others = useDocs.getState().docs.filter((d) => d.id !== docId)
  const importsThis = (p: Project): boolean => !!file && p.imports.some((i) => sameFile(i.file, file))
  const importedHere = (path: string | null): boolean =>
    !!path && next.imports.some((i) => sameFile(i.file, path))
  const linked = others.filter((d) => importsThis(d.store.getState().project) || importedHere(d.filePath))
  // Imported files that are not open: renamed interfaces they share are not carried there.
  const closed = next.imports.filter((i) => !others.some((d) => d.filePath && sameFile(d.filePath, i.file)))
  if (!linked.length && !closed.length) return

  const renames = diffRenames(prev, next)
  if (!renames) return
  const updated: string[] = []
  for (const d of linked) {
    const p = d.store.getState().project
    const q = produce(p, (draft) => {
      if (file && importsThis(p)) applySourceRenames(draft, file, renames)
      else renameInterfaces(draft, renames.interfaces)
    })
    if (q === p) continue
    d.store.setState({ project: q })
    updated.push(docTitle(d))
  }
  const shared = [...renames.interfaces.values()]
  const stale = closed.filter((i) =>
    i.modules.some((m) => m.ports.some((pt) => shared.includes(pt.interface ?? '')))
  )
  if (stale.length)
    setStatus(
      'info',
      `Not open, rename there too: ${stale.map((i) => i.file).join(', ')} (Refresh would restore the old name)`
    )
  else if (updated.length) setStatus('info', `Renamed in linked documents: ${updated.join(', ')}`)
}

projectListeners.add(carryRenames)
