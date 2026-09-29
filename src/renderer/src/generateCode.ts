// Code generation from the editor: the active project, rendered with the built-in C++17 template
// set (or the output directory's own, see codegen/run.ts) into a directory the host gives.
import { snake } from '@/codegen/filters'
import { formatReport, generateInto, templateSetFor } from '@/codegen/run'
import { parseManifest, type TemplateSet } from '@/codegen/templateSet'
import { dependencyName } from '@/model/dependencies'
import { toFile } from '@/model/serialize'
import { hasErrors, validate } from '@/model/validate'
import { activeDoc } from '@/store/documents'
import { setStatus, showDialog } from '@/store/ui'

const BUILTIN = import.meta.glob<string>('../../../templates/cpp17/*', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** The C++17 template set shipped with the app (templates/cpp17). */
export function builtinTemplates(): TemplateSet {
  const files = Object.fromEntries(
    Object.entries(BUILTIN).map(([path, text]) => [path.split('/').pop()!, text])
  )
  const { 'manifest.yaml': manifest, ...templates } = files
  return { manifest: parseManifest(manifest ?? ''), files: templates }
}

/** Whether the host can write generated files. */
export const canGenerate = (): boolean => !!window.api.outputDir

/** Generates the active project's code into its output directory; `pick` asks for another one. */
export async function generateCode(pick: boolean): Promise<void> {
  const doc = activeDoc()
  const project = doc.store.getState().project
  if (!window.api.outputDir) {
    showDialog('Code generation is not available here', [
      'This browser cannot write into a folder: use Chrome or Edge, the desktop app, VS Code, or the command line:',
      'npm run generate -- <project file> -o <output directory>'
    ])
    return
  }
  const problems = validate(project)
  if (hasErrors(problems)) {
    showDialog(
      'Code generation blocked: fix these errors first',
      problems.filter((p) => p.severity === 'error').map((p) => p.message)
    )
    return
  }
  let label = ''
  try {
    const dir = await window.api.outputDir({
      pick,
      document: doc.filePath,
      name: snake(dependencyName(project.name))
    })
    if (!dir) return
    label = dir.label
    const set = await templateSetFor(dir, builtinTemplates)
    const report = await generateInto(toFile(project, { editor: false }), set, dir)
    const summary = `Code generated into ${label}: ${report.written.length} written, ${report.unchanged.length} unchanged`
    if (report.conflicts.length || report.orphans.length || report.stale.length || report.warnings.length)
      showDialog(summary, formatReport(report, label, false).split('\n').slice(0, -1))
    else setStatus('info', summary)
  } catch (e) {
    showDialog(`Code generation failed${label ? ` in ${label}` : ''}`, [
      e instanceof Error ? e.message : String(e)
    ])
  }
}
