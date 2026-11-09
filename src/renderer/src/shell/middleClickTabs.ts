/** Tabs closed by a middle click: dock tabs (dockview, tool tabs) and document tabs. */
const TABS = '.dv-tab, .doc-tab'

/**
 * A middle press on a tab starts the browser's autoscroll in the scrollable tab bars (Chromium on
 * Windows), which swallows the release the tabs close on: it is prevented on tabs.
 */
export function installMiddleClickTabs(): void {
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 1 && (e.target as Element | null)?.closest?.(TABS)) e.preventDefault()
    },
    true
  )
}
