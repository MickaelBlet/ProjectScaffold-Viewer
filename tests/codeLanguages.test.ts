import { describe, expect, it } from 'vitest'
import { languageOf } from '@/components/codeLanguages'

describe('languageOf', () => {
  it('reads the extension', () => {
    expect(languageOf('robot.scaffold.yaml')).toEqual({ id: 'yaml' })
    expect(languageOf('a/b/robot.JSON')).toEqual({ id: 'json' })
    expect(languageOf('src/sensor.hpp')).toEqual({ id: 'cpp' })
    expect(languageOf('python/core/wire.py')).toEqual({ id: 'python' })
    expect(languageOf('robot_control.idl')).toEqual({ id: 'idl' })
    expect(languageOf('README')).toEqual({ id: 'text' })
    expect(languageOf('.gitignore')).toEqual({ id: 'text' })
  })

  it('knows CMake files', () => {
    expect(languageOf('CMakeLists.txt')).toEqual({ id: 'cmake' })
    expect(languageOf('cmake/deps.cmake')).toEqual({ id: 'cmake' })
    expect(languageOf('notes.txt')).toEqual({ id: 'text' })
  })

  it('gives Liquid templates the language they generate', () => {
    expect(languageOf('interface.hpp.liquid')).toEqual({ id: 'liquid', base: 'cpp' })
    expect(languageOf('CMakeLists.txt.liquid')).toEqual({ id: 'liquid', base: 'cmake' })
    expect(languageOf('_py_value.liquid')).toEqual({ id: 'liquid', base: 'text' })
  })
})
