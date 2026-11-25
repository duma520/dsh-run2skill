import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Generation self-check: tells the user when the code the host loaded differs
 * from the code now on disk, which is exactly the situation where a plugin
 * appears "installed" but keeps running old behaviour until a restart.
 *
 * The loaded generation is captured once, at module import time. Re-reading it
 * later would compare disk against disk and report "up to date" forever, which
 * is the precise confusion this module exists to end.
 *
 * Implementation is original; it reads only node built-ins and the plugin's own
 * entry file. It borrows the *idea* of a code-generation / disk-generation
 * comparison, not any third-party code.
 */

export const GENERATION_UNKNOWN = 'unknown'

/** Short content hash. 12 hex chars is ~48 bits: ample for rebuild detection. */
export function generationOf(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

function entryFile(): string {
  // `import.meta.url` is this module's own file; the plugin entry sits beside it
  // after bundling (lib/index.js next to lib/plugin-generation.js).
  return fileURLToPath(import.meta.url)
}

/**
 * Reads the plugin version from the manifest that ships next to the bundle.
 * Falls back to `unknown` rather than throwing: a missing manifest must never
 * take down the plugin.
 */
export async function readPluginVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(dirname(entryFile()), '..', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : GENERATION_UNKNOWN
  } catch {
    return GENERATION_UNKNOWN
  }
}

async function readGeneration(file: string): Promise<string> {
  try {
    return generationOf(await readFile(file))
  } catch {
    return GENERATION_UNKNOWN
  }
}

/**
 * The generation captured when this module was first imported. Comparing a
 * later disk read against this value is what produces a real signal.
 */
export const LOADED_GENERATION: Promise<string> = readGeneration(entryFile())

export interface GenerationIdentity {
  readonly version: string
  readonly codeGeneration: string
  readonly diskGeneration: string
  readonly staleOnDisk: boolean
  readonly restartRequired: boolean
}

/**
 * Compares the loaded generation against the generation now on disk.
 *
 * `staleOnDisk` and `restartRequired` are deliberately conservative: when
 * either side is unknown nothing is claimed, because a false "restart needed"
 * banner is worse than no banner at all.
 */
export async function identifyGeneration(input: {
  readonly version?: string
  readonly loaded?: string
  readonly disk?: string
} = {}): Promise<GenerationIdentity> {
  const version = input.version ?? await readPluginVersion()
  const loaded = input.loaded ?? await LOADED_GENERATION
  const disk = input.disk ?? await readGeneration(entryFile())
  const bothKnown = loaded !== GENERATION_UNKNOWN && disk !== GENERATION_UNKNOWN
  const stale = bothKnown && loaded !== disk
  return {
    version,
    codeGeneration: loaded,
    diskGeneration: disk,
    staleOnDisk: stale,
    restartRequired: stale,
  }
}

/** One-line human description, suitable for a settings-page banner. */
export function describeGeneration(identity: GenerationIdentity): string {
  if (!identity.restartRequired) return `运行版本 ${identity.version}（${identity.codeGeneration}）与磁盘一致。`
  return `运行中的插件是旧版本（${identity.codeGeneration}），磁盘上已是新版本（${identity.diskGeneration}）。请重启 DSH 桌面应用后生效。`
}
