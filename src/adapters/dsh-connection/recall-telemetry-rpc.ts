import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  ScopeBindingV2Schema,
  TurnObservationV2Schema,
} from '../../domain/v2/index.js'
import {
  RECALL_TELEMETRY_WINDOW_MS,
  collectRecallExposures,
  summarizeRecallTelemetry,
} from '../../domain/activity/recall-telemetry.js'
import {
  CurrentScopeV1Schema,
  type CurrentWorkspaceResolver,
} from './current-scope-authorizer.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const RECALL_TELEMETRY_ENDPOINT = 'recall-telemetry/list'

const requestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  expectedVisibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/).optional(),
}).strict()

export const RecallTelemetryResponseV1Schema = z.object({
  apiVersion: z.literal(1),
  visibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/),
  windowDays: z.literal(30),
  items: z.array(z.object({
    skillName: z.string().min(1).max(128),
    scope: z.enum(['PROJECT', 'USER', 'UNKNOWN']),
    recallCount: z.number().int().positive(),
    lastRecalledAt: z.string().datetime({ offset: true }),
  }).strict()).max(64),
}).strict()

export type RecallTelemetryResponseV1 = z.infer<typeof RecallTelemetryResponseV1Schema>

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

/**
 * Read-side usage counters, computed from the v2 domain on every request.
 *
 * This is deliberately a separate endpoint from `recent-activity/list`. That
 * one answers "what did Run2Skill publish", this one answers "whose body was
 * handed to the model". Merging them would give one number two meanings.
 *
 * Nothing here is persisted: `experience_intents[].recall.candidates[]` with a
 * `bodyDigest` is already the authoritative record that the bytes were read,
 * so a derived copy would only need its own purge and checkpoint handling.
 *
 * Known limitation, stated plainly: the durable intent carries no dedicated
 * "recalled at" timestamp, so `createdAt` is used as a lower bound. That biases
 * the window towards under-reporting rather than showing a recall that never
 * happened.
 */
export function createRecallTelemetryRpcHandler(
  getDomain: () => Run2skillV2Domain | undefined,
  resolveWorkspace: CurrentWorkspaceResolver,
  fallback?: ObserveSummaryRpcHandler,
  now: () => string = () => new Date().toISOString(),
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== RECALL_TELEMETRY_ENDPOINT) {
      return fallback === undefined
        ? error('bad-request', 'invalid recall telemetry request')
        : await fallback(endpoint, payload, signal)
    }
    const request = requestSchema.safeParse(payload)
    if (!request.success) return error('bad-request', 'invalid recall telemetry request')
    if (signal.aborted) return error('cancelled', 'recall telemetry request cancelled')
    const domain = getDomain()
    if (domain === undefined) return error('unavailable', 'recall telemetry unavailable')
    try {
      const workspace = request.data.currentScope.kind === 'WORKSPACE'
        ? await resolveWorkspace(request.data.currentScope.workspaceId)
        : undefined
      if (request.data.currentScope.kind === 'WORKSPACE' && workspace === undefined) {
        return error('scope-unavailable', 'current workspace unavailable')
      }
      const workspaceDigest = workspace === undefined
        ? undefined
        : deriveProjectScopeIdentityDigest(workspace.canonicalPath)

      /*
       * A PROJECT-scoped Skill belongs to exactly one workspace, but the intent
       * only carries a session lifecycle key. Turn observations are where the
       * lifecycle is bound to a workspace, so resolve that mapping first.
       */
      const lifecycleWorkspaces = new Map<string, { workspaceId: string; scopeIdentityDigest: string }>()
      for (const [, raw] of domain.table('turn_observations').entries()) {
        const parsed = TurnObservationV2Schema.safeParse(raw)
        if (!parsed.success) continue
        const binding = ScopeBindingV2Schema.safeParse(parsed.data.scopeBinding)
        if (!binding.success || binding.data.status !== 'PROJECT') continue
        lifecycleWorkspaces.set(parsed.data.sessionLifecycleKey, {
          workspaceId: binding.data.workspaceId,
          scopeIdentityDigest: binding.data.scopeIdentityDigest,
        })
      }

      const exposures = collectRecallExposures({
        intents: [...domain.table('experience_intents').entries()].flatMap(([, raw]) => {
          const parsed = ExperienceIntentV2Schema.safeParse(raw)
          return parsed.success ? [parsed.data] : []
        }),
        projectBindings: lifecycleWorkspaces,
        ...(workspace === undefined
          ? {}
          : { workspace: { workspaceId: workspace.workspaceId, scopeIdentityDigest: workspaceDigest! } }),
      })

      const items = summarizeRecallTelemetry(exposures, {
        now: Date.parse(now()),
        ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
      })
      const global = GlobalV2Schema.parse(domain.global.get())
      const visibilityRevision = `visibility_${digest({
        catalogEpoch: global.proposalCatalogEpoch,
        purge: global.purgeJournal ?? null,
        items,
        windowDays: Math.round(RECALL_TELEMETRY_WINDOW_MS / (24 * 60 * 60 * 1_000)),
      })}`
      if (
        request.data.expectedVisibilityRevision !== undefined
        && request.data.expectedVisibilityRevision !== visibilityRevision
      ) return error('visibility-stale', 'recall telemetry visibility changed')
      return { ok: true, value: RecallTelemetryResponseV1Schema.parse({
        apiVersion: 1,
        visibilityRevision,
        windowDays: 30,
        items,
      }) }
    } catch {
      return error('internal', 'recall telemetry unavailable')
    }
  }
}
