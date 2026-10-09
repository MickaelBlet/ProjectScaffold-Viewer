// Problems of the text files edited beside a document, by line: IDL files.
import { parseIdl } from '@/model/idl'

export interface TextProblem {
  /** From 1; null when the problem is about the whole file. */
  line: number | null
  message: string
  severity: 'error' | 'warning'
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
