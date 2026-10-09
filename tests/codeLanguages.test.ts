import { describe, expect, it } from 'vitest'
import { languageOf } from '@/components/codeLanguages'

describe('languageOf', () => {
  it('reads the extension', () => {
    expect(languageOf('robot.scaffold.yaml')).toEqual({ id: 'yaml' })
    expect(languageOf('a/b/robot.JSON')).toEqual({ id: 'json' })
    expect(languageOf('robot_control.idl')).toEqual({ id: 'idl' })
    expect(languageOf('src/sensor.hpp')).toEqual({ id: 'text' })
    expect(languageOf('README')).toEqual({ id: 'text' })
    expect(languageOf('.gitignore')).toEqual({ id: 'text' })
  })
})
