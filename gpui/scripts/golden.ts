// Golden files of the GPUI model tests: each example as the web build reads and saves it.
// Run from the repository root: npx tsx gpui/scripts/golden.ts
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { formatFromPath, loadText, saveText } from '../../src/renderer/src/model/serialize'
import { validate } from '../../src/renderer/src/model/validate'

const out = 'gpui/crates/model/tests/golden'
mkdirSync(out, { recursive: true })
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return files(p)
    return /\.scaffold\.(yaml|json)$/.test(f) ? [p] : []
  })
for (const file of files('examples')) {
  const p = loadText(readFileSync(file, 'utf8'), formatFromPath(file))
  const name = file.slice('examples/'.length).replace(/\//g, '__')
  writeFileSync(join(out, `${name}.json`), saveText(p, 'json', { editor: true }))
  writeFileSync(join(out, `${name}.yaml`), saveText(p, 'yaml', { editor: true }))
  writeFileSync(join(out, `${name}.noeditor.json`), saveText(p, 'json', { editor: false }))
  const problems = validate(p).map((x) => `${x.severity} ${x.target.kind}: ${x.message}`)
  writeFileSync(join(out, `${name}.problems.txt`), problems.join('\n') + '\n')
  console.log(basename(file))
}
