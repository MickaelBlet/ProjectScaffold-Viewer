import type { ReactNode } from 'react'
import { absolutePosition, modulePath, nameError } from '@/model/project'
import {
  addPort,
  addSubmodule,
  deleteModule,
  deletePort,
  reparentModule,
  setModuleColor,
  update,
  useProjectStore
} from '@/store/project'
import { select } from '@/store/ui'
import { navigate } from '@/actions'
import {
  ColorPicker,
  CommitInput,
  IconButton,
  MetadataEditor,
  Row,
  Section,
  Select,
  TextArea
} from '@/components/fields'
import type { Module, Project } from '@/model/types'

function withModule(id: string, fn: (m: Module, d: Project) => void): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === id)
    if (m) fn(m, d)
  })
}

export function ModuleInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const mod = project.modules.find((m) => m.id === id)
  if (!mod) return <p className="muted">Module deleted.</p>
  const links = project.links.filter((l) => l.from.moduleId === id || l.to.moduleId === id)
  const parent = mod.parentId ? modulePath(project, mod.parentId) : null
  const interfaceOptions = [
    { value: '', label: '— none —' },
    ...project.interfaces.map((i) => ({ value: i.id, label: i.name }))
  ]

  return (
    <>
      <h2>
        Module <small className="muted">{modulePath(project, id)}</small>
      </h2>
      <Row label="Name">
        <CommitInput
          value={mod.name}
          validate={(n) => nameError(project, { kind: 'module', id, parentId: mod.parentId }, n)}
          onCommit={(n) => withModule(id, (m) => void (m.name = n))}
        />
      </Row>
      <Row label="Parent">
        {parent ? (
          <span className="row-inline">
            <button
              type="button"
              className="link-button"
              onClick={() => navigate({ kind: 'module', id: mod.parentId! })}
            >
              {parent}
            </button>
            <IconButton
              title="Move to top level"
              onClick={() => {
                const abs = absolutePosition(project, id)
                reparentModule(id, null, abs.x, abs.y)
              }}
            >
              ⇱
            </IconButton>
          </span>
        ) : (
          <span className="muted">top level</span>
        )}
      </Row>
      <TextArea value={mod.description} onChange={(v) => withModule(id, (m) => void (m.description = v))} />

      <Section
        title={`Ports (${mod.ports.length})`}
        actions={
          <>
            <button type="button" onClick={() => addPort(id, 'in')}>
              + in
            </button>
            <button type="button" onClick={() => addPort(id, 'out')}>
              + out
            </button>
          </>
        }
      >
        <table className="grid">
          <tbody>
            {mod.ports.map((pt) => (
              <tr key={pt.id}>
                <td>
                  <Select
                    value={pt.role}
                    options={['in', 'out'] as const}
                    onChange={(role) =>
                      withModule(id, (m, d) => {
                        const p = m.ports.find((p) => p.id === pt.id)!
                        p.role = role
                        // A role change invalidates the port's links.
                        d.links = d.links.filter((l) => l.from.portId !== pt.id && l.to.portId !== pt.id)
                      })
                    }
                  />
                </td>
                <td>
                  <CommitInput
                    value={pt.name}
                    validate={(n) => nameError(project, { kind: 'port', id: pt.id, moduleId: id }, n)}
                    onCommit={(n) =>
                      withModule(id, (m) => void (m.ports.find((p) => p.id === pt.id)!.name = n))
                    }
                  />
                </td>
                <td>
                  <Select
                    value={pt.interfaceId ?? ''}
                    options={interfaceOptions}
                    onChange={(v) =>
                      withModule(
                        id,
                        (m) => void (m.ports.find((p) => p.id === pt.id)!.interfaceId = v || null)
                      )
                    }
                  />
                </td>
                <td>
                  <IconButton title="Delete port" danger onClick={() => deletePort(id, pt.id)}>
                    ×
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mod.ports.length && <p className="muted">No ports. Links connect ports.</p>}
      </Section>

      <Section title={`Links (${links.length})`}>
        <ul className="plain">
          {links.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'link', id: l.id })}
              >
                {l.name}
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Color">
        <ColorPicker value={mod.color} onChange={(c) => setModuleColor([id], c)} />
      </Section>

      <Section title="Metadata">
        <MetadataEditor value={mod.metadata} onChange={(fn) => withModule(id, (m) => fn(m.metadata))} />
      </Section>

      <div className="actions">
        <button type="button" onClick={() => select({ kind: 'module', id: addSubmodule(id) })}>
          + Submodule
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteModule(id)
            select(null)
          }}
        >
          Delete module
        </button>
      </div>
    </>
  )
}
