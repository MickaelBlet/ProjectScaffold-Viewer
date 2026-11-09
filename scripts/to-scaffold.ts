// Writes the Scaffold text (`*.scaffold`) of project files (YAML/JSON), as read (not checked).
// npx tsx scripts/to-scaffold.ts [-o <dir>] <file>...   (default: next to each file)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { stringifyDsl } from '../src/renderer/src/model/dsl'
import { formatFromPath, parseText } from '../src/renderer/src/model/serialize'

const args = process.argv.slice(2)
const o = args.indexOf('-o')
const out = o >= 0 ? args.splice(o, 2)[1] : undefined
if (!args.length) {
  console.error('usage: tsx scripts/to-scaffold.ts [-o <dir>] <file>...')
  process.exit(2)
}
for (const file of args) {
  const data = parseText(readFileSync(file, 'utf8'), formatFromPath(file))
  const name = basename(file).replace(/(\.scaffold)?\.(ya?ml|json)$/i, '') + '.scaffold'
  const target = join(out ?? dirname(file), name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, stringifyDsl(data))
  console.log(`wrote ${target}`)
}
