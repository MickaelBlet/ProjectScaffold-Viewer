// Code generation from the editor: the active project, rendered with the template folder chosen
// for the document, else the output directory's own template set (see codegen/run.ts), else the
// built-in C++17 one, into a directory the host gives.
import { snake } from '@/codegen/filters'
import { formatReport, generateInto, reportEntries, templateSetFor, type OutputDir } from '@/codegen/run'
import { loadTemplateSet, MANIFEST, parseManifest, type TemplateSet } from '@/codegen/templateSet'
import { dependencyName } from '@/model/dependencies'
import { toFile } from '@/model/serialize'
import { hasErrors, validate } from '@/model/validate'
import type { TemplateDirRequest } from '@/api'
import { activeDoc, type DocState } from '@/store/documents'
import { log } from '@/store/output'
import { showTool } from '@/shell/controllers'
import { quickPick, setStatus, showDialog, useUiStore } from '@/store/ui'

const BUILTIN = import.meta.glob<string>('../../../templates/cpp17/*', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** Files of the built-in template set, by name. */
export const builtinFiles = (): Record<string, string> =>
  Object.fromEntries(Object.entries(BUILTIN).map(([path, text]) => [path.split('/').pop()!, text]))

/** The C++17 template set shipped with the app (templates/cpp17). */
export function builtinTemplates(): TemplateSet {
  const { [MANIFEST]: manifest, ...templates } = builtinFiles()
  return { manifest: parseManifest(manifest ?? ''), files: templates }
}

/** The template set of a folder; its problems name the folder. */
async function folderTemplates(dir: OutputDir): Promise<TemplateSet> {
  try {
    return await loadTemplateSet((path) => dir.read(path))
  } catch (e) {
    throw new Error(`templates ${dir.label}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

/** Template folder chosen for a document (asking for access on first use); null when none. */
export async function templateFolder(doc: DocState): Promise<OutputDir | null> {
  return (await window.api.templateDir?.({ op: 'current', document: doc.filePath })) ?? null
}

/** Output directory a document generated into already (asking for access on first use); null when none. */
export async function knownOutputDir(doc: DocState): Promise<OutputDir | null> {
  const name = snake(dependencyName(doc.store.getState().project.name))
  return (await window.api.outputDir?.({ pick: false, known: true, document: doc.filePath, name })) ?? null
}

/** Called after code was generated or other templates were chosen: the files to list changed. */
export const codegenListeners = new Set<() => void>()
const codegenChanged = (): void => {
  for (const listener of codegenListeners) listener()
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
    const errors = problems.filter((p) => p.severity === 'error').map((p) => p.message)
    log('error', 'generation', `Code generation of ${project.name} blocked by ${errors.length} error(s):`)
    for (const e of errors) log('error', 'generation', `  ${e}`)
    showDialog('Code generation blocked: fix these errors first', errors, { logged: true })
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
    const start = performance.now()
    const templates = await window.api.templateDir?.({ op: 'current', document: doc.filePath })
    const set = templates ? await folderTemplates(templates) : await templateSetFor(dir, builtinTemplates)
    const templatesLabel = templates ? templates.label : set.manifest.name
    log('info', 'generation', `Generating ${project.name} into ${label} (templates ${templatesLabel})`)
    const report = await generateInto(toFile(project, { editor: false }), set, dir)
    codegenChanged()
    for (const e of reportEntries(report))
      log(e.level, 'generation', `  ${e.text}`, { path: e.path, doc: doc.id })
    const summary = `Code generated into ${label} (templates ${templatesLabel}): ${report.written.length} written, ${report.unchanged.length} unchanged`
    if (report.conflicts.length || report.orphans.length || report.stale.length || report.warnings.length) {
      log('warning', 'generation', `${summary} in ${Math.round(performance.now() - start)} ms`)
      showTool('output', false)
      showDialog(summary, formatReport(report, label, false).split('\n').slice(0, -1), { logged: true })
    } else {
      log('info', 'generation', `${summary} in ${Math.round(performance.now() - start)} ms`)
      useUiStore.setState({ status: { kind: 'info', text: summary } })
    }
  } catch (e) {
    const title = `Code generation failed${label ? ` in ${label}` : ''}`
    const lines = errorLines(e)
    log('error', 'generation', title)
    for (const line of lines) log('error', 'generation', `  ${line}`)
    showTool('output', false)
    showDialog(title, lines, { logged: true })
  }
}

/** Message of an error, then of each of its causes not already part of it. */
function errorLines(e: unknown): string[] {
  if (!(e instanceof Error)) return [String(e)]
  const lines: string[] = []
  for (let c: unknown = e; c instanceof Error && lines.length < 10; c = c.cause)
    if (!lines.some((l) => l.includes(c.message))) lines.push(c.message)
  return lines
}

/** Whether the host can give template folders. */
export const canChooseTemplates = (): boolean => !!window.api.templateDir

/**
 * Chooses the templates generating the active document's code: the default ones, a folder of the
 * user's own, or a copy of the built-in ones to edit.
 */
export async function chooseTemplates(): Promise<void> {
  if (!window.api.templateDir) return
  const document = activeDoc().filePath
  const templateDir = async (op: TemplateDirRequest['op']): Promise<OutputDir | null> =>
    (await window.api.templateDir?.({ op, document })) ?? null
  const fail = (title: string, e: unknown): void =>
    showDialog(title, [e instanceof Error ? e.message : String(e)])
  let current: OutputDir | null = null
  try {
    current = await templateDir('current')
  } catch (e) {
    fail('Cannot read the template folder', e)
  }
  const adopt = async (copy: boolean): Promise<void> => {
    try {
      const dir = await templateDir('pick')
      if (!dir) return
      if (copy) {
        if ((await dir.read(MANIFEST)) !== null) {
          showDialog(`${dir.label} already holds a template set`, [
            'It is used as it is: copy the built-in templates into an empty folder to start again.'
          ])
          return
        }
        for (const [name, text] of Object.entries(builtinFiles())) await dir.write(name, text)
      }
      const set = await folderTemplates(dir)
      codegenChanged()
      setStatus(
        'info',
        `${copy ? 'Built-in templates copied into' : 'Code generation uses the templates of'} ${dir.label} (${set.manifest.name})`
      )
    } catch (e) {
      fail('Cannot use this template folder', e)
    }
  }
  quickPick('Templates generating the code of this document', [
    {
      key: 'default',
      label: `${current ? '' : '✓ '}Default templates`,
      detail: 'the output directory’s .scaffold/templates, else built-in C++17',
      kind: 'T',
      run: () =>
        void templateDir('forget')
          .then(() => {
            codegenChanged()
            setStatus('info', 'Code generation uses the default templates')
          })
          .catch((e: unknown) => fail('Cannot forget the template folder', e))
    },
    ...(current
      ? [
          {
            key: 'current',
            label: `✓ ${current.label}`,
            detail: 'template folder in use',
            kind: 'T',
            run: () => {}
          }
        ]
      : []),
    {
      key: 'pick',
      label: 'Template folder…',
      detail: 'a manifest.yaml and its templates',
      kind: 'T',
      run: () => void adopt(false)
    },
    {
      key: 'copy',
      label: 'Copy the built-in templates into a folder…',
      detail: 'to edit them, then generate with them',
      kind: 'T',
      run: () => void adopt(true)
    }
  ])
}
