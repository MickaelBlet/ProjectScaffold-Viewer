// Files of a document's code generation: the templates generating it and the files generated, listed by
// the Code generation panel and Go to (Ctrl+P).
import { generatedFiles, LOCAL_TEMPLATES } from '@/codegen/run'
import { MANIFEST, parseManifest, templateFiles } from '@/codegen/templateSet'
import { builtinTemplates, knownOutputDir, projectTemplateSet, templateFolder } from '@/generateCode'
import type { DocState } from '@/store/documents'
import type { TextSource } from '@/store/textFiles'

/** Files of a folder, opened from `source` under `prefix`. */
export interface Listing {
  label: string
  source: TextSource
  prefix: string
  files: string[]
}

const sorted = (files: string[]): string[] => [MANIFEST, ...files.filter((f) => f !== MANIFEST).sort()]

/** Templates generating the document: its template folder, else the output directory's, else built-in. */
export async function templateListing(doc: DocState): Promise<Listing> {
  const folder = await templateFolder(doc)
  if (folder) {
    const manifest = await folder.read(MANIFEST)
    return {
      label: folder.label,
      source: 'templates',
      prefix: '',
      files: manifest === null ? [] : sorted(templateFiles(parseManifest(manifest)))
    }
  }
  const out = await knownOutputDir(doc)
  const local = out && (await out.read(`${LOCAL_TEMPLATES}/${MANIFEST}`))
  if (out && local)
    return {
      label: `${out.label}/${LOCAL_TEMPLATES}`,
      source: 'output',
      prefix: `${LOCAL_TEMPLATES}/`,
      files: sorted(templateFiles(parseManifest(local)))
    }
  const set = projectTemplateSet(doc.store.getState().project)
  const builtin = builtinTemplates(set).manifest
  return {
    label: `built-in ${builtin.name}`,
    source: 'builtin',
    prefix: `${set}/`,
    files: sorted(templateFiles(builtin))
  }
}

/** Files generated into the document's output directory; null when it generated none yet. */
export async function generatedListing(doc: DocState): Promise<Listing | null> {
  const out = await knownOutputDir(doc)
  return out && { label: out.label, source: 'output', prefix: '', files: await generatedFiles(out) }
}
