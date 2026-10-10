import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { refreshDependencies } from '@/model/dependencies'
import { idlProject } from '@/model/idl'
import { formatFromPath, fromFile, parseText, stringify, toFile } from '@/model/serialize'
import { resolveRelative } from '@/model/sync'
import type { Project } from '@/model/types'
import { validate } from '@/model/validate'
import { isWorkspaceData, workspaceFromFile } from '@/model/workspace'

const ROOT = 'examples'
const files = (readdirSync(ROOT, { recursive: true }) as string[])
  .map((f) => f.split('\\').join('/'))
  .sort()
const projects = files.filter((f) => /\.scaffold\.(yaml|json)$/.test(f))
const workspaces = files.filter((f) => f.endsWith('.scaffold-workspace.yaml'))

const text = (file: string): string => readFileSync(join(ROOT, file), 'utf8')
const data = (file: string): unknown => parseText(text(file), formatFromPath(file))
const read = (file: string): Project => fromFile(data(file))

/** The project a dependency file stands for: a project file, or an IDL file with those next to it. */
function source(file: string): Project {
  if (!file.endsWith('.idl')) return read(file)
  const dir = dirname(file)
  const idl = new Map(
    files.filter((f) => f.endsWith('.idl') && dirname(f) === dir).map((f) => [f, text(f)] as const)
  )
  return idlProject(file, idl).project
}

const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync('schema/scaffold.schema.json', 'utf8')) as object
)

describe('examples', () => {
  describe.each(projects)('%s', (file) => {
    it('matches the JSON Schema', () => {
      validateSchema(data(file))
      expect(validateSchema.errors ?? []).toEqual([])
    })

    it('has no errors', () => {
      const errors = validate(read(file)).filter((pr) => pr.severity === 'error')
      expect(errors.map((pr) => pr.message)).toEqual([])
    })

    it('is saved as the editor saves it', () => {
      expect(stringify(toFile(read(file), { editor: true }), formatFromPath(file))).toBe(text(file))
    })

    it('has its dependencies up to date', () => {
      const p = read(file)
      const sources = new Map(p.dependencies.map((x) => [x.id, source(resolveRelative(file, x.file))]))
      const fresh = produce(p, (d) => {
        const result = refreshDependencies(d, sources, file)
        expect(result).toEqual({ conflicts: [], detached: [], renamed: [], missing: [] })
      })
      expect(toFile(fresh, { editor: false })).toEqual(toFile(p, { editor: false }))
    })
  })

  describe.each(workspaces)('%s', (file) => {
    it('lists projects of the examples', () => {
      const ws = data(file)
      expect(isWorkspaceData(ws)).toBe(true)
      for (const f of workspaceFromFile(ws).projects) expect(projects).toContain(resolveRelative(file, f))
    })
  })
})
