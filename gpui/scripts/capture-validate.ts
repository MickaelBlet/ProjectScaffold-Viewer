// Vitest setup capturing the projects the TS tests validate, as fixtures of the GPUI model tests:
// each saved as file data with the problems the web build finds. Kept only when the problems
// survive a save and reload (references to deleted entities are written by name).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { vi } from 'vitest'

const out = 'gpui/crates/model/tests/validate'
mkdirSync(out, { recursive: true })

vi.mock('@/model/validate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/model/validate')>()
  const { toFile, fromFile } = await import('../../src/renderer/src/model/serialize')
  const text = (ps: { severity: string; target: { kind: string }; message: string }[]) =>
    ps.map((x) => `${x.severity} ${x.target.kind}: ${x.message}`).join('\n')
  return {
    ...real,
    validate: (p: Parameters<typeof real.validate>[0]) => {
      const problems = real.validate(p)
      try {
        const data = toFile(p, { editor: true })
        const expected = text(problems)
        if (text(real.validate(fromFile(structuredClone(data)))) === expected) {
          const json = JSON.stringify(data, null, 2)
          const key = createHash('sha1').update(json).digest('hex').slice(0, 12)
          writeFileSync(`${out}/${key}.json`, json + '\n')
          writeFileSync(`${out}/${key}.problems.txt`, expected + '\n')
        }
      } catch {
        // Not a loadable project: not a fixture.
      }
      return problems
    }
  }
})
