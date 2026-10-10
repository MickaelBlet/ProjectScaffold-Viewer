import { memo, type ReactNode } from 'react'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { contentBottom, importedParent, importedSize, LAYOUT_PAD, minSize } from '@/model/project'
import type { ImportedPort, LinkAnchor, Side } from '@/model/types'
import { setModuleLayout, useProjectStore } from '@/store/project'
import { Icon } from '@/components/Icon'
import type { PortNodeData } from './flowGraph'
import { Attributes, Methods } from './ModuleNode'
import { anchorStyle, inward, PortPoint } from './PortPoint'
import { usePortLayout } from './usePortLayout'
import { useDrawn } from './viewContext'

/**
 * Module of another project, with its content (placed with it, in place): its ports floating (see portSides.ts) or on the orientation's default
 * edges, linkable; resizable.
 */
export const ImportedNode = memo(function ImportedNode({
  id,
  selected,
  data
}: NodeProps<Node<PortNodeData>>): ReactNode {
  // As the canvas's view draws it (outside a drill-down view: its ports linked to the view).
  const dep = useDrawn((p) => p.dependencies.find((x) => x.modules.some((m) => m.id === id)))
  const interfaces = useProjectStore((s) => s.project.interfaces)
  const types = useProjectStore((s) => s.project.types)
  const orientation = useProjectStore((s) => s.project.orientation)
  const module = dep?.modules.find((m) => m.id === id)
  const { floating, anchors, top, bottom, left, right } = usePortLayout(
    id,
    module?.ports ?? [],
    data,
    orientation
  )
  if (!dep || !module) return null
  const vertical = orientation === 'vertical'
  // Content of a placed module: drawn in it, at its place there.
  const parent = !data.outside && importedParent(dep, module)
  const content = data.outside ? [] : dep.modules.filter((x) => importedParent(dep, x) === module)
  const own = minSize(module, orientation)
  const min = content.reduce((m, c) => {
    const size = importedSize(c, orientation)
    return {
      width: Math.max(m.width, c.position.x + size.width + LAYOUT_PAD),
      height: Math.max(m.height, c.position.y + size.height + contentBottom(orientation))
    }
  }, own)
  const iface = (p: ImportedPort): string | undefined => p.interface ?? undefined
  const unknown = (p: ImportedPort): boolean =>
    !!p.interface && !interfaces.some((i) => i.name === p.interface)
  const title = (p: ImportedPort): string =>
    `${p.role} ${p.name}: ${iface(p) ?? 'no interface'}${unknown(p) ? ' (interface not defined in this project)' : ''}`
  const point = (p: ImportedPort, edge: Side, fallback = inward(edge), anchor?: LinkAnchor): ReactNode => (
    <PortPoint
      key={p.id}
      moduleId={id}
      port={p}
      iface={iface(p)}
      title={title(p)}
      edge={edge}
      fallback={fallback}
      className={unknown(p) ? 'unknown' : ''}
      style={anchor && anchorStyle(anchor)}
    />
  )
  const band = (list: ImportedPort[], side: 'top' | 'bottom'): ReactNode => (
    <div className={`port-band ${side}`}>
      {list.map((p) => (
        <span key={p.id} className="vport">
          {point(p, side)}
        </span>
      ))}
    </div>
  )
  const rows = Math.max(left.length, right.length)

  return (
    <div
      className={`module imported ${vertical ? 'vertical' : ''} ${content.length ? 'container' : ''} ${data.outside ? 'outside' : ''} ${selected ? 'selected' : ''}`}
      title={`${module.path} in ${dep.file}`}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={min.width}
        minHeight={min.height}
        onResizeEnd={(_, r) => setModuleLayout(id, { x: r.x, y: r.y, width: r.width, height: r.height })}
      />
      {(top.length > 0 || (!floating && vertical)) && band(top, 'top')}
      <div className="module-header">
        <span className="module-name">
          {parent ? (
            module.path.slice(parent.path.length + 1)
          ) : (
            <>
              <small className="imported-project">
                <Icon name="arrow-up-right" /> {dep.name}
              </small>{' '}
              {module.path}
            </>
          )}
        </span>
      </div>
      {!!module.attributes?.length && <Attributes attributes={module.attributes} types={types} />}
      {!!module.methods?.length && <Methods methods={module.methods} types={types} />}
      {rows > 0 && (
        // A container's side ports are centered on its frame, over its content.
        <div className={`module-ports ${content.length ? 'framed' : ''}`}>
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
      {(bottom.length > 0 || (!floating && vertical)) && band(bottom, 'bottom')}
      {module.ports.map((p) => {
        const a = anchors[p.id]
        // Past top / bottom attachments the name goes outside, clear of the header.
        return a && point(p, a.side, a.side === 'left' || a.side === 'right' ? inward(a.side) : a.side, a)
      })}
    </div>
  )
})
