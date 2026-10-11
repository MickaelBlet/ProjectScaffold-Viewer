// State machine of the selected module (the last one selected), drawn as a UML state diagram.
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import {
  INITIAL,
  layoutStateMachine,
  stateLines,
  STATE_HEADER,
  STATE_LINE,
  type Point,
  type StateLayout
} from '@/model/stateLayout'
import type { Id, Module } from '@/model/types'
import { useProjectStore } from '@/store/project'
import { useSelection } from '@/store/ui'
import { themeScheme, useSettings } from '@/store/settings'

type StateData = { name: string; lines: string[]; initial: boolean; final: boolean }
type TransitionData = { points: Point[]; label?: StateLayout['transitions'][number]['label'] }

/** Hidden ends of the transitions, which are drawn along the points ELK routed. */
function Ends(): ReactNode {
  return (
    <>
      <Handle type="target" position={Position.Left} className="state-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="state-handle" isConnectable={false} />
    </>
  )
}

const StateNode = memo(function StateNode(props: NodeProps<Node<StateData>>): ReactNode {
  const { name, lines, final } = props.data
  return (
    <div className={`state-node${final ? ' final' : ''}`}>
      <Ends />
      <div className="state-name" style={{ height: STATE_HEADER }}>
        {name}
      </div>
      {lines.map((l) => (
        <div key={l} className="state-line" style={{ height: STATE_LINE }}>
          {l}
        </div>
      ))}
    </div>
  )
})

const InitialNode = memo(function InitialNode(): ReactNode {
  return (
    <div className="state-initial">
      <Ends />
    </div>
  )
})

const ARROW = 9

const TransitionEdge = memo(function TransitionEdge(props: EdgeProps<Edge<TransitionData>>): ReactNode {
  const points = props.data?.points ?? []
  if (points.length < 2) return null
  const path = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const to = points[points.length - 1]!
  const from = points[points.length - 2]!
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const ux = (to.x - from.x) / length
  const uy = (to.y - from.y) / length
  const bx = to.x - ux * ARROW
  const by = to.y - uy * ARROW
  const half = ARROW * 0.55
  const arrow = `M ${bx - uy * half} ${by + ux * half} L ${to.x} ${to.y} L ${bx + uy * half} ${by - ux * half} Z`
  const label = props.data?.label
  return (
    <>
      <BaseEdge id={props.id} path={path} className="transition-edge" />
      <path d={arrow} className="transition-arrow" />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="transition-label"
            style={{ transform: `translate(${label.x}px, ${label.y}px)`, minWidth: label.width }}
          >
            {label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

/** The extent of the diagram, transitions included, for the view to fit it. */
const BoundsNode = memo(function BoundsNode(): ReactNode {
  return null
})

const nodeTypes = { state: StateNode, initial: InitialNode, bounds: BoundsNode }
const edgeTypes = { transition: TransitionEdge }

/** The module last selected, while it exists. */
function useShownModule(): Module | undefined {
  const selection = useSelection()
  const [last, setLast] = useState<Id | null>(null)
  const selected = selection?.kind === 'module' ? selection.id : null
  if (selected && selected !== last) setLast(selected)
  const id = selected ?? last
  return useProjectStore((s) => (id ? s.project.modules.find((m) => m.id === id) : undefined))
}

export function StateMachinePanel(): ReactNode {
  const mod = useShownModule()
  const theme = useSettings((s) => s.theme)
  const [laidOut, setLaidOut] = useState<{ mod: Id; layout: StateLayout } | null>(null)
  const sm = mod?.stateMachine
  // The module object changes with any of its edits: lay out again only when the machine or the
  // names of the methods change.
  const key = useMemo(
    () => (mod && sm ? JSON.stringify([sm, mod.methods.map((x) => [x.id, x.name])]) : ''),
    [mod, sm]
  )
  useEffect(() => {
    if (!mod || !key) return
    let live = true
    void layoutStateMachine(mod).then((layout) => {
      if (live) setLaidOut({ mod: mod.id, layout })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the module
  }, [key])
  // The layout of the module shown (the former one while the new one is computed).
  const layout = laidOut && key && laidOut.mod === mod?.id ? laidOut.layout : null
  const { nodes, edges } = useMemo(() => {
    if (!mod?.stateMachine || !layout) return { nodes: [], edges: [] }
    const states = new Map(mod.stateMachine.states.map((s) => [s.id, s]))
    const bounds: Node = {
      id: '__bounds__',
      type: 'bounds',
      position: { x: 0, y: 0 },
      width: layout.width,
      height: layout.height,
      data: {},
      zIndex: -1
    }
    const nodes: Node[] = [
      bounds,
      ...layout.states.flatMap((b): Node[] => {
        const base = { id: b.id, position: { x: b.x, y: b.y }, width: b.width, height: b.height }
        if (b.id === INITIAL) return [{ ...base, type: 'initial', data: {} }]
        const s = states.get(b.id)
        if (!s) return []
        const data: StateData = {
          name: s.name,
          lines: stateLines(mod, s.entry, s.exit),
          initial: mod.stateMachine!.initial === s.id,
          final: !!s.final
        }
        return [{ ...base, type: 'state', data }]
      })
    ]
    const edges: Edge[] = layout.transitions.map((t) => ({
      id: t.id,
      source: t.from,
      target: t.to,
      type: 'transition',
      data: { points: t.points, label: t.label } satisfies TransitionData
    }))
    return { nodes, edges }
  }, [mod, layout])

  if (!mod) return <p className="muted panel-message">Select a module to see its state machine.</p>
  if (!sm?.states.length)
    return <p className="muted panel-message">{mod.name} has no state machine (Inspector: State machine).</p>
  if (!layout) return null
  return (
    <div className="state-machine-panel">
      <div className="state-machine-title">{mod.name}</div>
      <ReactFlow
        key={mod.id}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={themeScheme(theme)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  )
}
