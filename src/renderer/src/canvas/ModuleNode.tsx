import { memo, useEffect, type CSSProperties, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { leafHeight, nameError } from '@/model/project'
import { getProject, setModuleLayout, update, useProjectStore } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { openModuleView } from '@/actions'
import type { Port } from '@/model/types'

function RenameInput({
  id,
  name,
  parentId
}: {
  id: string
  name: string
  parentId: string | null
}): ReactNode {
  const done = (value: string | null): void => {
    useUiStore.setState({ renaming: null })
    if (value === null || value === name) return
    if (nameError(getProject(), { kind: 'module', id, parentId }, value)) return
    update((d) => {
      const m = d.modules.find((m) => m.id === id)
      if (m) m.name = value
    })
  }
  return (
    <input
      className="module-rename nodrag"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') done(e.currentTarget.value)
        if (e.key === 'Escape') done(null)
      }}
      onBlur={(e) => done(e.target.value)}
      onChange={(e) => {
        const error = nameError(getProject(), { kind: 'module', id, parentId }, e.target.value)
        e.target.classList.toggle('invalid', !!error && e.target.value !== name)
        e.target.title = error ?? ''
      }}
    />
  )
}

export const ModuleNode = memo(function ModuleNode({ id, selected, draggable }: NodeProps): ReactNode {
  const mod = useProjectStore((s) => s.project.modules.find((m) => m.id === id))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const hasChildren = useProjectStore((s) => s.project.modules.some((m) => m.parentId === id))
  const renaming = useUiStore((s) => s.renaming === id)
  const updateInternals = useUpdateNodeInternals()
  const portsKey = mod?.ports.map((p) => `${p.id}:${p.role}`).join(',')
  useEffect(() => updateInternals(id), [id, portsKey, updateInternals])
  if (!mod) return null

  const ins = mod.ports.filter((p) => p.role === 'in')
  const outs = mod.ports.filter((p) => p.role === 'out')
  const rows = Math.max(ins.length, outs.length)
  const ifaceName = (p: Port): string =>
    p.interfaceId ? (interfaces.find((i) => i.id === p.interfaceId)?.name ?? '?') : '—'
  const style = mod.color ? ({ '--module-color': mod.color } as CSSProperties) : undefined

  return (
    <div
      className={`module ${hasChildren ? 'container' : ''} ${selected ? 'selected' : ''} ${mod.color ? 'colored' : ''}`}
      style={style}
      title={mod.description}
    >
      <NodeResizer
        isVisible={selected && draggable}
        minWidth={140}
        minHeight={leafHeight(rows)}
        onResizeEnd={(_, r) => setModuleLayout(id, { x: r.x, y: r.y, width: r.width, height: r.height })}
      />
      <div className="module-header" onDoubleClick={() => useUiStore.setState({ renaming: id })}>
        {renaming ? (
          <RenameInput id={id} name={mod.name} parentId={mod.parentId} />
        ) : (
          <span className="module-name">{mod.name}</span>
        )}
        {hasChildren && (
          <button
            type="button"
            className="module-open nodrag"
            title="Open in its own view (Alt+Enter)"
            onClick={(e) => {
              e.stopPropagation()
              openModuleView(id)
            }}
          >
            ⤢
          </button>
        )}
      </div>
      <div className="module-ports">
        {Array.from({ length: rows }, (_, i) => {
          const pin = ins[i]
          const pout = outs[i]
          return (
            <div className="port-row" key={i}>
              {pin && (
                <span className="port in" title={`in ${pin.name}: ${ifaceName(pin)}`}>
                  <Handle type="target" position={Position.Left} id={pin.id} className="handle in" />
                  {pin.name}
                  <small>{ifaceName(pin)}</small>
                </span>
              )}
              {pout && (
                <span className="port out" title={`out ${pout.name}: ${ifaceName(pout)}`}>
                  <small>{ifaceName(pout)}</small>
                  {pout.name}
                  <Handle type="source" position={Position.Right} id={pout.id} className="handle out" />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})
