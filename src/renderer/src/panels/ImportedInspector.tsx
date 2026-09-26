import type { ReactNode } from 'react'
import { findImported, IDENTIFIER_RE } from '@/model/project'
import { deleteItems, renameImport, useProjectStore } from '@/store/project'
import { select } from '@/store/ui'
import { navigate, openImportSource, refreshImports } from '@/actions'
import { CommitInput, Row, Section } from '@/components/fields'

/** A module of another project placed on the canvas: read-only, refreshed from that project. */
export function ImportedInspector({ id }: { id: string }): ReactNode {
  const project = useProjectStore((s) => s.project)
  const found = findImported(project, id)
  if (!found) return <p className="muted">Imported module removed.</p>
  const { imp, module } = found
  const links = project.links.filter((l) => l.from.moduleId === id || l.to.moduleId === id)

  return (
    <>
      <h2>
        Linked module <small className="muted">{imp.file}</small>
      </h2>
      <Row label="Project">
        <CommitInput
          value={imp.name}
          validate={(n) =>
            !IDENTIFIER_RE.test(n)
              ? 'Must be an identifier'
              : project.imports.some((i) => i.id !== imp.id && i.name === n)
                ? 'Name already used'
                : null
          }
          onCommit={(n) => renameImport(imp.id, n)}
        />
      </Row>
      <Row label="Module">
        <span>{module.path}</span>
      </Row>
      <p className="muted">
        Ports as last read from {imp.file}. Their interfaces are this project&apos;s interfaces of the same
        name.
      </p>

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
        <button type="button" onClick={() => refreshImports([imp.id])} title="Read the ports again">
          Refresh
        </button>
        <button type="button" onClick={() => openImportSource(imp.file)}>
          Open project
        </button>
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
      </div>
    </>
  )
}
