import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, Exporter, Message } from '@deepseek-ai/cordis'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'

/**
 * Writes this plugin's own structurally redacted log records to a rotating
 * JSONL file. The shape is borrowed from the idea of a durable, self-owned log
 * trail; the implementation is original and uses only node built-ins plus the
 * plugin's existing redaction layer.
 *
 * Two invariants matter:
 * 1. A logging failure must never break the agent loop.
 * 2. Every persisted string field passes through `preprocessPersistentText`
 *    first, so a secret cannot reach the file even if a caller forgets to
 *    sanitize the value it logs.
 *
 * Redaction runs per field, not on the finished JSON text: the assignment
 * redactor intentionally swallows the tail after a `key=value`, which would
 * corrupt JSON if applied to the whole line.
 */

export const RUN2SKILL_LOG_MAX_BYTES = 5 * 1024 * 1024

/** Logger names owned by this plugin. Anything else is ignored. */
export const RUN2SKILL_LOG_NAMES: ReadonlySet<string> = new Set([
  'run2skill',
  '@duma520/dsh-run2skill',
])

/** Cordis `LoggerLevel.DEBUG`. The enum is type-only, so the number is inline. */
const DEBUG_LEVEL = 3

/** Depth guard so a cyclic or absurdly deep log argument cannot hang the loop. */
const MAX_REDACT_DEPTH = 6

export interface Run2skillLogPaths {
  readonly directory: string
  readonly file: string
}

export function resolveLogPaths(home: string = homedir()): Run2skillLogPaths {
  const directory = join(home, '.dsh', 'dsh-run2skill', 'logs')
  return { directory, file: join(directory, 'run2skill.log') }
}

/** Redacts every string inside a JSON-safe value, leaving structure intact. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return preprocessPersistentText(value).text
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_REDACT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[preprocessPersistentText(key).text] = redactValue(item, depth + 1)
  }
  return result
}

/** Renders a log argument into a JSON-safe, redacted value. */
export function renderLogArg(value: unknown): unknown {
  if (value instanceof Error) {
    return redactValue({ name: value.name, message: value.message, stack: value.stack })
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : redactValue(value)
  }
  try {
    return redactValue(JSON.parse(JSON.stringify(value)) as unknown)
  } catch {
    return preprocessPersistentText(String(value)).text
  }
}

/** Builds one JSONL line. Redaction happens field by field, then serialized. */
export function formatLogLine(input: {
  readonly at: number
  readonly level: string
  readonly name: string
  readonly message: unknown
  readonly args: readonly unknown[]
}): string {
  const record = {
    ts: new Date(input.at).toISOString(),
    level: input.level,
    name: input.name,
    message: renderLogArg(input.message),
    args: input.args.map(renderLogArg),
  }
  return `${JSON.stringify(record)}\n`
}

function messageToLine(message: Message): string {
  const [first, ...rest] = message.args
  return formatLogLine({
    at: message.ts,
    level: message.type,
    name: message.name,
    message: first,
    args: rest,
  })
}

export interface FileLogSink {
  /** Appends one already-encoded line; returns false when nothing was written. */
  write(line: string): boolean
  dispose(): void
}

export function createFileLogSink(paths: Run2skillLogPaths, maxBytes: number): FileLogSink {
  let ready = false
  const ensureReady = (): void => {
    if (ready) return
    mkdirSync(paths.directory, { recursive: true })
    ready = true
  }
  return {
    write(line: string): boolean {
      let wrote = false
      try {
        ensureReady()
        let size = 0
        let rotate = false
        try {
          const existing = statSync(paths.file)
          size = existing.size
          // Only a regular file may be rotated. Without this guard a path that
          // happens to be a directory would be renamed away as if it were the
          // log, which behaves differently on Windows and Linux.
          rotate = existing.isFile()
        } catch {
          size = 0
        }
        if (rotate && size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          try {
            renameSync(paths.file, `${paths.file}.1`)
          } catch {
            // A failed rotation must not drop the incoming record.
          }
        }
        appendFileSync(paths.file, line, { mode: 0o600 })
        wrote = true
      } catch {
        ready = false
        wrote = false
      }
      return wrote
    },
    dispose(): void {
      ready = false
    },
  }
}

export interface AttachedFileLog {
  /** Records one explicit structured event, outside the cordis logger namespace. */
  record(message: string, detail?: Record<string, unknown>): void
  readonly file: string
  dispose(): void
}

/**
 * Attaches a redacting JSONL exporter for this plugin's logger names and
 * returns a handle for explicit records plus manual disposal. The exporter is
 * also bound to the context effect, so fiber teardown removes it as well.
 */
export function attachFileLog(
  context: Context,
  options: { file?: string; maxBytes?: number; now?: () => number } = {},
): AttachedFileLog {
  const paths = options.file === undefined
    ? resolveLogPaths()
    : { directory: dirname(options.file), file: options.file }
  const sink = createFileLogSink(paths, options.maxBytes ?? RUN2SKILL_LOG_MAX_BYTES)
  const now = options.now ?? Date.now

  const exporter: Exporter = {
    // `levels: { default: 3 }` is required: cordis drops messages above the
    // exporter threshold before `export` is called, and the host default is
    // INFO, which would silently swallow warn/debug.
    levels: { default: DEBUG_LEVEL },
    export(message: Message): void {
      if (!RUN2SKILL_LOG_NAMES.has(message.name)) return
      try {
        sink.write(messageToLine(message))
      } catch {
        // Encoding failure is swallowed for the same reason as a write failure.
      }
    },
  }

  let disposeExporter: (() => void) | undefined
  try {
    disposeExporter = context.logger.exporter(exporter)
  } catch {
    disposeExporter = undefined
  }

  return {
    file: paths.file,
    record(message: string, detail?: Record<string, unknown>): void {
      try {
        sink.write(formatLogLine({
          at: now(),
          level: 'info',
          name: 'run2skill',
          message: detail === undefined ? message : { event: message, detail },
          args: [],
        }))
      } catch {
        // Swallowed: an explicit record is best-effort by contract.
      }
    },
    dispose(): void {
      try {
        disposeExporter?.()
      } catch {
        // Ignored: teardown must stay total.
      }
      sink.dispose()
    },
  }
}
