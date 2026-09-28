import { useId, type ReactNode } from 'react'
import { useUiStore } from '@/store/ui'

const REPO = 'https://github.com/MickaelBlet/ProjectScaffold'

export function AboutDialog(): ReactNode {
  const open = useUiStore((s) => s.aboutOpen)
  const titleId = useId()
  if (!open) return null
  const close = (): void => useUiStore.setState({ aboutOpen: false })
  return (
    <div className="modal-backdrop" onClick={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div
        className="modal about"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>ProjectScaffold</h3>
        <p className="muted">Version {__APP_VERSION__}</p>
        <p>Software architecture editor exporting YAML/JSON for code skeleton generators.</p>
        <p className="muted">© Mickaël Blet · MIT License</p>
        <p>
          <a href={REPO} target="_blank" rel="noreferrer">
            {REPO.replace('https://', '')}
          </a>
        </p>
        <button type="button" autoFocus onClick={close}>
          Close
        </button>
      </div>
    </div>
  )
}
