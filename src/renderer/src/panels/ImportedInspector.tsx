import type { ReactNode } from 'react'
import { findImported, IDENTIFIER_RE, importedParent, methodQualifierText, refNamer } from '@/model/project'
import { printTypeRef } from '@/model/typeExpr'
import { deleteItems, renameDependency, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { navigate, openImportSource, refreshDependencies, showDependency } from '@/actions'
import { CommitInput, Row, Section } from '@/components/fields'
import { AccessIcon } from '@/components/Icon'

/** A module of a dependency placed on the canvas: read-only, refreshed from that project. */
export function ImportedInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const found = findImported(project, id)
  if (!found) return <p className="muted">Imported module removed.</p>
  const { dep, module } = found
  // Content of a placed module: placed and removed with it.
  const parent = importedParent(dep, module)
  const links = project.links.filter((l) => l.from.moduleId === id || l.to.moduleId === id)
  const nameOf = refNamer(project)
  const type = (t: Parameters<typeof printTypeRef>[0]): string => printTypeRef(t, nameOf)
  const attributes = module.attributes ?? []
  const methods = module.methods ?? []

  return (
    <>
      <h2>
        Linked module <small className="muted">{dep.file}</small>
      </h2>
      <Row label="Dependency">
        <CommitInput
          value={dep.name}
          validate={(n) =>
            !IDENTIFIER_RE.test(n)
              ? 'Must be an identifier'
              : project.dependencies.some((x) => x.id !== dep.id && x.name === n)
                ? 'Name already used'
                : null
          }
          onCommit={(n) => renameDependency(dep.id, n)}
        />
      </Row>
      <Row label="Module">
        <span>{module.path}</span>
      </Row>
      {parent && <p className="muted">Inside {parent.path}: placed and removed with it.</p>}
      <p className="muted">
        Attributes, methods and ports as last read from {dep.file}. Port interfaces are those of the same name
        here, from the dependency.
      </p>

      {attributes.length > 0 && (
        <Section title={`Attributes (${attributes.length})`}>
          <table className="grid">
            <tbody>
              {attributes.map((a) => (
                <tr key={a.id} title={a.description}>
                  <td>
                    <span className="attr-access">
                      <AccessIcon access={a.access} />
                    </span>
                  </td>
                  <td>{a.name}</td>
                  <td>
                    {type(a.type)}
                    {a.const && ' const'}
                    {a.static && ' static'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {methods.length > 0 && (
        <Section title={`Methods (${methods.length})`}>
          <table className="grid">
            <tbody>
              {methods.map((m) => (
                <tr key={m.id} title={m.description}>
                  <td>
                    <span className="attr-access">
                      <AccessIcon access={m.access} />
                    </span>
                  </td>
                  <td>
                    {methodQualifierText(m).before}
                    {m.name}(
                    {m.params
                      .map(
                        (prm) =>
                          `${prm.direction === 'in' ? '' : `${prm.direction} `}${prm.name}: ${type(prm.type)}`
                      )
                      .join(', ')}
                    ){m.returns && `: ${type(m.returns)}`}
                    {methodQualifierText(m).after}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title={`Ports (${module.ports.length})`}>
        <table className="grid">
          <tbody>
            {module.ports.map((pt) => {
              const known = !pt.interface || project.interfaces.some((i) => i.name === pt.interface)
              return (
                <tr key={pt.id} title={pt.description}>
                  <td>{pt.role}</td>
                  <td>{pt.name}</td>
                  <td className={known ? '' : 'error-text'}>
                    {pt.interface ?? '—'}
                    {!known && ' (not defined here)'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!module.ports.length && <p className="muted">No ports.</p>}
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

      <div className="actions">
        <button type="button" onClick={() => void refreshDependencies([dep.id])} title="Read the ports again">
          Refresh
        </button>
        <button type="button" onClick={() => showDependency(dep.id)}>
          Show dependency
        </button>
        <button type="button" onClick={() => openImportSource(dep.file)}>
          Open project
        </button>
        {!parent && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              deleteItems([id])
              select(null)
            }}
          >
            Remove
          </button>
        )}
      </div>
    </>
  )
}
