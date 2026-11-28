import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FiberState } from '@deepseek-ai/cordis'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  ROOT_CONTRACT_VERSION_V2,
  ROOT_RESOLVER_VERSION_V2,
} from '../../domain/review/schemas.js'

export const STOCK_DSH_BASELINE_COMMIT = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db'
export const STOCK_DSH_RC3_BASELINE_COMMIT = '38a6a5c965aa99ab525161efb7cc5cf1fe62fced'
export const STOCK_ROOT_CONTRACT_VERSION = ROOT_CONTRACT_VERSION_V2
export const STOCK_ROOT_RESOLVER_VERSION = ROOT_RESOLVER_VERSION_V2

const SUPPORTED_PRESETS = new Set(['standard'])
// Cordis publishes FiberState as a const enum without a runtime export.
const ACTIVE_FIBER_STATE: FiberState.ACTIVE = 2
const RC3_STANDARD_DIGEST = '6ef17d769662784848918287d7b115566a080e8a89a0e8683075e21be6fdcdd7'
export const STOCK_PRESET_COMPOSITION_DIGESTS = Object.freeze({
  standard: Object.freeze([
    'ee7045e0f3df05c92f00900aa25f288778ca1e81bdaa35d4e151f1513fce3e16',
    RC3_STANDARD_DIGEST,
  ]),
})

export interface StockSkillRuntimeConfiguration {
  readonly profile: string
  readonly presetId?: string | undefined
  readonly providerName: string
  readonly includeDefaultRoots: boolean
  readonly customSkillDirs: readonly string[]
  readonly stockPresetSkillDir?: string | undefined
  readonly configuredDshHome?: string | undefined
  readonly configuredAgentsHome?: string | undefined
  readonly configuredBundledSkillDir?: string | undefined
  readonly usesContextFileSystem?: true | undefined
}

interface StockFiberProjection {
  readonly parent: { readonly fiber: StockFiberProjection }
  readonly state: FiberState
  readonly effectiveConfig: unknown
}

interface StockPluginRuntimeProjection {
  readonly name?: string | undefined
  readonly fibers: Iterable<StockFiberProjection>
}

export interface StockPresetMountProjection {
  readonly presetId: string
  readonly fiber: StockFiberProjection
  readonly key?: object | undefined
  readonly tree?: {
    readonly ctx?: { readonly baseUrl?: string | undefined }
    readonly root: { readonly data: unknown }
  } | undefined
}

function stockPresetCompositionDigest(mount: StockPresetMountProjection): string | undefined {
  if (mount.presetId !== 'standard') return undefined
  try {
    const rows = mount.tree?.root.data
    return Array.isArray(rows) ? sha256Utf8(canonicalJson(JSON.parse(JSON.stringify(rows)))) : undefined
  } catch {
    return undefined
  }
}

export function hasStockPresetComposition(
  mount: StockPresetMountProjection,
  expectedDigest: string | readonly string[] = STOCK_PRESET_COMPOSITION_DIGESTS.standard,
): boolean {
  const digest = stockPresetCompositionDigest(mount)
  return digest !== undefined
    && (typeof expectedDigest === 'string' ? digest === expectedDigest : expectedDigest.includes(digest))
}

/**
 * Whether the mounted composition still declares the only plugin this contract
 * actually depends on: a single `skill-filesystem` row.
 *
 * The digest list above pins the whole preset composition, which is the
 * strongest statement we can make and the one we prefer. It is also the most
 * brittle: the list is a hash of DeepSeek Harness's own preset file, so every
 * upstream release changes it, and until this repository ships the new hash the
 * whole learning pipeline goes dark. That is exactly what happened on DSH
 * 0.2.3-alpha.2: the recorded digest matched neither pinned value, so
 * `captureRootConfiguration` threw `V2_ROOT_CONFIGURATION_UNAVAILABLE` on every
 * session, and because `agent/pre-step` only logged an `AGENT_SCOPE_UNAVAILABLE`
 * health code, nothing surfaced the real cause.
 *
 * This predicate is the shape we can still check without the hash: the preset
 * is named `standard` and its rows still contain a `skill-filesystem` entry.
 * `resolveMountedStockSkillRuntimeConfiguration` then reads that plugin's live
 * fiber config and `supportedConfiguration` still refuses anything whose
 * provider, default roots or `customSkillDirs` disagree. So a composition that
 * passes here but is genuinely alien is still rejected one layer down - what
 * changes is that an upstream preset edit no longer disables the feature.
 */
export function declaresStockSkillFilesystemRow(mount: StockPresetMountProjection): boolean {
  if (mount.presetId !== 'standard') return false
  try {
    const rows: unknown = mount.tree?.root.data
    if (!Array.isArray(rows)) return false
    return rows.some(row => (
      typeof row === 'object'
      && row !== null
      && !Array.isArray(row)
      && (row as { readonly name?: unknown }).name === '@deepseek-ai/dsh-skill-filesystem'
    ))
  } catch { return false }
}

export interface StockPresetMountPort {
  standingMountFor(
    agentContext: object,
  ): StockPresetMountProjection | undefined | Promise<StockPresetMountProjection | undefined>
}

export interface StockComposedAgentProjection {
  readonly ctx: {
    readonly registry: { values(): Iterable<StockPluginRuntimeProjection> }
    readonly get?: (name: string) => unknown
  }
}

function contextUsesFileSystem(context: object): boolean {
  if (!('get' in context) || typeof context.get !== 'function') return false
  try {
    return context.get('fs') !== undefined
  } catch {
    return true
  }
}

export class StockSkillRuntimeConfigurationCache<TAgent extends object> {
  readonly #entries = new WeakMap<TAgent, StockSkillRuntimeConfiguration>()

  constructor(
    private readonly observe: (
      agent: TAgent,
    ) => Promise<StockSkillRuntimeConfiguration | undefined>,
  ) {}

  async capture(agent: TAgent): Promise<StockSkillRuntimeConfiguration | undefined> {
    const observed = hasUnchangedSessionDirectory(agent) ? await this.observe(agent) : undefined
    if (observed === undefined || !hasUnchangedSessionDirectory(agent)) {
      this.#entries.delete(agent)
      return undefined
    }
    const snapshot = Object.freeze({
      ...observed,
      customSkillDirs: Object.freeze([...observed.customSkillDirs]),
    })
    this.#entries.set(agent, snapshot)
    return snapshot
  }

  get(agent: TAgent): StockSkillRuntimeConfiguration | undefined {
    return hasUnchangedSessionDirectory(agent) ? this.#entries.get(agent) : undefined
  }

  release(agent: TAgent): void {
    this.#entries.delete(agent)
  }
}

export interface StockWorkspaceContractBinding {
  readonly workspaceId: string
  readonly canonicalPath: string
}

export type StockRootContractResolution = {
  readonly status: 'SUPPORTED'
  readonly baselineCommit: typeof STOCK_DSH_BASELINE_COMMIT | typeof STOCK_DSH_RC3_BASELINE_COMMIT
  readonly profile: 'web'
  readonly presetId: 'standard'
  readonly expectedProvider: 'filesystem'
  readonly expectedSource: 'project-dsh' | 'user-dsh'
  readonly resolverVersion: typeof STOCK_ROOT_RESOLVER_VERSION
  readonly rootContractVersion: typeof STOCK_ROOT_CONTRACT_VERSION
  readonly configurationDigest: string
  readonly declaredRootPath: string
  readonly dshHome?: {
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly declaredPath: string
  } | undefined
}

export type StockRootContractResult = StockRootContractResolution | {
  readonly status: 'UNSUPPORTED'
  readonly code: 'ROOT_CONTRACT_UNSUPPORTED' | 'WORKSPACE_BINDING_UNAVAILABLE'
}

export type StockRootScopeIdentity =
  | {
    readonly kind: 'WORKSPACE'
    readonly workspaceId: string
    readonly canonicalPath: string
  }
  | {
    readonly kind: 'DSH_HOME'
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly canonicalPath: string
    readonly identityDigest: string
  }

export interface StockDshRootContractResolverOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly currentEnvironment?: () => Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: () => string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithinFiber(candidate: StockFiberProjection, root: StockFiberProjection): boolean {
  let current = candidate
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/** Directory-changing Sessions require a fresh Session before learning or publication. */
export function hasUnchangedSessionDirectory(agent: object): boolean {
  if (!('session' in agent)) return true
  const session = agent.session
  if (typeof session !== 'object' || session === null || !('snapshotEvents' in session)) return true
  if (typeof session.snapshotEvents !== 'function') return false
  try {
    const events: unknown = session.snapshotEvents()
    return Array.isArray(events) && !events.some(event => (
      typeof event === 'object' && event !== null && event.type === 'working-directory/change'
    ))
  } catch { return false }
}

/** Reads the exact stock filesystem fiber mounted for one Agent's joined generation. */
export async function resolveStockSkillRuntimeConfiguration(
  mounts: StockPresetMountPort,
  agent: StockComposedAgentProjection,
  expectedDigest?: string | readonly string[],
): Promise<StockSkillRuntimeConfiguration | undefined> {
  const mount = await mounts.standingMountFor(agent.ctx)
  if (mount === undefined) return undefined
  // Pinned digest first. When it does not match - which is what every upstream
  // preset edit causes - fall back to the structural check documented on
  // `declaresStockSkillFilesystemRow` instead of refusing to run at all. The
  // fiber and `supportedConfiguration` checks below still decide whether the
  // mounted plugin really is the stock filesystem provider.
  if (
    expectedDigest !== undefined
    && !hasStockPresetComposition(mount, expectedDigest)
    && !declaresStockSkillFilesystemRow(mount)
  ) return undefined
  return resolveMountedStockSkillRuntimeConfiguration(mount, agent)
}

export function resolveMountedStockSkillRuntimeConfiguration(
  mount: StockPresetMountProjection,
  agent: StockComposedAgentProjection,
): StockSkillRuntimeConfiguration | undefined {
  let stockPresetSkillDir: string | undefined
  // Same relaxation as above: the RC3 digest identifies the exact official
  // composition we were built against, and when the upstream preset moves on we
  // still need to resolve the preset's own skills directory, otherwise
  // `supportedConfiguration` rejects the `customSkillDirs` the preset declares.
  if (hasStockPresetComposition(mount, RC3_STANDARD_DIGEST) || declaresStockSkillFilesystemRow(mount)) {
    // Resolve from the same Loader base as the official preset's customSkillDirs expression.
    const baseUrl = mount.tree?.ctx?.baseUrl
    if (baseUrl !== undefined) {
      try {
        const manifest = createRequire(new URL(baseUrl)).resolve('@deepseek-ai/dsh-agent-preset/package.json')
        stockPresetSkillDir = join(dirname(manifest), 'skills')
      } catch {
        // Resolution legitimately fails when the preset lives inside an asar the
        // host has not taught this process to read. Falling through keeps the
        // structural check below in charge instead of turning a module lookup
        // into "this device cannot learn", which is how the whole pipeline went
        // dark before.
        stockPresetSkillDir = undefined
      }
    }
  }
  const fibers = [...agent.ctx.registry.values()]
    .filter(runtime => runtime.name === 'skill-filesystem')
    .flatMap(runtime => [...runtime.fibers])
    .filter(fiber => isWithinFiber(fiber, mount.fiber))
  if (fibers.length !== 1) return undefined
  const fiber = fibers[0]!
  if (fiber.state !== ACTIVE_FIBER_STATE) return undefined
  const config = fiber.effectiveConfig
  if (!isRecord(config)) return undefined
  const providerName = config.providerName ?? 'filesystem'
  const includeDefaultRoots = config.includeDefaultRoots ?? true
  const customSkillDirs = config.customSkillDirs ?? []
  const configuredDshHome = config.dshHome
  const configuredAgentsHome = config.agentsHome
  const configuredBundledSkillDir = config.bundledSkillDir
  const usesContextFileSystem = contextUsesFileSystem(agent.ctx)
  if (
    typeof providerName !== 'string'
    || typeof includeDefaultRoots !== 'boolean'
    || !Array.isArray(customSkillDirs)
    || !customSkillDirs.every(value => typeof value === 'string')
    || (configuredDshHome !== undefined && typeof configuredDshHome !== 'string')
    || (configuredAgentsHome !== undefined && typeof configuredAgentsHome !== 'string')
    || (configuredBundledSkillDir !== undefined && typeof configuredBundledSkillDir !== 'string')
  ) return undefined
  return {
    profile: 'web',
    presetId: mount.presetId,
    providerName,
    includeDefaultRoots,
    customSkillDirs: [...customSkillDirs],
    ...(stockPresetSkillDir === undefined ? {} : { stockPresetSkillDir }),
    ...(configuredDshHome === undefined ? {} : { configuredDshHome }),
    ...(configuredAgentsHome === undefined ? {} : { configuredAgentsHome }),
    ...(configuredBundledSkillDir === undefined ? {} : { configuredBundledSkillDir }),
    ...(usesContextFileSystem ? { usesContextFileSystem: true as const } : {}),
  }
}

function expandHomePath(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDirectory, value.slice(2))
  }
  return value
}

function canonicalConfiguration(
  configuration: StockSkillRuntimeConfiguration,
  baselineCommit: StockRootContractResolution['baselineCommit'],
) {
  return {
    baselineCommit,
    profile: configuration.profile,
    presetId: configuration.presetId ?? null,
    providerName: configuration.providerName,
    includeDefaultRoots: configuration.includeDefaultRoots,
    customSkillDirs: [...configuration.customSkillDirs],
    configuredDshHome: configuration.configuredDshHome ?? null,
    configuredAgentsHome: configuration.configuredAgentsHome ?? null,
    configuredBundledSkillDir: configuration.configuredBundledSkillDir ?? null,
    usesContextFileSystem: configuration.usesContextFileSystem ?? false,
  }
}

/**
 * Whether a configured custom skill directory names the official preset's own
 * `skills` folder, judged from the path alone.
 *
 * Used only when `stockPresetSkillDir` could not be resolved by module lookup -
 * inside an asar, for instance. The official preset contributes exactly one
 * `customSkillDirs` entry and that entry points at `<...>/dsh-agent-preset/skills`,
 * so the tail of the path is enough to tell it apart from a user's own directory
 * while still refusing anything arbitrary.
 */
function looksLikeStockPresetSkillDir(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return normalized.endsWith('/skills') && normalized.slice(0, -'/skills'.length).endsWith('dsh-agent-preset')
}

function supportedConfiguration(
  configuration: StockSkillRuntimeConfiguration,
): configuration is StockSkillRuntimeConfiguration & { readonly presetId: 'standard' } {
  return configuration.profile === 'web'
    && configuration.presetId !== undefined
    && SUPPORTED_PRESETS.has(configuration.presetId)
    && configuration.providerName === 'filesystem'
    && configuration.includeDefaultRoots
    && (configuration.stockPresetSkillDir === undefined
      // Nothing resolved the preset directory, so the preset's own entry has to be
      // recognised by shape. Without this, every host that keeps the preset inside
      // an asar fails here even though the composition is exactly the official one.
      ? configuration.customSkillDirs.length === 0
        || (configuration.customSkillDirs.length === 1 && looksLikeStockPresetSkillDir(configuration.customSkillDirs[0]!))
      : configuration.customSkillDirs.length === 1
        && configuration.customSkillDirs[0] === configuration.stockPresetSkillDir)
}

export class StockDshRootContractResolver {
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #currentEnvironment: () => Readonly<Record<string, string | undefined>>
  readonly #homeDirectory: () => string

  constructor(options: StockDshRootContractResolverOptions = {}) {
    const environment = options.environment ?? process.env
    this.#environment = { ...environment }
    this.#currentEnvironment = options.currentEnvironment
      ?? (options.environment === undefined ? () => process.env : () => environment)
    this.#homeDirectory = options.homeDirectory ?? homedir
  }

  resolve(input: {
    readonly scope: 'PROJECT' | 'USER'
    readonly configuration: StockSkillRuntimeConfiguration
    readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
  }): StockRootContractResult {
    if (!supportedConfiguration(input.configuration)) {
      return { status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' }
    }
    const baselineCommit = input.configuration.stockPresetSkillDir === undefined
      ? STOCK_DSH_BASELINE_COMMIT
      : STOCK_DSH_RC3_BASELINE_COMMIT
    const common = {
      status: 'SUPPORTED' as const,
      baselineCommit,
      profile: 'web' as const,
      presetId: input.configuration.presetId,
      expectedProvider: 'filesystem' as const,
      resolverVersion: STOCK_ROOT_RESOLVER_VERSION,
      rootContractVersion: STOCK_ROOT_CONTRACT_VERSION,
      configurationDigest: sha256Utf8(canonicalJson(canonicalConfiguration(input.configuration, baselineCommit))),
    } as const
    if (input.scope === 'PROJECT') {
      if (input.workspaceBinding === undefined) {
        return { status: 'UNSUPPORTED', code: 'WORKSPACE_BINDING_UNAVAILABLE' }
      }
      return {
        ...common,
        expectedSource: 'project-dsh',
        declaredRootPath: join(input.workspaceBinding.canonicalPath, '.dsh', 'skills'),
      }
    }
    const configuredHome = input.configuration.configuredDshHome
    const environmentHome = this.#environment.DSH_HOME
    if (
      configuredHome === undefined
      && !sameResolvedDshHome(
        environmentHome,
        this.#currentEnvironment().DSH_HOME,
        this.#homeDirectory(),
      )
    ) return { status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' }
    const selected = configuredHome
      ?? (environmentHome !== undefined && environmentHome.trim().length > 0
        ? environmentHome
        : join(this.#homeDirectory(), '.dsh'))
    const declaredPath = resolve(expandHomePath(selected, this.#homeDirectory()))
    return {
      ...common,
      expectedSource: 'user-dsh',
      declaredRootPath: join(declaredPath, 'skills'),
      dshHome: {
        resolutionKind: configuredHome !== undefined
          ? 'CONFIGURATION'
          : environmentHome !== undefined && environmentHome.trim().length > 0
            ? 'ENVIRONMENT'
            : 'DEFAULT',
        declaredPath,
      },
    }
  }
}

function sameResolvedDshHome(
  left: string | undefined,
  right: string | undefined,
  homeDirectory: string,
): boolean {
  const fallback = join(homeDirectory, '.dsh')
  const resolveEnvironmentHome = (value: string | undefined) => resolve(expandHomePath(
    value !== undefined && value.trim().length > 0 ? value : fallback,
    homeDirectory,
  ))
  const a = resolveEnvironmentHome(left)
  const b = resolveEnvironmentHome(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function deriveStockResolutionContractDigest(
  resolution: StockRootContractResolution,
  scopeIdentity: StockRootScopeIdentity,
): string {
  return sha256Utf8(canonicalJson({
    baselineCommit: resolution.baselineCommit,
    profile: resolution.profile,
    presetId: resolution.presetId,
    expectedProvider: resolution.expectedProvider,
    expectedSource: resolution.expectedSource,
    resolverVersion: resolution.resolverVersion,
    rootContractVersion: resolution.rootContractVersion,
    configurationDigest: resolution.configurationDigest,
    declaredRootPath: resolution.declaredRootPath,
    scopeIdentity,
  }))
}
