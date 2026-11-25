import { z } from 'zod'

/**
 * Read-side telemetry: how often an already existing Skill body was actually
 * handed to the model as a recall candidate.
 *
 * This is deliberately approximate and derived, never recorded. A recall
 * proves the body was served, never that the model read it or that the user
 * relied on it. Keeping the wording honest matters: this number is a hint for
 * curation, not proof.
 *
 * Nothing is persisted for this view. The authoritative facts already live on
 * `experience_intents[].recall.candidates[]` — a candidate that carries a
 * `bodyDigest` is exactly one whose bytes were read out of the catalog and put
 * in front of the coverage model. Storing a second copy would only create a
 * second thing to keep in sync (and to purge).
 */
export const RECALL_TELEMETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000
export const MAX_RECALL_SUMMARIES = 64

const isoDateTime = z.string().datetime({ offset: true })
const skillNameSchema = z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const scopeSchema = z.enum(['PROJECT', 'USER', 'UNKNOWN'])

export const RecallTelemetrySummaryV1Schema = z.object({
  schemaVersion: z.literal(1),
  skillName: skillNameSchema,
  scope: scopeSchema,
  recallCount: z.number().int().positive(),
  lastRecalledAt: isoDateTime,
}).strict()

export type RecallTelemetrySummaryV1 = z.infer<typeof RecallTelemetrySummaryV1Schema>

/**
 * One served candidate, already reduced to the facts this view needs.
 *
 * `recalledAt` is the moment the intent holding the candidate was last written;
 * it is the closest honest timestamp the durable record offers.
 */
export interface RecallExposure {
  readonly skillName: string
  readonly scope: 'PROJECT' | 'USER' | 'UNKNOWN'
  readonly recalledAt: string
  readonly workspaceId?: string
}

export interface RecallTelemetryWindow {
  readonly now: number
  readonly workspaceId?: string
}

/**
 * The subset of a v2 intent that matters here. Declared structurally so this
 * module keeps no dependency on the v2 schema module.
 */
export interface RecallTelemetryIntentProjection {
  readonly sessionLifecycleKey: string
  readonly createdAt: string
  readonly recall: {
    readonly state: string
    readonly candidates: readonly {
      readonly bodyDigest?: string | undefined
      readonly summary: {
        readonly name: string
        readonly scope: 'PROJECT' | 'USER'
      }
    }[]
  }
}

export interface RecallTelemetryWorkspaceBinding {
  readonly workspaceId: string
  readonly scopeIdentityDigest: string
}

export interface CollectRecallExposuresInput {
  readonly intents: Iterable<RecallTelemetryIntentProjection>
  /**
   * PROJECT-scope bindings keyed by session lifecycle. Turn observations are
   * where a lifecycle is bound to a workspace; an intent alone does not know
   * which workspace its Skills belong to.
   */
  readonly projectBindings: ReadonlyMap<string, RecallTelemetryWorkspaceBinding>
  readonly workspace?: {
    readonly workspaceId: string
    readonly scopeIdentityDigest: string
  }
}

/**
 * Reduce durable intents to exposures.
 *
 * A candidate without a body digest never had its bytes read, so it is not an
 * exposure. A PROJECT candidate whose lifecycle cannot be bound to a workspace
 * is dropped for the same reason the summary drops it: we refuse to invent an
 * owner.
 */
export function collectRecallExposures(
  input: CollectRecallExposuresInput,
): readonly RecallExposure[] {
  const exposures: RecallExposure[] = []
  for (const intent of input.intents) {
    if (intent.recall.state !== 'COMPLETE') continue
    for (const candidate of intent.recall.candidates) {
      if (candidate.bodyDigest === undefined) continue
      const scope = candidate.summary.scope
      let workspaceId: string | undefined
      if (scope === 'PROJECT') {
        const bound = input.projectBindings.get(intent.sessionLifecycleKey)
        if (bound === undefined) continue
        if (
          input.workspace !== undefined
          && (bound.workspaceId !== input.workspace.workspaceId
            || bound.scopeIdentityDigest !== input.workspace.scopeIdentityDigest)
        ) continue
        workspaceId = bound.workspaceId
      }
      exposures.push({
        skillName: candidate.summary.name,
        scope,
        recalledAt: intent.createdAt,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      })
    }
  }
  return exposures
}

/**
 * Collapse exposures into per-skill counters over the recent window.
 *
 * Ordering is deterministic (count desc, then name asc, then scope asc) so the
 * settings page does not reshuffle identical rows between polls.
 */
export function summarizeRecallTelemetry(
  exposures: Iterable<RecallExposure>,
  window: RecallTelemetryWindow,
): readonly RecallTelemetrySummaryV1[] {
  const cutoff = window.now - RECALL_TELEMETRY_WINDOW_MS
  const buckets = new Map<string, {
    skillName: string
    scope: 'PROJECT' | 'USER' | 'UNKNOWN'
    recallCount: number
    lastRecalledAt: string
  }>()
  for (const exposure of exposures) {
    const recalledAt = Date.parse(exposure.recalledAt)
    if (!Number.isFinite(recalledAt) || recalledAt < cutoff) continue
    /*
     * A PROJECT-scoped skill belongs to one workspace. Without a resolved
     * workspace we cannot tell whose count we are showing, so those exposures
     * are left out rather than merged into one misleading number.
     */
    if (exposure.scope === 'PROJECT' && exposure.workspaceId !== window.workspaceId) continue
    const key = `${exposure.skillName}\u0000${exposure.scope}`
    const bucket = buckets.get(key)
    if (bucket === undefined) {
      buckets.set(key, {
        skillName: exposure.skillName,
        scope: exposure.scope,
        recallCount: 1,
        lastRecalledAt: exposure.recalledAt,
      })
      continue
    }
    bucket.recallCount += 1
    if (Date.parse(exposure.recalledAt) > Date.parse(bucket.lastRecalledAt)) {
      bucket.lastRecalledAt = exposure.recalledAt
    }
  }
  return [...buckets.values()]
    .sort((left, right) => (
      right.recallCount - left.recallCount
      || left.skillName.localeCompare(right.skillName)
      || left.scope.localeCompare(right.scope)
    ))
    .slice(0, MAX_RECALL_SUMMARIES)
    .map(bucket => RecallTelemetrySummaryV1Schema.parse({
      schemaVersion: 1,
      skillName: bucket.skillName,
      scope: bucket.scope,
      recallCount: bucket.recallCount,
      lastRecalledAt: bucket.lastRecalledAt,
    }))
}
