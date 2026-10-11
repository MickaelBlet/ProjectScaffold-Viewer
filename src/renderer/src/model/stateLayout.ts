// Layout of a module's state machine with ELK: states left to right, transitions routed between them.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { Id, Module, Transition } from './types'

export interface Point {
  x: number
  y: number
}

export interface StateBox {
  /** A state id, or `INITIAL` for the dot the machine starts from. */
  id: Id
  x: number
  y: number
  width: number
  height: number
}

export interface TransitionPath {
  /** A transition id, or `INITIAL` for the arrow to the initial state. */
  id: Id
  from: Id
  to: Id
  points: Point[]
  label?: { text: string; x: number; y: number; width: number }
}

export interface StateLayout {
  /** Size of the whole diagram, transitions included. */
  width: number
  height: number
  states: StateBox[]
  transitions: TransitionPath[]
}

export const INITIAL = '__initial__'

/** Approximate width of a text in the diagram's font. */
export const textWidth = (text: string): number => Math.ceil(text.length * 6.8)
export const STATE_HEADER = 28
export const STATE_LINE = 15
const LABEL_HEIGHT = 16
const DOT = 14

/** `trigger [guard] / action`, as UML writes a transition. */
export function transitionText(m: Module, t: Transition): string {
  const name = (id: Id | undefined): string | undefined =>
    id && (m.methods.find((x) => x.id === id)?.name ?? '?')
  const trigger = name(t.trigger)
  const action = name(t.action)
  return [trigger, t.guard?.trim() && `[${t.guard.trim()}]`, action && `/ ${action}()`]
    .filter(Boolean)
    .join(' ')
}

/** Lines below the name of a state: `entry / reset()`, `exit / save()`. */
export function stateLines(m: Module, entry: Id | undefined, exit: Id | undefined): string[] {
  const name = (id: Id): string => m.methods.find((x) => x.id === id)?.name ?? '?'
  return [...(entry ? [`entry / ${name(entry)}()`] : []), ...(exit ? [`exit / ${name(exit)}()`] : [])]
}

let elk: InstanceType<typeof ELK> | null = null

export async function layoutStateMachine(m: Module): Promise<StateLayout> {
  const sm = m.stateMachine
  if (!sm?.states.length) return { width: 0, height: 0, states: [], transitions: [] }
  const ids = new Set(sm.states.map((s) => s.id))
  const children: ElkNode[] = sm.states.map((s) => {
    const lines = stateLines(m, s.entry, s.exit)
    return {
      id: s.id,
      width: Math.max(90, ...[s.name, ...lines].map((l) => textWidth(l) + 24)),
      height: STATE_HEADER + lines.length * STATE_LINE + (lines.length ? 6 : 0)
    }
  })
  const edges: ElkExtendedEdge[] = sm.transitions
    .filter((t) => ids.has(t.from) && ids.has(t.to))
    .map((t) => {
      const text = transitionText(m, t)
      return {
        id: t.id,
        sources: [t.from],
        targets: [t.to],
        labels: text ? [{ id: `${t.id}:label`, text, width: textWidth(text) + 8, height: LABEL_HEIGHT }] : []
      }
    })
  if (sm.initial && ids.has(sm.initial)) {
    children.unshift({ id: INITIAL, width: DOT, height: DOT })
    edges.unshift({ id: INITIAL, sources: [INITIAL], targets: [sm.initial] })
  }
  elk ??= new ELK()
  const graph: ElkNode = {
    id: 'root',
    children,
    edges,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'POLYLINE',
      // From the initial state, in the order of the file.
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.inline': 'false',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]'
    }
  }
  const result = await elk.layout(graph)
  return {
    width: result.width ?? 0,
    height: result.height ?? 0,
    states: (result.children ?? []).map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      width: n.width ?? 0,
      height: n.height ?? 0
    })),
    transitions: (result.edges ?? []).map((e) => {
      const s = e.sections?.[0]
      const points = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : []
      const l = e.labels?.[0]
      return {
        id: e.id,
        from: e.sources[0]!,
        to: e.targets[0]!,
        points,
        ...(l?.text && {
          label: { text: l.text, x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0 }
        })
      }
    })
  }
}
