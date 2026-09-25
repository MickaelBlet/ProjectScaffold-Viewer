import type { ReactNode } from 'react'
import { update, useProjectStore } from '@/store/project'
import { MetadataEditor, Row, Section, TextArea } from '@/components/fields'

export function ProjectInspector(): ReactNode {
  const p = useProjectStore((s) => s.project)
  return (
    <>
      <h2>Project</h2>
      <Row label="Name">
        <input value={p.name} onChange={(e) => update((d) => void (d.name = e.target.value))} />
      </Row>
      <TextArea value={p.description} onChange={(v) => update((d) => void (d.description = v))} />
      <Section title="Metadata">
        <MetadataEditor value={p.metadata} onChange={(fn) => update((d) => fn(d.metadata))} />
      </Section>
      <Section title="Summary">
        <p className="muted">
          {p.modules.length} modules · {p.links.length} links · {p.types.length} types · {p.interfaces.length}{' '}
          interfaces
        </p>
        <p className="muted">
          Double-click the canvas to add a module. Drag from an <b>out</b> port (right) to an <b>in</b> port
          (left) to create a link. Drop a module onto another to nest it.
        </p>
      </Section>
    </>
  )
}
