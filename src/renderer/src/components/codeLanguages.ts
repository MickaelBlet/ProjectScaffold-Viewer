// Language of a file shown in a code editor, by its name.

export type LanguageId = 'yaml' | 'json' | 'idl' | 'text'

export interface FileLanguage {
  id: LanguageId
}

const BY_EXTENSION: Record<string, LanguageId> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  idl: 'idl'
}

/** Language of a file. */
export function languageOf(name: string): FileLanguage {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return { id: (dot > 0 && BY_EXTENSION[base.slice(dot + 1).toLowerCase()]) || 'text' }
}
