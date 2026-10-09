// The view a canvas draws, for its nodes and links: a drill-down view has its own module rects,
// link shapes and port name sides (see viewLayout.ts).
import { createContext, useContext } from 'react'
import { findView } from '@/model/project'
import { inView } from '@/model/viewLayout'
import { GLOBAL_VIEW, type Id, type Project } from '@/model/types'
import { useProjectStore } from '@/store/project'

export const ViewContext = createContext<Id>(GLOBAL_VIEW)

/** Select from the project as the canvas's view draws it. */
export function useDrawn<T>(selector: (p: Project) => T): T {
  const viewId = useContext(ViewContext)
  return useProjectStore((s) => selector(inView(s.project, findView(s.project, viewId))))
}
