// Opening, saving and closing the text files edited in tabs beside a document (store/textFiles.ts).
import type { TextSpot } from '@/model/search'
import { activeDoc } from '@/store/documents'
import { showDialog } from '@/store/ui'
import {
  addTextFile,
  dirtyFiles,
  dropTextFile,
  fileBaseName,
  isFileDirty,
  loadTextFile,
  saveTextFile,
  sourceDir,
  textFileKey,
  useTextFiles,
  useTextReveals,
  type TextFileRef
} from '@/store/textFiles'
import { activeFilePanel, openFilePanel } from '@/shell/controllers'

const IDL_FILES = { description: 'IDL files', extensions: ['idl'] }

/**
 * Opens a text file in a tab of the active document, read from its source unless `content` is given,
 * selecting `at`; in its own editor when the host has one for it (VS Code).
 */
export async function openTextFile(
  ref: TextFileRef,
  options: { content?: string; split?: boolean; at?: TextSpot } = {}
): Promise<void> {
  const doc = activeDoc()
  if (ref.source === 'templates' || ref.source === 'output') {
    const dir = await sourceDir(doc, ref.source).catch(() => null)
    if (dir?.open) return dir.open(ref.path, options.at)
  }
  const at = options.at
  if (at) useTextReveals.setState({ [textFileKey(doc.id, ref)]: at })
  addTextFile(doc.id, ref, options.content)
  openFilePanel(ref, options)
  if (useTextFiles.getState().files[textFileKey(doc.id, ref)]?.saved === null) await loadTextFile(doc.id, ref)
}

/** Opens IDL files as text, to edit them. */
export async function openIdlText(): Promise<void> {
  try {
    for (const f of await window.api.openFiles(IDL_FILES))
      await openTextFile({ source: 'file', path: f.path }, { content: f.content })
  } catch (e) {
    showDialog('Cannot open the IDL file', [e instanceof Error ? e.message : String(e)])
  }
}

/**
 * Opens an IDL dependency as text: the tab already editing it, else the file picked earlier in this
 * session, else the file to pick again.
 */
export async function openIdlDependency(file: string): Promise<void> {
  const ref: TextFileRef = { source: 'file', path: file }
  const open = useTextFiles.getState().files[textFileKey(activeDoc().id, ref)]
  if (open && open.saved !== null) return openTextFile(ref)
  const content = await window.api.readPicked?.(file)
  if (content != null) return openTextFile(ref, { content })
  await openIdlText()
}

/** Saves the text file of the active editor tab; false when the active tab is no text file. */
export function saveActiveTextFile(): boolean {
  const ref = activeFilePanel()
  if (!ref) return false
  void saveTextFile(activeDoc().id, ref)
  return true
}

/** Whether a text file tab may close: asks when it holds edits, which are then dropped. */
export function confirmCloseTextFile(ref: TextFileRef): boolean {
  const doc = activeDoc()
  const f = useTextFiles.getState().files[textFileKey(doc.id, ref)]
  if (isFileDirty(f) && !window.confirm(`Discard unsaved changes to ${fileBaseName(ref.path)}?`)) return false
  dropTextFile(doc.id, ref)
  return true
}

/** Line telling the unsaved text files of a document, for the confirmation of closing it. */
export function unsavedTextFiles(docId: string): string {
  return dirtyFiles(docId)
    .map((f) => fileBaseName(f.path))
    .join(', ')
}
