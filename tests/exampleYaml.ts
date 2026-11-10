import { readFileSync } from 'node:fs'
import { parseDsl } from '@/model/dsl'
import type { FileProject } from '@/model/schema'
import { stringify } from '@/model/serialize'

/** YAML text of an example project (examples are Scaffold text), as the editor saves it. */
export const exampleYaml = (path: string): string =>
  stringify(parseDsl(readFileSync(path, 'utf8')) as unknown as FileProject, 'yaml')
