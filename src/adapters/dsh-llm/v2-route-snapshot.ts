import { canonicalJson } from '../../domain/learn/identity.js'
import type { SessionBatchV2, TurnObservationV2 } from '../../domain/v2/index.js'
import type { DetectionRoute } from '../../domain/retrieval/settings.js'
import type { DshLlmPort } from './restricted-learning-client.js'

export const V2_ROUTE_BUDGET_POLICY_VERSION = 'route-budget-v3'
/**
 * Suffix appended when the route came from the user's configuration instead of
 * the Turn's own `request/header` observation.
 *
 * The suffix keeps the two indistinguishable in shape but never in provenance:
 * a stored batch always says whether it ran on the route the conversation used
 * or on the route the user pinned as a stand-in.
 */
export const V2_ROUTE_FALLBACK_POLICY_SUFFIX = '+fallback'

const MAX_STAGE_OUTPUT_TOKENS = 16_384
const CONTEXT_SAFETY_TOKENS = 2_048
const OUTPUT_BYTE_RATIO = 4
const ROUTE_RESOLUTION_TIMEOUT_MS = 5_000

type RouteSnapshot = SessionBatchV2['routeSnapshot']

interface DshV2RouteSnapshotAdapterOptions {
  /** @internal Allows deterministic boundary tests; Host wiring uses the versioned default deadline. */
  readonly internalTimeoutMs?: number
  /**
   * Routes to try, in order, when the batch carries no observable route.
   *
   * Read lazily on every capture so a settings change takes effect without a
   * restart, and so an empty list keeps the strict pre-existing behaviour.
   */
  readonly fallbackRoutes?: () => readonly DetectionRoute[]
}

export class DshV2RouteSnapshotError extends Error {
  constructor(readonly code:
    | 'ROUTE_OBSERVATION_UNAVAILABLE'
    | 'ROUTE_CAPACITY_UNAVAILABLE'
    | 'ROUTE_CAPACITY_CHANGED'
  ) {
    super(code)
    this.name = 'DshV2RouteSnapshotError'
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function resolvedCapacity(value: Awaited<ReturnType<DshLlmPort['resolveModelInfo']>>): {
  readonly contextWindow: number
  readonly outputTokens: number
  readonly detectionReasoningEffort?: string
} | undefined {
  const contextWindow = value.context?.contextWindow
  const defaultMaxTokens = value.defaultMaxTokens
  if (!positiveSafeInteger(contextWindow)) return undefined
  if (defaultMaxTokens !== undefined && !positiveSafeInteger(defaultMaxTokens)) return undefined
  const outputTokens = Math.min(
    defaultMaxTokens ?? MAX_STAGE_OUTPUT_TOKENS,
    MAX_STAGE_OUTPUT_TOKENS,
    Math.max(1, Math.floor(contextWindow / 4)),
  )
  const detectionReasoningEffort = value.reasoning?.efforts.find(effort => effort.id === 'off')?.id
  return {
    contextWindow,
    outputTokens,
    ...(detectionReasoningEffort === undefined ? {} : { detectionReasoningEffort }),
  }
}

/**
 * Freezes one exact provider/model route without making a model request.
 *
 * Input bytes deliberately use one byte per available context token. Since
 * each UTF-8 byte can consume at most one byte-level tokenizer token, this is
 * conservative for arbitrary JSON text. Output bytes use a separate bounded
 * policy and the stage client also caps the requested token count from it.
 */
export class DshV2RouteSnapshotAdapter {
  readonly #timeoutMs: number
  readonly #fallbackRoutes: () => readonly DetectionRoute[]

  constructor(
    private readonly llm: DshLlmPort,
    options: DshV2RouteSnapshotAdapterOptions = {},
  ) {
    this.#timeoutMs = options.internalTimeoutMs ?? ROUTE_RESOLUTION_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new TypeError('Invalid v2 route resolution timeout')
    }
    this.#fallbackRoutes = options.fallbackRoutes ?? (() => [])
  }

  async capture(
    _sessionLifecycleKey: string,
    observations: readonly TurnObservationV2[],
  ): Promise<RouteSnapshot> {
    const latest = [...observations].sort((left, right) => right.turnEndSeq - left.turnEndSeq)[0]
    const observed = latest?.routeObservation
    const observedRoute = observed?.complete === true
      && observed.provider !== undefined
      && observed.model !== undefined
      ? { provider: observed.provider, model: observed.model }
      : undefined

    if (observedRoute !== undefined) {
      return await this.#snapshot(observedRoute, V2_ROUTE_BUDGET_POLICY_VERSION)
    }
    // No observable route: this is the normal state for Turns whose request
    // header was never logged, not a corrupt session. Try the configured
    // routes before declaring the batch unrunnable.
    for (const candidate of this.#fallbackRoutes()) {
      const configured = { provider: candidate.provider, model: candidate.model }
      // A configured route that cannot be resolved is skipped rather than
      // fatal: the next candidate is a complete alternative, and the caller
      // still gets ROUTE_OBSERVATION_UNAVAILABLE if every candidate fails.
      const snapshot = await this.#trySnapshot(
        configured,
        `${V2_ROUTE_BUDGET_POLICY_VERSION}${V2_ROUTE_FALLBACK_POLICY_SUFFIX}`,
      )
      if (snapshot !== undefined) return snapshot
    }
    throw new DshV2RouteSnapshotError('ROUTE_OBSERVATION_UNAVAILABLE')
  }

  /** Resolve one candidate, letting capacity failures escape as their own codes. */
  async #snapshot(
    route: DetectionRoute,
    policyVersion: string,
  ): Promise<RouteSnapshot> {
    let first
    let second
    try {
      first = resolvedCapacity(await this.#resolveModelInfo(route.provider, route.model))
      second = resolvedCapacity(await this.#resolveModelInfo(route.provider, route.model))
    } catch {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    if (first === undefined || second === undefined) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_CHANGED')
    }
    const safetyTokens = Math.min(CONTEXT_SAFETY_TOKENS, Math.max(1, Math.floor(first.contextWindow / 8)))
    const maxInputBytes = first.contextWindow - first.outputTokens - safetyTokens
    if (!positiveSafeInteger(maxInputBytes)) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    return {
      provider: route.provider,
      model: route.model,
      policyVersion,
      maxInputBytes,
      maxOutputBytes: first.outputTokens * OUTPUT_BYTE_RATIO,
      ...(first.detectionReasoningEffort === undefined
        ? {}
        : { detectionReasoningEffort: first.detectionReasoningEffort }),
    }
  }

  /** Same as #snapshot, but a failure only disqualifies this one candidate. */
  async #trySnapshot(
    route: DetectionRoute,
    policyVersion: string,
  ): Promise<RouteSnapshot | undefined> {
    try {
      return await this.#snapshot(route, policyVersion)
    } catch {
      return undefined
    }
  }

  async #resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<Awaited<ReturnType<DshLlmPort['resolveModelInfo']>>> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.llm.resolveModelInfo(provider, model, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE'))
          }, this.#timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
