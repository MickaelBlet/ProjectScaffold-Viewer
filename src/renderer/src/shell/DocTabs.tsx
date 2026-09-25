import { useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { activateDoc, moveDoc, useDocs, type DocState } from '@/store/documents'
import { closeDocument, closeOtherDocuments, docTitle, newProject } from '@/fileOps'
import { openContextMenu } from '@/store/ui'

function DocTab({ doc, active, index }: { doc: DocState; active: boolean; index: number }): ReactNode {
  const project = useStore(doc.store, (s) => s.project)
  const dirty = doc.savedProject !== project
  const [over, setOver] = useState(false)
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`doc-tab ${active ? 'active' : ''} ${over ? 'drop' : ''}`}
      title={doc.filePath ?? 'Unsaved project'}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-doc-tab', doc.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-doc-tab')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer.getData('application/x-doc-tab')
        if (id) moveDoc(id, index)
      }}
      onMouseDown={(e) => {
        if (e.button === 0) activateDoc(doc.id)
      }}
      onAuxClick={(e) => {
        if (e.button === 1) closeDocument(doc.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e, [
          { label: 'Close', keys: 'Alt+W', run: () => closeDocument(doc.id) },
          { label: 'Close others', run: () => closeOtherDocuments(doc.id) }
        ])
      }}
    >
      <span className="doc-name">{docTitle(doc)}</span>
      {index < 9 && <small className="doc-key">Alt+{index + 1}</small>}
      <button
        type="button"
        className={`doc-close ${dirty ? 'dirty' : ''}`}
        title={dirty ? 'Unsaved changes — close' : 'Close'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => closeDocument(doc.id)}
      >
        <span className="dot">●</span>
        <span className="x">×</span>
      </button>
    </div>
  )
}

export function DocTabs(): ReactNode {
  const docs = useDocs((s) => s.docs)
  const activeId = useDocs((s) => s.activeId)
  return (
    <div className="doc-tabs" role="tablist">
      {docs.map((d, i) => (
        <DocTab key={d.id} doc={d} index={i} active={d.id === activeId} />
      ))}
      <button type="button" className="doc-new" title="New project (Alt+N)" onClick={newProject}>
        +
      </button>
    </div>
  )
}
