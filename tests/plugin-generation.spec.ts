import { describe, expect, it } from 'vitest'
import {
  GENERATION_UNKNOWN,
  describeGeneration,
  generationOf,
  identifyGeneration,
} from '../src/adapters/dsh-logging/plugin-generation.js'

describe('plugin generation self-check', () => {
  it('hashes content deterministically', () => {
    expect(generationOf('abc')).toBe(generationOf('abc'))
    expect(generationOf('abc')).not.toBe(generationOf('abd'))
  })

  it('produces a short hex token', () => {
    expect(generationOf('abc')).toMatch(/^[a-f0-9]{12}$/)
  })

  it('reports no restart when loaded and disk agree', async () => {
    const identity = await identifyGeneration({ version: '1.2.0', loaded: 'aaaaaaaaaaaa', disk: 'aaaaaaaaaaaa' })
    expect(identity.staleOnDisk).toBe(false)
    expect(identity.restartRequired).toBe(false)
    expect(identity.version).toBe('1.2.0')
  })

  it('flags a restart when the disk generation moved on', async () => {
    const identity = await identifyGeneration({ version: '1.2.0', loaded: 'aaaaaaaaaaaa', disk: 'bbbbbbbbbbbb' })
    expect(identity.staleOnDisk).toBe(true)
    expect(identity.restartRequired).toBe(true)
    expect(identity.codeGeneration).toBe('aaaaaaaaaaaa')
    expect(identity.diskGeneration).toBe('bbbbbbbbbbbb')
  })

  it('claims nothing when the loaded side is unknown', async () => {
    const identity = await identifyGeneration({
      version: '1.2.0',
      loaded: GENERATION_UNKNOWN,
      disk: 'bbbbbbbbbbbb',
    })
    expect(identity.restartRequired).toBe(false)
    expect(identity.staleOnDisk).toBe(false)
  })

  it('claims nothing when the disk side is unknown', async () => {
    const identity = await identifyGeneration({
      version: '1.2.0',
      loaded: 'aaaaaaaaaaaa',
      disk: GENERATION_UNKNOWN,
    })
    expect(identity.restartRequired).toBe(false)
  })

  it('describes a healthy identity without asking for a restart', () => {
    const text = describeGeneration({
      version: '1.2.0',
      codeGeneration: 'aaaaaaaaaaaa',
      diskGeneration: 'aaaaaaaaaaaa',
      staleOnDisk: false,
      restartRequired: false,
    })
    expect(text).toContain('1.2.0')
    expect(text).not.toContain('重启')
  })

  it('describes a stale identity with an explicit restart instruction', () => {
    const text = describeGeneration({
      version: '1.2.0',
      codeGeneration: 'aaaaaaaaaaaa',
      diskGeneration: 'bbbbbbbbbbbb',
      staleOnDisk: true,
      restartRequired: true,
    })
    expect(text).toContain('重启')
    expect(text).toContain('bbbbbbbbbbbb')
  })
})
