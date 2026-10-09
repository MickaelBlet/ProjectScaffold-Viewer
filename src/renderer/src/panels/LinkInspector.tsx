import { Fragment, useState, type ReactNode } from 'react'
import { findPort, IDENTIFIER_RE, isImportedId, modulePath, transportError } from '@/model/project'
import { deleteLink, reverseLink, update, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import {
  CommitInput,
  IconButton,
  MetadataEditor,
  NumberInput,
  Row,
  Section,
  Select,
  TextArea
} from '@/components/fields'
import { dependencyName } from '@/model/dependencies'
import { snake } from '@/codegen/filters'
import {
  DEFAULT_BASE_PORT,
  DEFAULT_HOST,
  DEFAULT_SHM_CAPACITY,
  pruneSettings,
  transportFields
} from '@/model/transports'
import {
  PERFORMANCE_CLASSES,
  TRANSPORTS,
  type Endpoint,
  type HostPort,
  type Link,
  type Project,
  type TransportSettings
} from '@/model/types'

function withLink(id: string, fn: (l: Link) => void): void {
  update((d) => {
    const l = d.links.find((l) => l.id === id)
    if (l) fn(l)
  })
}

const NEW_TRANSPORT = '\0new'

/** Set the transport of a link, declaring it in the project when it is new. */
function setTransport(id: string, transport: string | undefined): void {
  update((d) => {
    const l = d.links.find((l) => l.id === id)
    if (!l) return
    const remote = l.constraints.remote
    remote.transport = transport
    const settings = pruneSettings(remote.settings, transport)
    if (settings) remote.settings = settings
    else delete remote.settings
    if (transport && !transportError(d, transport)) d.transports.push(transport)
  })
}

/** Edit the transport settings of a link, dropping what ends up empty. */
function withSettings(id: string, fn: (s: TransportSettings) => void): void {
  withLink(id, (l) => {
    const remote = l.constraints.remote
    const s = remote.settings ?? {}
    fn(s)
    const settings = pruneSettings(s, remote.transport)
    if (settings) remote.settings = settings
    else delete remote.settings
  })
}

type End = 'client' | 'server' | 'broker'
type Text = 'path' | 'name' | 'socket' | 'topic' | 'interface' | 'device'
type Count = 'capacity' | 'id' | 'baud'

const LABELS: Record<End | Text | Count, string> = {
  client: 'Client',
  server: 'Server',
  broker: 'Broker',
  path: 'Path',
  name: 'Segment',
  socket: 'Socket',
  topic: 'Topic',
  interface: 'Interface',
  device: 'Device',
  capacity: 'Capacity (bytes)',
  id: 'Frame id',
  baud: 'Baud rate'
}

/** Fields of the settings of the link's transport, placeholders showing their defaults. */
function TransportSettingsFields({ project, link }: { project: Project; link: Link }): ReactNode {
  const { id, name } = link
  const remote = link.constraints.remote
  const s = remote.settings ?? {}
  const defaults = project.remoteDefaults ?? {}
  const end = (e: End): ReactNode => {
    const at: HostPort = s[e] ?? {}
    const host = e === 'broker' ? undefined : (defaults[e]?.host ?? DEFAULT_HOST)
    const port = e === 'broker' ? undefined : `${defaults.basePort ?? DEFAULT_BASE_PORT} + n`
    const set = (fn: (h: HostPort) => void): void =>
      withSettings(id, (d) => {
        d[e] ??= {}
        fn(d[e])
      })
    return (
      <Fragment key={e}>
        <Row label={`${LABELS[e]} host`}>
          <CommitInput
            value={at.host ?? ''}
            placeholder={host}
            onCommit={(v) => set((h) => void (h.host = v || undefined))}
          />
        </Row>
        <Row label={`${LABELS[e]} port`}>
          <NumberInput
            value={at.port}
            integer
            min={1}
            placeholder={port}
            onChange={(v) => set((h) => void (h.port = v))}
          />
        </Row>
      </Fragment>
    )
  }
  const placeholders: Partial<Record<Text | Count, string>> = {
    path: `/${name}`,
    name: snake(`${dependencyName(project.name)}_${name}`),
    capacity: String(DEFAULT_SHM_CAPACITY)
  }
  const text = (f: Text): ReactNode => (
    <Row key={f} label={LABELS[f]}>
      <CommitInput
        value={s[f] ?? ''}
        placeholder={placeholders[f]}
        onCommit={(v) => withSettings(id, (d) => void (d[f] = v || undefined))}
      />
    </Row>
  )
  const count = (f: Count): ReactNode => (
    <Row key={f} label={LABELS[f]}>
      <NumberInput
        value={s[f]}
        integer
        min={f === 'id' ? 0 : 1}
        placeholder={placeholders[f]}
        onChange={(v) => withSettings(id, (d) => void (d[f] = v))}
      />
    </Row>
  )
  return (
    <>
      {transportFields(remote.transport).map((f) =>
        f === 'client' || f === 'server' || f === 'broker'
          ? end(f)
          : f === 'capacity' || f === 'id' || f === 'baud'
            ? count(f)
            : text(f)
      )}
      <div className="row">
        <span className="row-label">Options</span>
      </div>
      <MetadataEditor
        value={s.options ?? {}}
        onChange={(fn) =>
          withSettings(id, (d) => {
            d.options ??= {}
            fn(d.options)
          })
        }
      />
    </>
  )
}

/** Transport select, with an entry to declare a new transport inline. */
function TransportField({ id, value }: { id: string; value: string | undefined }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const transports = [...TRANSPORTS, ...project.transports]
  const declared = !value || transports.includes(value)

  if (adding) {
    const error = draft ? transportError(project, draft) : null
    const close = (): void => {
      setAdding(false)
      setDraft('')
    }
    const commit = (): void => {
      if (draft && !error) setTransport(id, draft)
      close()
    }
    return (
      <span className="field">
        <input
          className={error ? 'invalid' : ''}
          value={draft}
          placeholder="New transport"
          autoFocus
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') close()
          }}
        />
        {error && <span className="field-error">{error}</span>}
      </span>
    )
  }
  return (
    <>
      <Select
        value={value ?? ''}
        options={[
          { value: '', label: '—' },
          ...transports.map((t) => ({ value: t, label: t })),
          // keep an undeclared value loaded from file selectable
          ...(declared ? [] : [{ value, label: `${value} (undeclared)` }]),
          { value: NEW_TRANSPORT, label: 'New transport…' }
        ]}
        onChange={(v) => (v === NEW_TRANSPORT ? setAdding(true) : setTransport(id, v || undefined))}
      />
      {!declared && (
        <IconButton
          icon="plus"
          title="Declare this transport in the project"
          onClick={() => update((d) => void d.transports.push(value))}
        />
      )}
    </>
  )
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
          <IconButton
            icon="arrow-up-right"
            title="Open interface"
            onClick={() => select({ kind: 'interface', id: iface.id })}
          />
        )}
      </Row>
      {mismatch && <p className="muted">Ends have different interfaces; picking one sets both ports.</p>}
      {(isImportedId(link.from.moduleId) || isImportedId(link.to.moduleId)) && (
        <p className="muted">
          The port of the other project keeps its interface: this project&apos;s interface of the same name.
        </p>
      )}
      <TextArea value={link.description} onChange={(v) => withLink(id, (l) => void (l.description = v))} />

      <Section title="Direction">
        <Select
          value={c.direction}
          options={[
            { value: 'unidirectional', label: 'Unidirectional (one way)' },
            { value: 'bidirectional', label: 'Bidirectional (request / reply)' }
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
                if (!e.target.checked) {
                  delete l.constraints.remote.transport
                  delete l.constraints.remote.settings
                } else l.constraints.remote.transport ??= 'tcp'
              })
            }
          />
          Crosses process / machine boundary
        </label>
        {c.remote.enabled && (
          <Row label="Transport">
            <TransportField id={id} value={c.remote.transport} />
          </Row>
        )}
      </Section>

      {c.remote.enabled && c.remote.transport && (
        <Section title="Transport settings">
          <TransportSettingsFields project={project} link={link} />
        </Section>
      )}

      <div className="actions">
        <button type="button" onClick={() => reverseLink(id)} title="Swap endpoints">
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
