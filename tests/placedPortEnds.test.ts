import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { placedPortEnds } from '@/canvas/flowGraph'
import { fromFile } from '@/model/serialize'

const ground = fromFile(YAML.parse(readFileSync('examples/fleet/ground.scaffold.yaml', 'utf8')))
const datalink = ground.modules.find((m) => m.name === 'Datalink')!
const radio = ground.dependencies.flatMap((x) => x.modules).find((m) => m.path === 'Radio')!

describe('placedPortEnds', () => {
  it('offers every port of a placed module to a new port, in link order', () => {
    const choices = placedPortEnds(ground, radio.id, { moduleId: datalink.id, portId: null, role: null })
    expect(choices.map((c) => c.port.name)).toEqual(radio.ports.map((pt) => pt.name))
    for (const { port, ends } of choices) {
      const own = ends.find((e) => e.moduleId === radio.id)!
      expect(own.portId).toBe(port.id)
      expect(ends[0].moduleId).toBe(port.role === 'out' ? radio.id : datalink.id)
    }
  })

  it('offers the ports whose role and interface fit a port', () => {
    const downlink = datalink.ports.find((pt) => pt.name === 'downlink')!
    const choices = placedPortEnds(ground, radio.id, {
      moduleId: datalink.id,
      portId: downlink.id,
      role: downlink.role
    })
    expect(choices.map((c) => c.port.name)).toEqual(['downlink'])
  })
})
