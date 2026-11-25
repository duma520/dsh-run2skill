import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RUN2SKILL_LOG_MAX_BYTES,
  RUN2SKILL_LOG_NAMES,
  createFileLogSink,
  formatLogLine,
  redactValue,
  renderLogArg,
  resolveLogPaths,
} from '../src/adapters/dsh-logging/file-log.js'

function line(message: unknown, args: readonly unknown[] = []): string {
  return formatLogLine({ at: 0, level: 'info', name: 'run2skill', message, args })
}

describe('run2skill file log', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'run2skill-log-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('resolves paths under the DSH home by default', () => {
    expect(resolveLogPaths('/home/example').file)
      .toBe(join('/home/example', '.dsh', 'dsh-run2skill', 'logs', 'run2skill.log'))
  })

  it('only claims this plugin logger names', () => {
    expect(RUN2SKILL_LOG_NAMES.has('run2skill')).toBe(true)
    expect(RUN2SKILL_LOG_NAMES.has('something-else')).toBe(false)
  })

  it('emits one parseable JSON object per line', () => {
    const parsed = JSON.parse(line('started'))
    expect(parsed).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      name: 'run2skill',
      message: 'started',
      args: [],
    })
  })

  it('redacts an assigned secret without corrupting the JSON', () => {
    const parsed = JSON.parse(line('login with password=hunter2'))
    expect(parsed.message).not.toContain('hunter2')
    expect(parsed.message).toContain('[REDACTED]')
  })

  it('keeps a bearer token out of the record', () => {
    expect(line('request failed', ['authorization: Bearer sk-live-abcdef1234567890']))
      .not.toContain('sk-live-abcdef1234567890')
  })

  it('redacts string values nested inside structured arguments', () => {
    const parsed = JSON.parse(line('event', [{ headers: { authorization: 'Bearer abcdefgh12345678' } }]))
    expect(JSON.stringify(parsed)).not.toContain('abcdefgh12345678')
  })

  it('preserves non-secret structure and container types', () => {
    const parsed = JSON.parse(line('event', [{ count: 3, ok: true, items: ['a', 'b'] }]))
    expect(parsed.args[0]).toEqual({ count: 3, ok: true, items: ['a', 'b'] })
  })

  it('serializes errors into plain fields', () => {
    expect(renderLogArg(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('stops descending past the depth guard', () => {
    const deep = redactValue({ a: { b: { c: { d: { e: { f: { g: 'never' } } } } } } })
    expect(JSON.stringify(deep)).toContain('[truncated]')
  })

  it('rotates once the file would exceed the budget', () => {
    const paths = { directory, file: join(directory, 'run2skill.log') }
    const sink = createFileLogSink(paths, 64)
    expect(sink.write(`${'x'.repeat(40)}\n`)).toBe(true)
    expect(sink.write(`${'y'.repeat(40)}\n`)).toBe(true)
    expect(existsSync(`${paths.file}.1`)).toBe(true)
    expect(readFileSync(paths.file, 'utf8')).toContain('yyy')
    sink.dispose()
  })

  it('does not rotate on an empty file even when one line exceeds the budget', () => {
    const paths = { directory, file: join(directory, 'run2skill.log') }
    const sink = createFileLogSink(paths, 8)
    sink.write(`${'a'.repeat(32)}\n`)
    expect(existsSync(`${paths.file}.1`)).toBe(false)
    sink.dispose()
  })

  it('creates the directory lazily so an unused plugin writes nothing', () => {
    const paths = {
      directory: join(directory, 'nested', 'logs'),
      file: join(directory, 'nested', 'logs', 'x.log'),
    }
    const sink = createFileLogSink(paths, RUN2SKILL_LOG_MAX_BYTES)
    expect(existsSync(paths.directory)).toBe(false)
    sink.write('one\n')
    expect(existsSync(paths.directory)).toBe(true)
    sink.dispose()
  })

  it('reports a failed write instead of throwing at the caller', () => {
    const sink = createFileLogSink({ directory, file: directory }, 1024)
    expect(sink.write('line\n')).toBe(false)
    sink.dispose()
  })
})
