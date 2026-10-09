import { defineModule, registerModules } from 'dockview-react'

/**
 * The tab overflow dropdown of every dock group lists all its tabs, not only the hidden ones
 * (dockview's own list), sorted by title: rows come from dockview, only the list changes.
 */
const AllTabsOverflow = defineModule({
  name: 'AllTabsOverflow',
  serviceKey: 'advancedOverflowService',
  create: () => ({
    renderOverflow: ({ group, context }) => {
      const body = document.createElement('div')
      body.className = 'dv-tabs-overflow-container'
      body.style.overflow = 'auto'
      const panels = [...group.panels].sort((a, b) =>
        (a.title ?? '').localeCompare(b.title ?? '', undefined, { numeric: true, sensitivity: 'base' })
      )
      for (const panel of panels) {
        const row = context.buildRow(panel.id)
        if (row) body.appendChild(row.element)
      }
      context.open(body)
    },
    dispose: () => {}
  })
})

/** Before the first dock is created: dockview reads registered modules at construction. */
export function installOverflowTabs(): void {
  registerModules([AllTabsOverflow])
}
