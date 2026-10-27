import { useEffect, useRef, type ReactNode } from 'react'
import {
  absolutePosition,
  allImported,
  canDerive,
  childModules,
  modulePath,
  moduleTypes,
  nameError,
  newId,
  removeBase,
  setAccess,
  setAttributeQualifier,
  setMethodQualifier,
  setQualifier,
  uniqueName,
  unimplementedMessages,
  unimplementedMethods
} from '@/model/project'
import {
  addPort,
  addSubmodule,
  addType,
  deleteItems,
  deletePort,
  reparentModule,
  setLocked,
  setModuleColor,
  update,
  useProjectStore
} from '@/store/project'
import { select, useSelection } from '@/store/ui'
import { useSettings } from '@/store/settings'
import { assignBinary } from '@/model/binaries'
import { navigate } from '@/actions'
import {
  AccessToggles,
  ColorPicker,
  CommitInput,
  IconButton,
  MetadataEditor,
  DeriveToggles,
  QualifierToggles,
  Row,
  Section,
  Select,
  TextArea,
  TYPE_KIND_BADGE,
  TYPE_KINDS
} from '@/components/fields'
import { TypeScopeContext } from '@/components/TypeEditor'
import {
  METHOD_QUALIFIERS,
  MODULE_KINDS,
  QUALIFIERS,
  type Module,
  type Project,
  type TypeDef
} from '@/model/types'
import { Icon } from '@/components/Icon'
import { DefaultInput, FieldList, setDefault } from './TypeInspector'
import { pickNewParent } from './moduleTree'
import { LifecycleSection } from './LifecycleSection'
import { FieldDetails, hasDetails } from './FieldDetails'
import { Locks } from './Locks'
import { StateMachineSection } from './StateMachineSection'
import { BaseArgs, TypeParamsSection } from './TypeParams'
import { AddConditions, ConditionList, setConditions, withCondition } from './Conditions'
import { addMessage, MessageList } from './MessageList'

/** Method qualifiers in two rows: about derivation, then the others. */
const INHERITANCE_QUALIFIERS = METHOD_QUALIFIERS.filter((q) =>
  ['virtual', 'pure', 'override', 'final'].includes(q)
)
const OTHER_QUALIFIERS = METHOD_QUALIFIERS.filter((q) => !INHERITANCE_QUALIFIERS.includes(q))

function withTypeOf(id: string, fn: (t: TypeDef) => void): void {
  update((d) => {
    const t = d.types.find((t) => t.id === id)
    if (t) fn(t)
  })
}

function withModule(id: string, fn: (m: Module, d: Project) => void): void {
  update((d) => {
    const m = d.modules.find((m) => m.id === id)
    if (m) fn(m, d)
  })
}

export function ModuleInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const sel = useSelection()
  const member = sel?.kind === 'module' ? sel.member : undefined
  const title = useRef<HTMLHeadingElement>(null)
  const derivesOn = useSettings((s) => s.featureDerives)
  const contractsOn = useSettings((s) => s.featureContracts)
  const concurrencyOn = useSettings((s) => s.featureConcurrency)
  // A member selected on the canvas (again) is scrolled into view.
  useEffect(() => {
    if (!member) return
    const frame = requestAnimationFrame(() =>
      title.current?.parentElement
        ?.querySelector(`[data-member="${CSS.escape(member)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    )
    return () => cancelAnimationFrame(frame)
  }, [sel, member])
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
      .sort((a, b) => a.label.localeCompare(b.label)),
    // Placed modules of dependencies, after this project's.
    ...allImported(project)
      .filter((m) => !bases.includes(m.id))
      .map((m) => ({ value: m.id, label: modulePath(project, m.id) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  ]
  const unimplemented = unimplementedMethods(project, id)
  // Messages of implemented interfaces with no method of the name yet.
  const missing = unimplementedMessages(project, mod).filter((u) => !u.method)
  const binaryOptions = [
    { value: '', label: '— none —' },
    ...project.binaries.map((b) => ({ value: b.id, label: b.name }))
  ]
  const interfaceOptions = [
    { value: '', label: '— none —' },
    ...project.interfaces.map((i) => ({ value: i.id, label: i.name }))
  ]

  // Type parameters have a section of their own.
  const types = moduleTypes(project, id).filter((t) => !(t.kind === 'primitive' && t.typeParam))

  return (
    // Its attributes and methods name types as it does.
    <TypeScopeContext.Provider value={id}>
      <h2 ref={title}>
        Module <small className="muted">{modulePath(project, id)}</small>
      </h2>
      <Row label="Name">
        <CommitInput
          value={mod.name}
          validate={(n) => nameError(project, { kind: 'module', id, parentId: mod.parentId }, n)}
          onCommit={(n) => withModule(id, (m) => void (m.name = n))}
        />
      </Row>
      <Row label="Parent" group>
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
            <IconButton icon="folder" title="Move to…" onClick={() => pickNewParent(id)} />
          </span>
        ) : (
          <span className="row-inline">
            <span className="muted">top level</span>
            <IconButton icon="folder" title="Move to…" onClick={() => pickNewParent(id)} />
          </span>
        )}
      </Row>
      <Row label="Kind">
        <span className="row-inline">
          <Select
            value={mod.kind ?? 'class'}
            options={MODULE_KINDS}
            onChange={(k) =>
              withModule(id, (m) => {
                if (k === 'class') delete m.kind
                else m.kind = k
                // An interface only declares pure methods; abstract modules are derived from.
                if (k === 'interface') for (const x of m.methods) setMethodQualifier(x, 'pure', true)
                if (k !== 'class') delete m.final
              })
            }
          />
          <label className="check" title="No module may derive from it">
            <input
              type="checkbox"
              checked={!!mod.final}
              disabled={!!mod.kind}
              onChange={(e) => withModule(id, (m) => setQualifier(m, 'final', e.target.checked))}
            />
            final
          </label>
        </span>
      </Row>
      {!mod.kind && (derivesOn || !!mod.derives?.length) && (
        <Row label="Derives" group>
          <DeriveToggles
            value={mod.derives}
            onChange={(v) =>
              withModule(id, (m) => {
                if (v.length) m.derives = v
                else delete m.derives
              })
            }
          />
        </Row>
      )}
      {!mod.parentId && (project.binaries.length > 0 || mod.binaryId) && (
        <Row label="Binary">
          <Select
            value={mod.binaryId ?? ''}
            options={binaryOptions}
            onChange={(b) => update((d) => assignBinary(d, [id], b || null))}
          />
        </Row>
      )}
      <TextArea value={mod.description} onChange={(v) => withModule(id, (m) => void (m.description = v))} />

      <TypeParamsSection mod={mod} project={project} />

      <Section title={`Implements (${mod.implements?.length ?? 0})`}>
        <div className="raises">
          {(mod.implements ?? []).map((iid) => (
            <span key={iid} className="chip">
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'interface', id: iid })}
              >
                {project.interfaces.find((i) => i.id === iid)?.name ?? '<deleted>'}
              </button>
              <IconButton
                icon="x"
                title="No longer implemented"
                onClick={() =>
                  withModule(id, (m) => {
                    m.implements = m.implements?.filter((x) => x !== iid)
                    if (!m.implements?.length) delete m.implements
                  })
                }
              />
            </span>
          ))}
          {project.interfaces.some((i) => !mod.implements?.includes(i.id)) && (
            <Select
              value=""
              options={[
                { value: '', label: '+ interface…' },
                ...project.interfaces
                  .filter((i) => !mod.implements?.includes(i.id))
                  .map((i) => ({ value: i.id, label: i.name }))
              ]}
              onChange={(v) => v && withModule(id, (m) => void (m.implements = [...(m.implements ?? []), v]))}
            />
          )}
        </div>
      </Section>

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
              <BaseArgs mod={mod} base={b} project={project} />
              <IconButton
                icon="x"
                title="Remove base"
                danger
                onClick={() =>
                  withModule(id, (m) => removeBase(m, b))
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

      <Section
        title={`Types (${types.length})`}
        actions={TYPE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="icon kind-add"
            title={`New ${k} of the module`}
            onClick={() => select({ kind: 'type', id: addType(k, id) })}
          >
            <Icon name="plus" />
            {TYPE_KIND_BADGE[k]}
          </button>
        ))}
      >
        <ul className="plain">
          {types.map((t) => (
            <li key={t.id} className="row-inline type-row">
              <span className={`kind-badge ${t.kind}`} title={t.kind}>
                {TYPE_KIND_BADGE[t.kind]}
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => navigate({ kind: 'type', id: t.id })}
              >
                {t.name}
              </button>
              <AccessToggles value={t.access} onChange={(a) => withTypeOf(t.id, (x) => setAccess(x, a))} />
            </li>
          ))}
        </ul>
        {!types.length && <p className="muted">No types.</p>}
      </Section>

      <Section
        title={`Attributes (${mod.attributes.length})`}
        actions={
          concurrencyOn && (
            <button
              type="button"
              title="A lock guarding attributes"
              onClick={() =>
                withModule(id, (m) => {
                  const locks = (m.locks ??= [])
                  locks.push({
                    id: newId(),
                    name: uniqueName(
                      'mutex',
                      locks.map((l) => l.name)
                    ),
                    kind: 'mutex'
                  })
                })
              }
            >
              <Icon name="plus" /> lock
            </button>
          )
        }
      >
        <FieldList
          fields={mod.attributes}
          addLabel="Add attribute"
          baseName="attribute"
          onChange={(fn) => withModule(id, (m) => fn(m.attributes))}
          column={(a, i) => (
            <>
              <AccessToggles
                value={a.access}
                onChange={(v) => withModule(id, (m) => setAccess(m.attributes[i]!, v))}
              />
              <QualifierToggles
                qualifiers={QUALIFIERS}
                value={a}
                short
                onChange={(q, on) => withModule(id, (m) => setAttributeQualifier(m.attributes[i]!, q, on))}
              />
            </>
          )}
          value={(a, i) => (
            <DefaultInput
              field={a}
              types={project.types}
              onChange={(v) => withModule(id, (m) => setDefault(m.attributes[i]!, v))}
            />
          )}
          details={(a, i) => (
            <FieldDetails
              field={a}
              attribute
              locks={mod.locks}
              change={(fn) => withModule(id, (m) => fn(m.attributes[i]!))}
            />
          )}
          detailed={hasDetails}
          focused={member}
        />
        <Locks mod={mod} withModule={(fn) => withModule(id, fn)} />
      </Section>

      <LifecycleSection
        mod={mod}
        types={project.types}
        withModule={(fn) => withModule(id, fn)}
        focused={member}
      />

      {(contractsOn || !!mod.invariants?.length) && (
        <Section
          title={`Invariants (${mod.invariants?.length ?? 0})`}
          actions={
            <button
              type="button"
              title="A condition on the attributes holding between calls of public methods"
              onClick={() => withModule(id, (m) => void (m.invariants = withCondition(m.invariants)))}
            >
              <Icon name="plus" /> invariant
            </button>
          }
        >
          <ConditionList
            label=""
            values={mod.invariants ?? []}
            onChange={(v) => withModule(id, (m) => setConditions(m, 'invariants', v))}
          />
        </Section>
      )}

      <Section
        title={`Methods (${mod.methods.length})`}
        actions={
          <>
            {unimplemented.length + missing.length > 0 && (
              <button
                type="button"
                title={`Implement ${[...unimplemented.map((u) => u.method.name), ...missing.map((u) => u.message.name)].join(', ')}`}
                onClick={() =>
                  withModule(id, (m) => {
                    for (const { message } of missing) {
                      const copy = structuredClone(message)
                      m.methods.push({
                        ...copy,
                        id: newId(),
                        params: copy.params.map((prm) => ({ ...prm, id: newId() }))
                      })
                    }
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
                <Icon name="plus" /> implement ({unimplemented.length + missing.length})
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
          focused={member}
          onChange={(fn) => withModule(id, (m) => fn(m.methods))}
          headerExtra={(x, change) => (
            <AccessToggles value={x.access} onChange={(v) => change((y) => setAccess(y, v))} />
          )}
          extra={(x, change) => (
            <>
              <QualifierToggles
                qualifiers={INHERITANCE_QUALIFIERS}
                value={x}
                onChange={(q, on) => change((y) => setMethodQualifier(y, q, on))}
              />
              <QualifierToggles
                qualifiers={OTHER_QUALIFIERS.filter(
                  (q) => q !== 'threadSafe' || concurrencyOn || x.threadSafe
                )}
                value={x}
                onChange={(q, on) => change((y) => setMethodQualifier(y, q, on))}
              />
              <ConditionList
                label="Preconditions"
                values={x.pre ?? []}
                onChange={(v) => change((y) => setConditions(y, 'pre', v))}
              />
              <ConditionList
                label="Postconditions (result: the returned value)"
                values={x.post ?? []}
                onChange={(v) => change((y) => setConditions(y, 'post', v))}
              />
              {contractsOn && (
                <AddConditions
                  lists={[
                    { label: 'precondition', add: () => change((y) => void (y.pre = withCondition(y.pre))) },
                    {
                      label: 'postcondition',
                      add: () => change((y) => void (y.post = withCondition(y.post)))
                    }
                  ]}
                />
              )}
            </>
          )}
          paramValue={(prm, change) =>
            // Only `in` parameters have a default.
            prm.direction === 'in' && (
              <DefaultInput
                field={prm}
                types={project.types}
                onChange={(v) => change((y) => setDefault(y, v))}
              />
            )
          }
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

      <StateMachineSection mod={mod} withModule={(fn) => withModule(id, fn)} />

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
        <div className="field-list">
          {mod.ports.map((pt) => (
            <div key={pt.id} className={`field-row port-${pt.role}`}>
              <div className="name">
                <CommitInput
                  value={pt.name}
                  validate={(n) => nameError(project, { kind: 'port', id: pt.id, moduleId: id }, n)}
                  onCommit={(n) =>
                    withModule(id, (m) => void (m.ports.find((p) => p.id === pt.id)!.name = n))
                  }
                />
              </div>
              <div className="column">
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
              </div>
              <div className="type">
                <Select
                  value={pt.interfaceId ?? ''}
                  options={interfaceOptions}
                  onChange={(v) =>
                    withModule(id, (m) => void (m.ports.find((p) => p.id === pt.id)!.interfaceId = v || null))
                  }
                />
              </div>
              <div className="actions-cell">
                {pt.interfaceId && (
                  <IconButton
                    icon="arrow-up-right"
                    title="Open interface"
                    onClick={() => navigate({ kind: 'interface', id: pt.interfaceId! })}
                  />
                )}
                <IconButton icon="x" title="Delete port" danger onClick={() => deletePort(id, pt.id)} />
              </div>
            </div>
          ))}
        </div>
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
    </TypeScopeContext.Provider>
  )
}
