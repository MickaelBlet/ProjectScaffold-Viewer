import { defineModule, registerModules } from 'dockview-react'

/**
 * The tab overflow dropdown of every dock group lists all its tabs, not only the hidden ones
 * (dockview's own list): rows come from dockview, only the list changes.
 */
const AllTabsOverflow = defineModule({
  name: 'AllTabsOverflow',
  serviceKey: 'advancedOverflowService',
  create: () => ({
    renderOverflow: ({ group, context }) => {
      const body = document.createElement('div')
      body.className = 'dv-tabs-overflow-container'
      body.style.overflow = 'auto'
      for (const panel of group.panels) {
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
