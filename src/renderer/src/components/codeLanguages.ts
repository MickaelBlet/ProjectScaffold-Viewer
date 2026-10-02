// Language of a file shown in a code editor, by its name.

export type LanguageId = 'yaml' | 'json' | 'cpp' | 'python' | 'cmake' | 'idl' | 'liquid' | 'text'

export interface FileLanguage {
  id: LanguageId
  /** Liquid templates: language of the text they generate. */
  base?: Exclude<LanguageId, 'liquid'>
}

const BY_EXTENSION: Record<string, Exclude<LanguageId, 'liquid'>> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  ipp: 'cpp',
  py: 'python',
  pyi: 'python',
  cmake: 'cmake',
  idl: 'idl'
}

/** Letter of a language's badge in file lists. */
export const LANGUAGE_BADGES: Record<LanguageId, string> = {
  yaml: 'Y',
  json: 'J',
  cpp: 'C',
  python: 'P',
  cmake: 'M',
  idl: 'I',
  liquid: 'L',
  text: 'T'
}

function plainLanguage(name: string): Exclude<LanguageId, 'liquid'> {
  const base = name.slice(name.lastIndexOf('/') + 1)
  if (base === 'CMakeLists.txt') return 'cmake'
  const dot = base.lastIndexOf('.')
  return (dot > 0 && BY_EXTENSION[base.slice(dot + 1).toLowerCase()]) || 'text'
}

/** Language of a file; `x.hpp.liquid` is Liquid generating C++. */
export function languageOf(name: string): FileLanguage {
  if (/\.liquid$/i.test(name)) return { id: 'liquid', base: plainLanguage(name.slice(0, -'.liquid'.length)) }
  return { id: plainLanguage(name) }
}
