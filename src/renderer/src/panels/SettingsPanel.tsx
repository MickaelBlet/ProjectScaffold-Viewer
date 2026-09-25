import type { ReactNode } from 'react'
import {
  applyTheme,
  DEFAULT_SETTINGS,
  setSetting,
  useSettings,
  type EdgeStyle,
  type Theme
} from '@/store/settings'
import { Row, Section, Select } from '@/components/fields'
import { resetLayout } from '@/shell/controllers'

function Check(props: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}): ReactNode {
  return (
    <label className="check" title={props.hint}>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  )
}

export function SettingsPanel(): ReactNode {
  const s = useSettings()
  return (
    <div className="inspector settings">
      <Section title="Appearance">
        <Row label="Theme">
          <Select
            value={s.theme}
            options={['system', 'light', 'dark'] as Theme[]}
            onChange={(t) => {
              setSetting('theme', t)
              applyTheme(t)
            }}
          />
        </Row>
        <Row label="Link style">
          <Select
            value={s.edgeStyle}
            options={['bezier', 'smoothstep', 'step', 'straight'] as EdgeStyle[]}
            onChange={(v) => setSetting('edgeStyle', v)}
          />
        </Row>
        <Check
          label="Link badges (direction, ACK, class, transport)"
          value={s.edgeBadges}
          onChange={(v) => setSetting('edgeBadges', v)}
        />
        <Check
          label="Auto-orient link ends"
          hint="Links leave from the module side facing their other end"
          value={s.autoOrientLinks}
          onChange={(v) => setSetting('autoOrientLinks', v)}
        />
        <Check label="Minimap" value={s.minimap} onChange={(v) => setSetting('minimap', v)} />
      </Section>
      <Section title="Editing">
        <Check label="Snap to grid" value={s.snapToGrid} onChange={(v) => setSetting('snapToGrid', v)} />
        <Row label="Grid size">
          <input
            type="number"
            min={5}
            max={100}
            step={5}
            value={s.gridSize}
            onChange={(e) => setSetting('gridSize', Math.max(5, Math.min(100, Number(e.target.value) || 20)))}
          />
        </Row>
        <Check
          label="Alignment guides while dragging"
          value={s.guides}
          onChange={(v) => setSetting('guides', v)}
        />
        <Check
          label="Arrange files without layout when opening"
          value={s.autoLayoutOnOpen}
          onChange={(v) => setSetting('autoLayoutOnOpen', v)}
        />
      </Section>
      <div className="actions">
        <button type="button" onClick={resetLayout}>
          Reset panel layout
        </button>
        <button
          type="button"
          onClick={() => {
            useSettings.setState({ ...DEFAULT_SETTINGS })
            applyTheme(DEFAULT_SETTINGS.theme)
          }}
        >
          Restore defaults
        </button>
      </div>
    </div>
  )
}
