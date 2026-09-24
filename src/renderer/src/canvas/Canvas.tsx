import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnNodeDrag
} from '@xyflow/react'
import { findPort, MODULE_WIDTH, subtreeIds } from '@/model/project'
import {
  addLink,
  addModule,
  getProject,
  reparentModule,
  setModuleLayout,
  update,
  useProjectStore
} from '@/store/project'
import { select, useUiStore } from '@/store/ui'
import type { Module } from '@/model/types'
import { ModuleNode } from './ModuleNode'
import { LinkEdge, PERF_COLORS } from './LinkEdge'

const nodeTypes = { module: ModuleNode }

let flowCenter = (): { x: number; y: number } => ({ x: 80, y: 80 })

/** Add a top-level module in the middle of the visible canvas. */
export function addModuleAtViewCenter(): string {
  const c = flowCenter()
  return addModule(null, Math.round(c.x - MODULE_WIDTH / 2), Math.round(c.y - 40))
}
const edgeTypes = { link: LinkEdge }

function toNodes(modules: Module[], selectedId: string | null): Node[] {
  return modules.map((m) => ({
    id: m.id,
    type: 'module',
    position: { x: m.layout.x, y: m.layout.y },
    width: m.layout.width,
    height: m.layout.height,
    parentId: m.parentId ?? undefined,
    selected: m.id === selectedId,
    data: {}
  }))
}

export function Canvas(): ReactNode {
  const modules = useProjectStore((s) => s.project.modules)
  const links = useProjectStore((s) => s.project.links)
  const selection = useUiStore((s) => s.selection)
  const viewEpoch = useUiStore((s) => s.viewEpoch)
  const { screenToFlowPosition, getInternalNode, getIntersectingNodes, fitView } = useReactFlow()

  const selectedModule = selection?.kind === 'module' ? selection.id : null
  const selectedLink = selection?.kind === 'link' ? selection.id : null

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  useEffect(() => setNodes(toNodes(modules, selectedModule)), [modules, selectedModule, setNodes])

  useEffect(() => {
    flowCenter = () => {
      const r = document.querySelector('.canvas')?.getBoundingClientRect()
      return r ? screenToFlowPosition({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) : { x: 80, y: 80 }
    }
  }, [screenToFlowPosition])

  useEffect(() => {
    if (!viewEpoch) return
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 50)
    return () => clearTimeout(t)
  }, [viewEpoch, fitView])

  const edges = useMemo<Edge[]>(
    () =>
      links.map((l) => {
        const color = PERF_COLORS[l.constraints.performance.class]
        const marker = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }
        return {
          id: l.id,
          type: 'link',
          source: l.from.moduleId,
          sourceHandle: l.from.portId,
          target: l.to.moduleId,
          targetHandle: l.to.portId,
          selected: l.id === selectedLink,
          markerEnd: marker,
          markerStart: l.constraints.direction === 'bidirectional' ? marker : undefined,
          zIndex: 1000
        }
      }),
    [links, selectedLink]
  )

  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    if (!c.sourceHandle || !c.targetHandle || c.source === c.target) return false
    const p = getProject()
    const a = findPort(p, c.source, c.sourceHandle)
    const b = findPort(p, c.target, c.targetHandle)
    if (!a || !b) return false
    return !a.interfaceId || !b.interfaceId || a.interfaceId === b.interfaceId
  }, [])

  const onConnect = useCallback((c: Connection): void => {
    if (!c.sourceHandle || !c.targetHandle) return
    const from = { moduleId: c.source, portId: c.sourceHandle }
    const to = { moduleId: c.target, portId: c.targetHandle }
    // Propagate the interface to an untyped end.
    update((d) => {
      const a = findPort(d, from.moduleId, from.portId)
      const b = findPort(d, to.moduleId, to.portId)
      if (a && b && !a.interfaceId) a.interfaceId = b.interfaceId
      if (a && b && !b.interfaceId) b.interfaceId = a.interfaceId
    })
    select({ kind: 'link', id: addLink(from, to) })
  }, [])

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_, node) => {
      const internal = getInternalNode(node.id)
      if (!internal) return
      const abs = internal.internals.positionAbsolute
      const w = node.measured?.width ?? node.width ?? 0
      const h = node.measured?.height ?? node.height ?? 0
      const center = { x: abs.x + w / 2, y: abs.y + h / 2 }
      const own = subtreeIds(getProject(), node.id)
      // Deepest module under the dragged module's center becomes its parent.
      const target = getIntersectingNodes(node)
        .filter((n) => !own.has(n.id))
        .map((n) => ({ n, a: getInternalNode(n.id)!.internals.positionAbsolute }))
        .filter(
          ({ n, a }) =>
            center.x >= a.x &&
            center.x <= a.x + (n.measured?.width ?? 0) &&
            center.y >= a.y &&
            center.y <= a.y + (n.measured?.height ?? 0)
        )
        .sort((x, y) => depth(y.n.id) - depth(x.n.id))[0]
      const newParent = target?.n.id ?? null
      if (newParent !== (node.parentId ?? null)) {
        const base = target ? target.a : { x: 0, y: 0 }
        reparentModule(node.id, newParent, abs.x - base.x, abs.y - base.y)
      } else {
        setModuleLayout(node.id, { x: node.position.x, y: node.position.y })
      }
    },
    [getInternalNode, getIntersectingNodes]
  )

  return (
    <div
      className="canvas"
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        select({ kind: 'module', id: addModule(null, pos.x, pos.y) })
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => select({ kind: 'module', id: n.id })}
        onEdgeClick={(_, e) => select({ kind: 'link', id: e.id })}
        onPaneClick={() => select(null)}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={null}
        // Fixed stacking: edges (1000) and their badges (1001) stay above modules even when selected.
        zIndexMode="manual"
        zoomOnDoubleClick={false}
        colorMode="system"
        minZoom={0.2}
        fitView
      >
        <Background gap={20} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}

function depth(id: string): number {
  const p = getProject()
  let d = 0
  let cur = p.modules.find((m) => m.id === id)
  while (cur?.parentId) {
    d++
    const parentId = cur.parentId
    cur = p.modules.find((m) => m.id === parentId)
  }
  return d
}
