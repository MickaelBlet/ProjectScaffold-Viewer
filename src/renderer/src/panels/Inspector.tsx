import type { ReactNode } from 'react'
import { useDoc } from '@/store/documents'
import { deleteItems, setModuleColor, updateNote, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { commandItem } from '@/commands'
import { ColorPicker, Row, Section, Select, TextArea } from '@/components/fields'
import { openEditor, type EditorKind } from '@/shell/controllers'
import { ProjectInspector } from './ProjectInspector'
import { ModuleInspector } from './ModuleInspector'
import { LinkInspector } from './LinkInspector'
import { TypeInspector } from './TypeInspector'
import { InterfaceInspector } from './InterfaceInspector'

function CommandButton({ id, label }: { id: string; label: string }): ReactNode {
  const c = commandItem(id)
  if (c === 'separator') return null
  return (
    <button
      type="button"
      disabled={c.disabled}
      title={c.keys ? `${c.label} (${c.keys})` : c.label}
      onClick={c.run}
    >
      {label}
    </button>
  )
}

function MultiInspector({ ids }: { ids: string[] }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const modules = project.modules.filter((m) => ids.includes(m.id))
  const notes = project.notes.filter((n) => ids.includes(n.id))
  const types = project.types.filter((t) => ids.includes(t.id))
  const interfaces = project.interfaces.filter((i) => ids.includes(i.id))
  const parts = [
    [modules.length, 'module'],
    [notes.length, 'note'],
    [types.length, 'type'],
    [interfaces.length, 'interface']
  ]
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}${(n as number) > 1 ? 's' : ''}`)
  const onCanvas = modules.length + notes.length
  return (
    <>
      <h2>
        Selection <small className="muted">{parts.join(', ')}</small>
      </h2>
      {onCanvas > 1 && (
        <Section title="Align">
          <div className="button-grid">
            <CommandButton id="arrange.left" label="⇤ Left" />
            <CommandButton id="arrange.hcenter" label="↔ Center" />
            <CommandButton id="arrange.right" label="Right ⇥" />
            <CommandButton id="arrange.top" label="⤒ Top" />
            <CommandButton id="arrange.vcenter" label="↕ Middle" />
            <CommandButton id="arrange.bottom" label="Bottom ⤓" />
            <CommandButton id="arrange.distH" label="Distribute ↔" />
            <CommandButton id="arrange.distV" label="Distribute ↕" />
            <CommandButton id="arrange.sameSize" label="Same size" />
          </div>
        </Section>
      )}
      {modules.length > 0 && (
        <Section title="Color">
          <ColorPicker
            value={modules.every((m) => m.color === modules[0]!.color) ? modules[0]!.color : undefined}
            onChange={(c) =>
              setModuleColor(
                modules.map((m) => m.id),
                c
              )
            }
          />
        </Section>
      )}
      <Section title="Items">
        <ul className="plain">
          {[
            ...modules,
            ...notes.map((n) => ({ ...n, name: n.text.split('\n')[0] })),
            ...types,
            ...interfaces
          ].map((e) => (
            <li key={e.id}>{e.name}</li>
          ))}
        </ul>
      </Section>
      <div className="actions">
        {modules.length > 0 && <CommandButton id="arrange.group" label="Group" />}
        <CommandButton id="edit.copy" label="Copy" />
        <CommandButton id="edit.duplicate" label="Duplicate" />
        <CommandButton id="edit.delete" label="Delete" />
      </div>
    </>
  )
}

function NoteInspector({ id }: { id: string }): ReactNode {
  const note = useProjectStore((s) => s.project.notes.find((n) => n.id === id))
  if (!note) return <p className="muted">Note deleted.</p>
  return (
    <>
      <h2>{note.kind}</h2>
      <Row label="Kind">
        <Select
          value={note.kind}
          options={['note', 'frame'] as const}
          onChange={(k) => updateNote(id, (n) => void (n.kind = k))}
        />
      </Row>
      <TextArea
        value={note.text}
        placeholder="Text"
        onChange={(v) => updateNote(id, (n) => void (n.text = v))}
      />
      <Section title="Color">
        <ColorPicker
          value={note.color}
          onChange={(c) => updateNote(id, (n) => (c ? void (n.color = c) : void delete n.color))}
        />
      </Section>
      <p className="muted">Notes and frames are editor annotations: they are saved but never exported.</p>
      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteItems([id])
            select(null)
          }}
        >
          Delete {note.kind}
        </button>
      </div>
    </>
  )
}

export function Inspector(): ReactNode {
  const sel = useDoc((d) => d.selection)
  const selectedIds = useDoc((d) => d.selectedIds)
  const openable = sel && sel.kind !== 'project' && sel.kind !== 'note' ? (sel.kind as EditorKind) : null
  return (
    <div className="inspector">
      {openable && sel && 'id' in sel && selectedIds.length <= 1 && (
        <button
          type="button"
          className="icon open-tab"
          title="Open in an editor tab"
          onClick={() => openEditor(openable, sel.id)}
        >
          ↗
        </button>
      )}
      {selectedIds.length > 1 ? (
        <MultiInspector ids={selectedIds} />
      ) : !sel || sel.kind === 'project' ? (
        <ProjectInspector />
      ) : sel.kind === 'module' ? (
        <ModuleInspector key={sel.id} id={sel.id} />
      ) : sel.kind === 'link' ? (
        <LinkInspector key={sel.id} id={sel.id} />
      ) : sel.kind === 'type' ? (
        <TypeInspector key={sel.id} id={sel.id} />
      ) : sel.kind === 'note' ? (
        <NoteInspector key={sel.id} id={sel.id} />
      ) : (
        <InterfaceInspector key={sel.id} id={sel.id} />
      )}
    </div>
  )
}
