import type { ReactNode } from 'react'
import {
  absolutePosition,
  canDerive,
  childModules,
  modulePath,
  nameError,
  newId,
  setMethodQualifier,
  setQualifier,
  unimplementedMethods
} from '@/model/project'
import {
  addPort,
  addSubmodule,
  deleteItems,
  deletePort,
  reparentModule,
  setLocked,
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
  QualifierToggles,
  Row,
  Section,
  Select,
  TextArea
} from '@/components/fields'
import { METHOD_QUALIFIERS, MODULE_KINDS, QUALIFIERS, type Module, type Project } from '@/model/types'
import { Icon } from '@/components/Icon'
import { DefaultInput, FieldList, setDefault } from './TypeInspector'
import { addMessage, MessageList } from './MessageList'

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
  const children = childModules(project, id)
  const bases = mod.bases ?? []
  const baseOptions = [
    { value: '', label: '+ add base…' },
    ...project.modules
      .filter((m) => !bases.includes(m.id) && canDerive(project, id, m.id))
      .map((m) => ({ value: m.id, label: modulePath(project, m.id) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  ]
  const unimplemented = unimplementedMethods(project, id)
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
              icon="level-up"
              title="Move to top level"
              onClick={() => {
                const abs = absolutePosition(project, id)
                reparentModule(id, null, abs.x, abs.y)
              }}
            />
          </span>
        ) : (
          <span className="muted">top level</span>
        )}
      </Row>
      <Row label="Kind">
        <Select
          value={mod.kind ?? 'class'}
          options={MODULE_KINDS}
          onChange={(k) =>
            withModule(id, (m) => {
              if (k === 'class') delete m.kind
              else m.kind = k
              // An interface only declares pure methods.
              if (k === 'interface') for (const x of m.methods) setMethodQualifier(x, 'pure', true)
            })
          }
        />
      </Row>
      <TextArea value={mod.description} onChange={(v) => withModule(id, (m) => void (m.description = v))} />

      <Section title={`Bases (${bases.length})`}>
        <ul className="plain">
          {bases.map((b) => (
            <li key={b} className="row-inline">
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'module', id: b })}
              >
                {modulePath(project, b) || '<deleted>'}
              </button>
              <IconButton
                icon="x"
                title="Remove base"
                danger
                onClick={() =>
                  withModule(id, (m) => {
                    m.bases = m.bases?.filter((x) => x !== b)
                    if (!m.bases?.length) delete m.bases
                  })
                }
              />
            </li>
          ))}
        </ul>
        {baseOptions.length > 1 && (
          <Select
            value=""
            options={baseOptions}
            onChange={(b) => b && withModule(id, (m) => void (m.bases = [...(m.bases ?? []), b]))}
          />
        )}
      </Section>

      <Section title={`Attributes (${mod.attributes.length})`}>
        <FieldList
          fields={mod.attributes}
          addLabel="Add attribute"
          baseName="attribute"
          onChange={(fn) => withModule(id, (m) => fn(m.attributes))}
          column={(a, i) => (
            <QualifierToggles
              qualifiers={QUALIFIERS}
              value={a}
              short
              onChange={(q, on) => withModule(id, (m) => setQualifier(m.attributes[i]!, q, on))}
            />
          )}
          value={(a, i) => (
            <DefaultInput
              field={a}
              types={project.types}
              onChange={(v) => withModule(id, (m) => setDefault(m.attributes[i]!, v))}
            />
          )}
        />
      </Section>

      <Section
        title={`Methods (${mod.methods.length})`}
        actions={
          <>
            {unimplemented.length > 0 && (
              <button
                type="button"
                title={`Override ${unimplemented.map((u) => u.method.name).join(', ')}`}
                onClick={() =>
                  withModule(id, (m) => {
                    for (const { method } of unimplemented) {
                      const copy = structuredClone(method)
                      delete copy.pure
                      m.methods.push({
                        ...copy,
                        id: newId(),
                        params: copy.params.map((prm) => ({ ...prm, id: newId() })),
                        virtual: true,
                        override: true
                      })
                    }
                  })
                }
              >
                <Icon name="plus" /> implement ({unimplemented.length})
              </button>
            )}
            <button type="button" onClick={() => withModule(id, (m) => addMessage(m.methods, 'method'))}>
              <Icon name="plus" /> method
            </button>
          </>
        }
      >
        <MessageList
          messages={mod.methods}
          noun="method"
          onChange={(fn) => withModule(id, (m) => fn(m.methods))}
          extra={(x, change) => (
            <QualifierToggles
              qualifiers={METHOD_QUALIFIERS}
              value={x}
              onChange={(q, on) => change((y) => setMethodQualifier(y, q, on))}
            />
          )}
          paramExtra={(prm, change) =>
            // Only `in` parameters can be const.
            prm.direction === 'in' && (
              <QualifierToggles
                qualifiers={['const']}
                value={prm}
                short
                onChange={(q, on) => change((y) => setQualifier(y, q, on))}
              />
            )
          }
        />
      </Section>

      <Section
        title={`Ports (${mod.ports.length})`}
        actions={
          <>
            <button type="button" onClick={() => addPort(id, 'in')}>
              <Icon name="plus" /> in
            </button>
            <button type="button" onClick={() => addPort(id, 'out')}>
              <Icon name="plus" /> out
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
                  {pt.interfaceId && (
                    <IconButton
                      icon="arrow-up-right"
                      title="Open interface"
                      onClick={() => navigate({ kind: 'interface', id: pt.interfaceId! })}
                    />
                  )}
                </td>
                <td>
                  <IconButton icon="x" title="Delete port" danger onClick={() => deletePort(id, pt.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mod.ports.length && <p className="muted">No ports. Links connect ports.</p>}
      </Section>

      <Section
        title={`Submodules (${children.length})`}
        actions={
          <button type="button" onClick={() => select({ kind: 'module', id: addSubmodule(id) })}>
            <Icon name="plus" /> add
          </button>
        }
      >
        <ul className="plain">
          {children.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'module', id: c.id })}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
        {!children.length && <p className="muted">No submodules.</p>}
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

      <Section title="Layout">
        <label className="check">
          <input type="checkbox" checked={!!mod.locked} onChange={(e) => setLocked([id], e.target.checked)} />
          Locked (position and size)
        </label>
      </Section>

      <Section title="Metadata">
        <MetadataEditor value={mod.metadata} onChange={(fn) => withModule(id, (m) => fn(m.metadata))} />
      </Section>

      <div className="actions">
        <button
          type="button"
          className="danger"
          onClick={() => {
            deleteItems([id])
            select(null)
          }}
        >
          Delete module
        </button>
      </div>
    </>
  )
}
