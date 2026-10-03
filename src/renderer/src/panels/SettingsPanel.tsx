import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  DEFAULT_SETTINGS,
  setSetting,
  useSettings,
  type EdgeStyle,
  type MinimapRender,
  type PortStyle,
  type Theme,
  type WhitespaceShown
} from '@/store/settings'
import { IN_VSCODE } from '@/host'
import { Row, Section, Select } from '@/components/fields'
import { resetLayout } from '@/shell/controllers'

/** Number field kept within its bounds; empty or invalid input gives the default. */
function NumberField(props: {
  value: number
  min: number
  max: number
  step: number
  fallback: number
  onChange: (v: number) => void
}): ReactNode {
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onChange={(e) =>
        props.onChange(Math.max(props.min, Math.min(props.max, Number(e.target.value) || props.fallback)))
      }
    />
  )
}

/** The filter query, lowercase; empty when everything shows. */
const Filter = createContext('')

function useShown(label: string, hint?: string): boolean {
  const f = useContext(Filter)
  return !f || [label, hint ?? ''].some((t) => t.toLowerCase().includes(f))
}

/** A section shows all its settings when its title matches the filter; empty sections hide (CSS). */
function SettingsSection(props: { title: string; children: ReactNode }): ReactNode {
  const f = useContext(Filter)
  return (
    <Filter.Provider value={props.title.toLowerCase().includes(f) ? '' : f}>
      <Section title={props.title}>{props.children}</Section>
    </Filter.Provider>
  )
}

function Field(props: { label: string; children: ReactNode }): ReactNode {
  return useShown(props.label) ? <Row label={props.label}>{props.children}</Row> : null
}

function Check(props: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}): ReactNode {
  if (!useShown(props.label, props.hint)) return null
  return (
    <label className="check" title={props.hint}>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  )
}

export function SettingsPanel(): ReactNode {
  const s = useSettings()
  const [filter, setFilter] = useState('')
  return (
    <div className="inspector settings">
      <div className="panel-filter">
        <input
          type="search"
          placeholder="Filter settings"
          aria-label="Filter settings"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <Filter.Provider value={filter.trim().toLowerCase()}>
        <SettingsSection title="Appearance">
          <Field label="Theme">
            <Select
              value={s.theme}
              options={[
                { value: 'system' as Theme, label: IN_VSCODE ? 'VS Code' : 'system' },
                { value: 'light' as Theme, label: 'light' },
                { value: 'dark' as Theme, label: 'dark' }
              ]}
              onChange={(t) => setSetting('theme', t)}
            />
          </Field>
          <Field label="Link style">
            <Select
              value={s.edgeStyle}
              options={['bezier', 'smoothstep', 'step', 'straight'] as EdgeStyle[]}
              onChange={(v) => setSetting('edgeStyle', v)}
            />
          </Field>
          <Field label="Port style">
            <Select
              value={s.portStyle}
              options={['dots', 'arrows', 'hollow', 'shapes'] as PortStyle[]}
              onChange={(v) => setSetting('portStyle', v)}
            />
          </Field>
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
          <Check
            label="Inheritance arrows"
            hint="Arrows from modules to their bases, dashed to interfaces"
            value={s.inheritance}
            onChange={(v) => setSetting('inheritance', v)}
          />
          <Check label="Minimap" value={s.minimap} onChange={(v) => setSetting('minimap', v)} />
          <Check
            label="Force animations"
            hint="Keep animations even when the system asks for reduced motion"
            value={s.forceAnimations}
            onChange={(v) => setSetting('forceAnimations', v)}
          />
        </SettingsSection>
        <SettingsSection title="Editing">
          <Check label="Snap to grid" value={s.snapToGrid} onChange={(v) => setSetting('snapToGrid', v)} />
          <Field label="Grid size">
            <NumberField
              value={s.gridSize}
              min={5}
              max={100}
              step={5}
              fallback={DEFAULT_SETTINGS.gridSize}
              onChange={(v) => setSetting('gridSize', v)}
            />
          </Field>
          <Check
            label="Select before moving"
            hint="Only selected modules, notes and frames move when dragged; dragging others pans the view"
            value={s.selectToMove}
            onChange={(v) => setSetting('selectToMove', v)}
          />
          <Check
            label="Alignment guides while dragging"
            value={s.guides}
            onChange={(v) => setSetting('guides', v)}
          />
          <Check
            label="Show the Inspector on selection"
            hint="Selecting on the canvas or in the Explorer brings the Inspector to the front"
            value={s.revealInspector}
            onChange={(v) => setSetting('revealInspector', v)}
          />
          <Check
            label="Arrange files without layout when opening"
            value={s.autoLayoutOnOpen}
            onChange={(v) => setSetting('autoLayoutOnOpen', v)}
          />
        </SettingsSection>
        <SettingsSection title="Text editor">
          <Field label="Font size">
            <NumberField
              value={s.editorFontSize}
              min={8}
              max={32}
              step={1}
              fallback={DEFAULT_SETTINGS.editorFontSize}
              onChange={(v) => setSetting('editorFontSize', v)}
            />
          </Field>
          <Field label="Font family">
            <input
              type="text"
              placeholder="monospace (default)"
              value={s.editorFontFamily}
              onChange={(e) => setSetting('editorFontFamily', e.target.value)}
            />
          </Field>
          <Field label="Line height">
            <NumberField
              value={s.editorLineHeight}
              min={1}
              max={3}
              step={0.1}
              fallback={DEFAULT_SETTINGS.editorLineHeight}
              onChange={(v) => setSetting('editorLineHeight', v)}
            />
          </Field>
          <Field label="Tab size">
            <Select
              value={String(s.editorTabSize)}
              options={['2', '4', '8']}
              onChange={(v) => setSetting('editorTabSize', Number(v))}
            />
          </Field>
          <Field label="Whitespace">
            <Select
              value={s.editorWhitespace}
              options={[
                { value: 'all' as WhitespaceShown, label: 'all' },
                { value: 'trailing' as WhitespaceShown, label: 'trailing only' },
                { value: 'none' as WhitespaceShown, label: 'none' }
              ]}
              onChange={(v) => setSetting('editorWhitespace', v)}
            />
          </Field>
          <Check
            label="Indent with tabs"
            hint="Tab and new lines indent with tabs, except in YAML where tabs are invalid"
            value={s.editorIndentTabs}
            onChange={(v) => setSetting('editorIndentTabs', v)}
          />
          <Check
            label="Word wrap"
            value={s.editorWordWrap}
            onChange={(v) => setSetting('editorWordWrap', v)}
          />
          <Check
            label="Line numbers"
            value={s.editorLineNumbers}
            onChange={(v) => setSetting('editorLineNumbers', v)}
          />
          <Check
            label="Folding"
            hint="Fold markers in the gutter (Ctrl+Shift+[ / ] fold and unfold anyway)"
            value={s.editorFolding}
            onChange={(v) => setSetting('editorFolding', v)}
          />
          <Check
            label="Highlight the current line"
            value={s.editorActiveLine}
            onChange={(v) => setSetting('editorActiveLine', v)}
          />
          <Check
            label="Highlight matching brackets"
            value={s.editorBracketMatching}
            onChange={(v) => setSetting('editorBracketMatching', v)}
          />
          <Check
            label="Close brackets and quotes"
            value={s.editorCloseBrackets}
            onChange={(v) => setSetting('editorCloseBrackets', v)}
          />
          <Check
            label="Suggest while typing"
            hint="Completions shown as you type; Ctrl+Space shows them anyway"
            value={s.editorAutocomplete}
            onChange={(v) => setSetting('editorAutocomplete', v)}
          />
          <Check
            label="Highlight selection matches"
            hint="Other occurrences of the selected text"
            value={s.editorSelectionMatches}
            onChange={(v) => setSetting('editorSelectionMatches', v)}
          />
          <Check
            label="Scroll past the end"
            value={s.editorScrollPastEnd}
            onChange={(v) => setSetting('editorScrollPastEnd', v)}
          />
          <Check
            label="Minimap"
            hint="Overview of the file on the right, with the lines in view, selections, matches and problems"
            value={s.editorMinimap}
            onChange={(v) => setSetting('editorMinimap', v)}
          />
          <Field label="Minimap text">
            <Select
              value={s.editorMinimapRender}
              options={[
                { value: 'characters' as MinimapRender, label: 'characters' },
                { value: 'blocks' as MinimapRender, label: 'blocks' }
              ]}
              onChange={(v) => setSetting('editorMinimapRender', v)}
            />
          </Field>
        </SettingsSection>
        <p className="muted settings-empty">No setting matches.</p>
      </Filter.Provider>
      <div className="actions">
        <button type="button" onClick={resetLayout}>
          Reset panel layout
        </button>
        <button type="button" onClick={() => useSettings.setState({ ...DEFAULT_SETTINGS })}>
          Restore defaults
        </button>
      </div>
    </div>
  )
}
