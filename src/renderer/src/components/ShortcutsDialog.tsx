import type { ReactNode } from 'react'
import { commands, keyLabel, type Category } from '@/commands'
import { useUiStore } from '@/store/ui'

const EXTRA: [string, string][] = [
  ['Double-click canvas', 'Add module'],
  ['Double-click module name', 'Rename'],
  ['Shift + drag', 'Box selection'],
  ['Ctrl + click', 'Add to selection'],
  ['Right click', 'Context menu'],
  ['Middle click on tab', 'Close document'],
  ['Arrows / Shift + arrows', 'Move selection']
]

export function ShortcutsDialog(): ReactNode {
  const open = useUiStore((s) => s.shortcutsOpen)
  if (!open) return null
  const close = (): void => useUiStore.setState({ shortcutsOpen: false })
  const categories = [...new Set(commands.map((c) => c.category))] as Category[]
  return (
    <div className="modal-backdrop" onClick={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal shortcuts" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <div className="shortcut-columns">
          {categories.map((cat) => {
            const list = commands.filter((c) => c.category === cat && c.keys?.length && !c.hidden)
            if (!list.length) return null
            return (
              <section key={cat}>
                <h4>{cat}</h4>
                <dl>
                  {list.map((c) => (
                    <div key={c.id}>
                      <dt>{c.title}</dt>
                      <dd>
                        {c.keys!.map((k) => (
                          <kbd key={k}>{keyLabel(k)}</kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )
          })}
          <section>
            <h4>Mouse</h4>
            <dl>
              {EXTRA.map(([k, v]) => (
                <div key={k}>
                  <dt>{v}</dt>
                  <dd>
                    <kbd>{k}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <button type="button" autoFocus onClick={close}>
          Close
        </button>
      </div>
    </div>
  )
}
