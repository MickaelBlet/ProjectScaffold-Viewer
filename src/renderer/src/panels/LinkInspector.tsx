import type { ReactNode } from 'react'
import { findPort, IDENTIFIER_RE, modulePath } from '@/model/project'
import { deleteLink, update, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import { CommitInput, IconButton, NumberInput, Row, Section, Select, TextArea } from '@/components/fields'
import { PERFORMANCE_CLASSES, TRANSPORTS, type Endpoint, type Link } from '@/model/types'

function withLink(id: string, fn: (l: Link) => void): void {
  update((d) => {
    const l = d.links.find((l) => l.id === id)
    if (l) fn(l)
  })
}

export function LinkInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const link = project.links.find((l) => l.id === id)
  if (!link) return <p className="muted">Link deleted.</p>
  const c = link.constraints
  const fromPort = findPort(project, link.from.moduleId, link.from.portId)
  const toPort = findPort(project, link.to.moduleId, link.to.portId)
  const iface = project.interfaces.find((i) => i.id === fromPort?.interfaceId)
  const mismatch = (fromPort?.interfaceId ?? null) !== (toPort?.interfaceId ?? null)
  // The interface lives on the ports: set it on both ends.
  const setInterface = (v: string): void =>
    update((d) => {
      const l = d.links.find((l) => l.id === id)
      if (!l) return
      for (const e of [l.from, l.to]) {
        const p = findPort(d, e.moduleId, e.portId)
        if (p) p.interfaceId = v || null
      }
    })

  const endpoint = (e: Endpoint): ReactNode => (
    <button
      type="button"
      className="link-button"
      onClick={() => navigate({ kind: 'module', id: e.moduleId })}
    >
      {modulePath(project, e.moduleId)}:{findPort(project, e.moduleId, e.portId)?.name ?? '?'}
    </button>
  )

  return (
    <>
      <h2>Link</h2>
      <Row label="Name">
        <CommitInput
          value={link.name}
          validate={(n) =>
            !IDENTIFIER_RE.test(n)
              ? 'Must be an identifier'
              : project.links.some((l) => l.id !== id && l.name === n)
                ? 'Name already used'
                : null
          }
          onCommit={(n) => withLink(id, (l) => void (l.name = n))}
        />
      </Row>
      <Row label="From">{endpoint(link.from)}</Row>
      <Row label="To">{endpoint(link.to)}</Row>
      <Row label="Interface">
        <Select
          value={fromPort?.interfaceId ?? ''}
          options={[
            { value: '', label: '— none —' },
            ...project.interfaces.map((i) => ({ value: i.id, label: i.name }))
          ]}
          onChange={setInterface}
        />
        {iface && (
          <IconButton title="Open interface" onClick={() => select({ kind: 'interface', id: iface.id })}>
            ↗
          </IconButton>
        )}
      </Row>
      {mismatch && <p className="muted">Ends have different interfaces; picking one sets both ports.</p>}
      <TextArea value={link.description} onChange={(v) => withLink(id, (l) => void (l.description = v))} />

      <Section title="Direction">
        <Select
          value={c.direction}
          options={[
            { value: 'unidirectional', label: '→ Unidirectional (one way)' },
            { value: 'bidirectional', label: '⇄ Bidirectional (request / reply)' }
          ]}
          onChange={(v) =>
            withLink(id, (l) => {
              l.constraints.direction = v
              if (v === 'unidirectional') l.constraints.ack = { required: false }
            })
          }
        />
      </Section>

      <Section title="Acknowledgement">
        <label className="check">
          <input
            type="checkbox"
            checked={c.ack.required}
            disabled={c.direction === 'unidirectional'}
            onChange={(e) =>
              withLink(id, (l) => {
                l.constraints.ack.required = e.target.checked
                if (!e.target.checked) delete l.constraints.ack.timeoutMs
              })
            }
          />
          Ack required{' '}
          {c.direction === 'unidirectional' && (
            <small className="muted">(requires a bidirectional link)</small>
          )}
        </label>
        {c.ack.required && (
          <Row label="Timeout (ms)">
            <NumberInput
              value={c.ack.timeoutMs}
              min={0}
              placeholder="none"
              onChange={(v) => withLink(id, (l) => void (l.constraints.ack.timeoutMs = v))}
            />
          </Row>
        )}
      </Section>

      <Section title="Performance">
        <Row label="Class">
          <Select
            value={c.performance.class}
            options={PERFORMANCE_CLASSES}
            onChange={(v) => withLink(id, (l) => void (l.constraints.performance.class = v))}
          />
        </Row>
        <Row label="Max latency (ms)">
          <NumberInput
            value={c.performance.maxLatencyMs}
            min={0}
            placeholder="—"
            onChange={(v) => withLink(id, (l) => void (l.constraints.performance.maxLatencyMs = v))}
          />
        </Row>
        <Row label="Rate (Hz)">
          <NumberInput
            value={c.performance.rateHz}
            min={0}
            placeholder="—"
            onChange={(v) => withLink(id, (l) => void (l.constraints.performance.rateHz = v))}
          />
        </Row>
      </Section>

      <Section title="Remote">
        <label className="check">
          <input
            type="checkbox"
            checked={c.remote.enabled}
            onChange={(e) =>
              withLink(id, (l) => {
                l.constraints.remote.enabled = e.target.checked
                if (!e.target.checked) delete l.constraints.remote.transport
                else l.constraints.remote.transport ??= 'tcp'
              })
            }
          />
          Crosses process / machine boundary
        </label>
        {c.remote.enabled && (
          <Row label="Transport">
            <Select
              value={c.remote.transport ?? ''}
              options={[
                { value: '', label: '—' },
                ...TRANSPORTS.map((t) => ({ value: t, label: t })),
                // keep a custom value loaded from file selectable
                ...(c.remote.transport && !(TRANSPORTS as readonly string[]).includes(c.remote.transport)
                  ? [{ value: c.remote.transport, label: c.remote.transport }]
                  : [])
              ]}
              onChange={(v) => withLink(id, (l) => void (l.constraints.remote.transport = v || undefined))}
            />
          </Row>
        )}
      </Section>

      <div className="actions">
        <button
          type="button"
          onClick={() =>
            withLink(id, (l) => {
              ;[l.from, l.to] = [l.to, l.from]
            })
          }
          title="Swap endpoints"
        >
          Swap ends
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteLink(id)
            select(null)
          }}
        >
          Delete link
        </button>
      </div>
    </>
  )
}
