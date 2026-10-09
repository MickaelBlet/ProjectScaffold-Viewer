// Problems of the text files edited beside a document, by line: Liquid templates, IDL files, the
// user sections of generated files.
import { createEngine } from '@/codegen/generate'
import { commentOf } from '@/codegen/run'
import { extractSections, type Section } from '@/codegen/sections'
import { parseIdl } from '@/model/idl'

export interface TextProblem {
  /** From 1; null when the problem is about the whole file. */
  line: number | null
  message: string
  severity: 'error' | 'warning'
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Syntax errors of a Liquid template (tags, filters, the `user` sections). */
export function liquidProblems(text: string): TextProblem[] {
  try {
    createEngine({}, {}).parse(text)
    return []
  } catch (e) {
    // liquidjs: `message, line:3, col:5` and the lines around it.
    const first = messageOf(e).split('\n')[0]!
    const at = /, line:(\d+), col:\d+$/.exec(first)
    return [
      {
        line: at ? Number(at[1]) : null,
        message: at ? first.slice(0, at.index) : first,
        severity: 'error'
      }
    ]
  }
}

/** `Line 3: message` of the IDL reader; lines of other files (`Line 3 of x.idl`) stay in the message. */
function idlProblem(text: string, severity: TextProblem['severity']): TextProblem {
  const m = /^Line (\d+): ([\s\S]*)$/.exec(text)
  return m ? { line: Number(m[1]), message: m[2]!, severity } : { line: null, message: text, severity }
}

/** Errors of an IDL file, and what it cannot express (warnings); included files are not read. */
export function idlProblems(text: string, file: string): TextProblem[] {
  try {
    return parseIdl(text, { file }).warnings.map((w) => idlProblem(w, 'warning'))
  } catch (e) {
    return [idlProblem(messageOf(e), 'error')]
  }
}

/** User sections of a generated file (markers guessed from the first one), or why they are wrong. */
export function userSections(text: string): { sections: Section[]; problems: TextProblem[] } {
  try {
    return { sections: extractSections(text, commentOf(text, '//')), problems: [] }
  } catch (e) {
    const m = /^line (\d+): ([\s\S]*)$/.exec(messageOf(e))
    return {
      sections: [],
      problems: [
        m
          ? { line: Number(m[1]), message: m[2]!, severity: 'error' }
          : { line: null, message: messageOf(e), severity: 'error' }
      ]
    }
  }
}
