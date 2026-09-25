import { memo, useState, type CSSProperties, type ReactNode } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { updateNote, useProjectStore } from '@/store/project'

export const NoteNode = memo(function NoteNode({ id, selected }: NodeProps): ReactNode {
  const note = useProjectStore((s) => s.project.notes.find((n) => n.id === id))
  const [editing, setEditing] = useState(false)
  if (!note) return null
  const style = note.color ? ({ '--note-color': note.color } as CSSProperties) : undefined
  const text = editing ? (
    <textarea
      className="note-edit nodrag nowheel"
      defaultValue={note.text}
      autoFocus
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') setEditing(false)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
      }}
      onBlur={(e) => {
        setEditing(false)
        const value = e.target.value
        if (value !== note.text) updateNote(id, (n) => void (n.text = value))
      }}
    />
  ) : (
    <div className="note-text">{note.text}</div>
  )
  return (
    <div
      className={`note ${note.kind} ${selected ? 'selected' : ''}`}
      style={style}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={80}
        minHeight={40}
        onResizeEnd={(_, r) =>
          updateNote(id, (n) => void (n.layout = { x: r.x, y: r.y, width: r.width, height: r.height }))
        }
      />
      {note.kind === 'frame' ? <div className="frame-title">{text}</div> : text}
    </div>
  )
})
