import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { activateDoc, cycleDoc, moveDoc, useDocs, type DocState } from '@/store/documents'
import { closeDocument, closeOtherDocuments, docTitle, newProject } from '@/fileOps'
import { openContextMenu } from '@/store/ui'
import { Icon } from '@/components/Icon'

/** Arrows (Home / End) activate the previous or next document; Alt+W closes the active one. */
function onTabKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const { docs } = useDocs.getState()
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') cycleDoc(e.key === 'ArrowLeft' ? -1 : 1)
  else if (e.key === 'Home' || e.key === 'End') activateDoc(docs[e.key === 'Home' ? 0 : docs.length - 1]!.id)
  else return
  e.preventDefault()
  // Keep the focus on the tab strip, on the newly active tab.
  const list = e.currentTarget.parentElement
  requestAnimationFrame(() => list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
}

function DocTab({ doc, active, index }: { doc: DocState; active: boolean; index: number }): ReactNode {
  const dirty = useStore(doc.store, (s) => s.project !== doc.savedProject)
  const [over, setOver] = useState(false)
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onKeyDown={onTabKeyDown}
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
        aria-label={`Close ${docTitle(doc)}${dirty ? ' (unsaved changes)' : ''}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => closeDocument(doc.id)}
      >
        <Icon name="dot" />
        <Icon name="x" />
      </button>
    </div>
  )
}

export function DocTabs(): ReactNode {
  const docs = useDocs((s) => s.docs)
  const activeId = useDocs((s) => s.activeId)
  return (
    <div className="doc-tabs" role="tablist" aria-label="Documents">
      {docs.map((d, i) => (
        <DocTab key={d.id} doc={d} index={i} active={d.id === activeId} />
      ))}
      <button type="button" className="doc-new" title="New project (Alt+N)" onClick={newProject}>
        <Icon name="plus" />
      </button>
    </div>
  )
}
