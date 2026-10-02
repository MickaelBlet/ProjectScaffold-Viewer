// Text files edited in tabs beside a document's views: its templates, its generated files, IDL files.
import { create } from 'zustand'
import type { OutputDir } from '@/codegen/run'
import { builtinFile, knownOutputDir, templateFolder } from '@/generateCode'
import type { Id } from '@/model/types'
import { findDoc, type DocState } from './documents'

/**
 * Where a text file is: the document's template folder, its output directory (generated files, and
 * the `.scaffold/templates` there), the built-in templates (read-only), or a file opened on its own.
 */
export type TextSource = 'templates' | 'output' | 'builtin' | 'file'

export interface TextFileRef {
  source: TextSource
  /** Relative to the folder of the source; the path (name) the host gave for `file`. */
  path: string
}

export interface TextFile extends TextFileRef {
  text: string
  /** Content of the file as last read or written; null until read. */
  saved: string | null
  /** Why it could not be read or written. */
  error: string | null
  /** The file changed elsewhere while edited here. */
  stale: boolean
}

interface TextFilesState {
  /** By `textFileKey`. */
  files: Record<string, TextFile>
}

export const useTextFiles = create<TextFilesState>(() => ({ files: {} }))

export const textFileKey = (docId: Id, ref: TextFileRef): string => `${docId}|${ref.source}:${ref.path}`
export const isReadOnly = (ref: TextFileRef): boolean => ref.source === 'builtin'
export const isFileDirty = (f: TextFile | undefined): boolean => !!f && f.saved !== null && f.text !== f.saved
export const fileBaseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Edited files not saved, of one document or of all. */
export function dirtyFiles(docId?: Id): TextFile[] {
  const prefix = docId === undefined ? '' : `${docId}|`
  return Object.entries(useTextFiles.getState().files)
    .filter(([k, f]) => k.startsWith(prefix) && isFileDirty(f))
    .map(([, f]) => f)
}

function patch(key: string, p: Partial<TextFile>): void {
  useTextFiles.setState((s) => {
    const f = s.files[key]
    return f ? { files: { ...s.files, [key]: { ...f, ...p } } } : s
  })
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Folder the files of a source are read from and written to; null when there is none (yet). */
export async function sourceDir(doc: DocState, source: TextSource): Promise<OutputDir | null> {
  if (source === 'templates') return templateFolder(doc)
  if (source === 'output') return knownOutputDir(doc)
  return null
}

/** Content of a file; null when it does not exist. `file`: only when it changed since last read. */
async function read(doc: DocState, ref: TextFileRef): Promise<string | null> {
  switch (ref.source) {
    case 'builtin':
      return builtinFile(ref.path)
    case 'file':
      return window.api.changedOnDisk(ref.path)
    default: {
      const dir = await sourceDir(doc, ref.source)
      if (!dir) throw new Error(ref.source === 'templates' ? 'no template folder' : 'no output directory')
      return dir.read(ref.path)
    }
  }
}

/** Starts editing a file: with its content when the caller has it, else read (see `loadTextFile`). */
export function addTextFile(docId: Id, ref: TextFileRef, content?: string): void {
  const key = textFileKey(docId, ref)
  if (useTextFiles.getState().files[key]) {
    if (content !== undefined && !isFileDirty(useTextFiles.getState().files[key]))
      patch(key, { text: content, saved: content, error: null, stale: false })
    return
  }
  const file: TextFile = {
    ...ref,
    text: content ?? '',
    saved: content ?? null,
    error: null,
    stale: false
  }
  useTextFiles.setState((s) => ({ files: { ...s.files, [key]: file } }))
}

/** Reads a file again: its edits are dropped. */
export async function loadTextFile(docId: Id, ref: TextFileRef): Promise<void> {
  const doc = findDoc(docId)
  const key = textFileKey(docId, ref)
  if (!doc) return
  if (ref.source === 'file') {
    // Read again only when it changed since: as it was read or written here otherwise.
    const f = useTextFiles.getState().files[key]
    const text = (await window.api.changedOnDisk(ref.path).catch(() => null)) ?? f?.saved ?? null
    if (text === null)
      patch(key, { error: 'This file is no longer at hand: open it again (File › Open IDL file…).' })
    else patch(key, { text, saved: text, error: null, stale: false })
    return
  }
  try {
    const text = await read(doc, ref)
    if (text === null) patch(key, { error: `${ref.path} does not exist` })
    else patch(key, { text, saved: text, error: null, stale: false })
  } catch (e) {
    patch(key, { error: message(e) })
  }
}

/** Takes the changes made elsewhere to a file: in place when it holds no edits, else marked stale. */
export async function checkTextFile(docId: Id, ref: TextFileRef): Promise<void> {
  const doc = findDoc(docId)
  const key = textFileKey(docId, ref)
  const f = useTextFiles.getState().files[key]
  if (!doc || !f || f.saved === null || ref.source === 'builtin') return
  let text: string | null
  try {
    text = await read(doc, ref)
  } catch {
    // Not readable without a user gesture (folder access): checked again on the next focus.
    return
  }
  const now = useTextFiles.getState().files[key]
  if (text === null || !now || text === now.saved) return
  if (isFileDirty(now)) patch(key, { stale: true })
  else patch(key, { text, saved: text, stale: false })
}

export function editTextFile(docId: Id, ref: TextFileRef, text: string): void {
  patch(textFileKey(docId, ref), { text })
}

/** Writes a file; false when it could not be (the error is kept on the file) or was cancelled. */
export async function saveTextFile(docId: Id, ref: TextFileRef): Promise<boolean> {
  const doc = findDoc(docId)
  const key = textFileKey(docId, ref)
  const f = useTextFiles.getState().files[key]
  if (!doc || !f || isReadOnly(ref)) return false
  const text = f.text
  try {
    if (ref.source === 'file') {
      const path = await window.api.saveFile({
        path: ref.path,
        content: text,
        defaultName: fileBaseName(ref.path),
        format: 'text'
      })
      if (!path) return false
    } else {
      const dir = await sourceDir(doc, ref.source)
      if (!dir) throw new Error(ref.source === 'templates' ? 'no template folder' : 'no output directory')
      await dir.write(ref.path, text)
    }
    patch(key, { saved: text, error: null, stale: false })
    return true
  } catch (e) {
    patch(key, { error: message(e) })
    return false
  }
}

export function dropTextFile(docId: Id, ref: TextFileRef): void {
  const key = textFileKey(docId, ref)
  useTextFiles.setState((s) => {
    if (!s.files[key]) return s
    const files = { ...s.files }
    delete files[key]
    return { files }
  })
}

/** Forgets the files of a closed document. */
export function dropDocTextFiles(docId: Id): void {
  useTextFiles.setState((s) => ({
    files: Object.fromEntries(Object.entries(s.files).filter(([k]) => !k.startsWith(`${docId}|`)))
  }))
}
