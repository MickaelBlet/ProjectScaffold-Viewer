import { memo, type CSSProperties, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import { indexById, minSize, modulePath, nameError, parentIds } from '@/model/project'
import { getProject, setLocked, setModuleLayout, update, useProjectStore } from '@/store/project'
import { useUiStore } from '@/store/ui'
import { openModuleView } from '@/actions'
import { printTypeRef, walkTypeRef } from '@/model/typeExpr'
import { formatValue } from '@/model/defaults'
import {
  QUALIFIERS,
  type Attribute,
  type LinkAnchor,
  type Method,
  type Port,
  type Side,
  type TypeDef,
  type TypeRef
} from '@/model/types'
import { Icon } from '@/components/Icon'
import { MODULE_HANDLE } from './constants'
import type { PortNodeData } from './flowGraph'
import { anchorStyle, inward, PortPoint } from './PortPoint'
import { useDrawn } from './viewContext'
import { usePortLayout } from './usePortLayout'

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

/**
 * Attribute compartment below the header: typed properties, drawn apart from the ports on the
 * border where links attach.
 */
/** Whether `t` references a type that no longer exists. */
function hasDeletedRef(t: TypeRef, nameOf: (id: string) => string | undefined): boolean {
  let deleted = false
  walkTypeRef(t, (n) => {
    if (n.kind === 'ref' && !nameOf(n.id)) deleted = true
  })
  return deleted
}

/** Qualifiers set on an attribute, method or parameter, each followed by a space. */
const qualifierText = (q: { static?: boolean; const?: boolean }): string =>
  QUALIFIERS.filter((k) => q[k])
    .map((k) => `${k} `)
    .join('')

function Attributes({ attributes, types }: { attributes: Attribute[]; types: TypeDef[] }): ReactNode {
  const nameOf = (id: string): string | undefined => types.find((t) => t.id === id)?.name
  return (
    <ul className="module-attrs">
      {attributes.map((a) => {
        const type = printTypeRef(a.type, nameOf)
        const deleted = hasDeletedRef(a.type, nameOf)
        const value = a.default === undefined ? '' : ` = ${formatValue(a.default)}`
        const qualifiers = qualifierText(a)
        const sig = `${qualifiers}${a.name}: ${type}${value}`
        return (
          <li key={a.id} title={a.description ? `${sig}\n${a.description}` : sig}>
            {qualifiers && <span className="attr-qualifier">{qualifiers}</span>}
            <span className="attr-name">{a.name}</span>
            <span className={`attr-type ${deleted ? 'deleted' : ''}`}>: {type}</span>
            {value && <span className="attr-default">{value}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** Method compartment below the attributes: `virtual name(a: T, out b: U): R const = 0`. */
function Methods({ methods, types }: { methods: Method[]; types: TypeDef[] }): ReactNode {
  const nameOf = (id: string): string | undefined => types.find((t) => t.id === id)?.name
  return (
    <ul className="module-attrs module-methods">
      {methods.map((m) => {
        const params = m.params
          .map(
            (prm) =>
              `${prm.direction === 'in' ? '' : `${prm.direction} `}${qualifierText(prm)}${prm.name}: ${printTypeRef(prm.type, nameOf)}`
          )
          .join(', ')
        const returns = m.returns ? `: ${printTypeRef(m.returns, nameOf)}` : ''
        const deleted = [...m.params.map((prm) => prm.type), ...(m.returns ? [m.returns] : [])].some((t) =>
          hasDeletedRef(t, nameOf)
        )
        const before = m.static ? 'static ' : m.virtual ? 'virtual ' : ''
        const after = `${m.const ? ' const' : ''}${m.override ? ' override' : ''}${m.pure ? ' = 0' : ''}`
        const raises = m.raises?.length
          ? ` throws ${m.raises.map((id) => nameOf(id) ?? '<deleted>').join(', ')}`
          : ''
        const sig = `${before}${m.name}(${params})${returns}${after}${raises}`
        return (
          <li key={m.id} title={m.description ? `${sig}\n${m.description}` : sig}>
            {before && <span className="attr-qualifier">{before}</span>}
            <span className={`attr-name ${m.pure ? 'pure' : ''}`}>{m.name}</span>
            <span className={`attr-type ${deleted ? 'deleted' : ''}`}>
              ({params}){returns}
            </span>
            {after && <span className="attr-qualifier">{after}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export const ModuleNode = memo(function ModuleNode({
  id,
  selected,
  draggable,
  data
}: NodeProps<Node<PortNodeData>>): ReactNode {
  // Port name sides of the canvas's view.
  const mod = useDrawn((p) => indexById(p.modules).get(id))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const types = useProjectStore((s) => s.project.types)
  // A module outside a drill-down view is drawn compact: its path, its ports linked to the view.
  const outside = !!data.outside
  const path = useProjectStore((s) => (outside ? modulePath(s.project, id) : null))
  const hasChildren = useProjectStore((s) => !outside && parentIds(s.project.modules).has(id))
  const orientation = useProjectStore((s) => s.project.orientation)
  const binary = useProjectStore((s) => {
    const m = indexById(s.project.modules).get(id)
    return m?.binaryId ? indexById(s.project.binaries).get(m.binaryId) : undefined
  })
  const renaming = useUiStore((s) => s.renaming === id)
  // Stable string: re-renders only when a base is added, removed or renamed.
  const bases = useProjectStore((s) => {
    const modules = indexById(s.project.modules)
    return (modules.get(id)?.bases ?? []).map((b) => modules.get(b)?.name ?? '?').join(', ')
  })
  const { floating, anchors, top, bottom, left, right } = usePortLayout(
    id,
    mod?.ports ?? [],
    data,
    orientation
  )
  if (!mod) return null

  const rows = Math.max(left.length, right.length)
  const vertical = orientation === 'vertical'
  // Containers keep both bands in vertical orientation: their content starts below them.
  const topBand = top.length > 0 || (vertical && (!floating || hasChildren))
  const bottomBand = bottom.length > 0 || (vertical && (!floating || hasChildren))
  // Container ports moved off the orientation's edges go outside the frame, clear of the content.
  const outsideBands = hasChildren && !vertical
  const min = minSize(mod, orientation)
  const ifaceName = (p: Port): string | undefined =>
    p.interfaceId ? (interfaces.find((i) => i.id === p.interfaceId)?.name ?? '?') : undefined
  const title = (p: Port): string => `${p.role} ${p.name}: ${ifaceName(p) ?? 'no interface'}`
  const style = mod.color ? ({ '--module-color': mod.color } as CSSProperties) : undefined

  const point = (p: Port, edge: Side, fallback = inward(edge), anchor?: LinkAnchor): ReactNode => (
    <PortPoint
      key={p.id}
      moduleId={id}
      port={p}
      iface={ifaceName(p)}
      title={title(p)}
      edge={edge}
      fallback={fallback}
      style={anchor && anchorStyle(anchor)}
      lift={hasChildren}
    />
  )
  const band = (ports: Port[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side} ${outsideBands ? 'outside' : ''}`}>
      {ports.map((p) => (
        <span key={p.id} className="vport">
          {point(p, side, outsideBands ? side : inward(side))}
        </span>
      ))}
    </div>
  )

  return (
    <div
      className={`module ${vertical ? 'vertical' : ''} ${hasChildren ? 'container' : ''} ${outside ? 'outside' : ''} ${selected ? 'selected' : ''} ${mod.color ? 'colored' : ''}`}
      style={style}
      title={outside ? `${path} (outside this view)` : mod.description}
    >
      <NodeResizer
        isVisible={selected && (draggable || (!!data.frame && !mod.locked))}
        minWidth={min.width}
        minHeight={min.height}
        onResizeEnd={(_, r) => setModuleLayout(id, { x: r.x, y: r.y, width: r.width, height: r.height })}
      />
      {topBand && band(top, 'top')}
      <div className="module-header" onDoubleClick={() => useUiStore.setState({ renaming: id })}>
        {renaming ? (
          <RenameInput id={id} name={mod.name} parentId={mod.parentId} />
        ) : (
          <span className={`module-name ${mod.kind ?? ''}`}>
            {mod.kind && <span className="module-kind">«{mod.kind}» </span>}
            {path ?? mod.name}
            {bases && <span className="module-bases"> : {bases}</span>}
            {binary && (
              <small
                className="module-binary"
                title={`Runs in binary ${binary.name}`}
                style={binary.color ? ({ '--binary-color': binary.color } as CSSProperties) : undefined}
              >
                <Icon name="binary" /> {binary.name}
              </small>
            )}
          </span>
        )}
        <Handle
          type="source"
          position={vertical ? Position.Bottom : Position.Right}
          id={MODULE_HANDLE}
          className="module-connect"
          title="Drag to another module or port to link them"
        >
          <Icon name="arrow-right" />
        </Handle>
        <button
          type="button"
          className={`module-open module-lock nodrag ${mod.locked ? 'locked' : ''}`}
          title={mod.locked ? 'Unlock position and size (Ctrl+L)' : 'Lock position and size (Ctrl+L)'}
          onClick={(e) => {
            e.stopPropagation()
            setLocked([id], !mod.locked)
          }}
        >
          <Icon name={mod.locked ? 'lock' : 'unlock'} />
        </button>
        <button
          type="button"
          className="module-open nodrag"
          title="Open in its own view (Alt+Enter)"
          onClick={(e) => {
            e.stopPropagation()
            openModuleView(id)
          }}
        >
          <Icon name="expand" />
        </button>
      </div>
      {mod.attributes.length > 0 && <Attributes attributes={mod.attributes} types={types} />}
      {mod.methods.length > 0 && <Methods methods={mod.methods} types={types} />}
      {rows > 0 && (
        // A container's side ports are centered on its frame, over its content.
        <div className={`module-ports ${hasChildren ? 'framed' : ''}`}>
          {Array.from({ length: rows }, (_, i) => {
            const pl = left[i]
            const pr = right[i]
            return (
              <div className="port-row" key={i}>
                {pl && point(pl, 'left')}
                {pr && point(pr, 'right')}
              </div>
            )
          })}
        </div>
      )}
      {bottomBand && band(bottom, 'bottom')}
      {mod.ports.map((p) => {
        const a = anchors[p.id]
        // Past top / bottom attachments the name goes outside, clear of the header.
        return a && point(p, a.side, a.side === 'left' || a.side === 'right' ? inward(a.side) : a.side, a)
      })}
    </div>
  )
})
