import { create } from 'zustand'
import { temporal } from 'zundo'
import { emptyProject } from '@/model/project'
import type { Project } from '@/model/types'

export interface ProjectState {
  project: Project
}

// Consecutive edits closer than this are merged into one undo step (typing, dragging).
const MERGE_MS = 400

/** One document's project, with its own undo history. */
export function createProjectStore(project: Project = emptyProject()) {
  return create<ProjectState>()(
    temporal(() => ({ project }), {
      partialize: (s) => ({ project: s.project }),
      equality: (a, b) => a.project === b.project,
      handleSet: (handleSet) => {
        let last = 0
        return (...args) => {
          const now = Date.now()
          // Typed as setState, but zundo passes its internal 4-argument handler.
          if (now - last > MERGE_MS) (handleSet as (...a: typeof args) => void)(...args)
          last = now
        }
      }
    })
  )
}

export type ProjectStore = ReturnType<typeof createProjectStore>
