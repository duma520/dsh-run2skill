import { z } from 'zod'
import type { DshLlmPort } from '../dsh-llm/restricted-learning-client.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const MODEL_CATALOG_ENDPOINT = 'model-catalog/list'

/**
 * Upper bounds are deliberate rather than generous: a provider that advertises
 * thousands of models would otherwise turn one settings-page render into a huge
 * response and a slow dropdown. Anything beyond the cap is simply not offered.
 */
const MAX_PROVIDERS = 64
const MAX_MODELS_PER_PROVIDER = 256

const requestSchema = z.object({ apiVersion: z.literal(1) }).strict()

export const ModelCatalogResponseV1Schema = z.object({
  apiVersion: z.literal(1),
  /**
   * True when the host port exposes no catalog at all. The settings page then
   * falls back to free-text route fields instead of showing a broken picker.
   */
  catalogAvailable: z.boolean(),
  providers: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256).optional(),
    models: z.array(z.object({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(256).optional(),
    }).strict()).max(MAX_MODELS_PER_PROVIDER),
    /** Set when this provider's model list could not be read. */
    unavailable: z.boolean().optional(),
  }).strict()).max(MAX_PROVIDERS),
}).strict()

export type ModelCatalogResponseV1 = z.infer<typeof ModelCatalogResponseV1Schema>

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Expose the host's live provider/model registry so the settings page can show
 * what this installation can actually route to.
 *
 * This only ever reads metadata. It does not resolve a model, does not send any
 * request, and does not persist anything — the values it returns are offered as
 * choices, and nothing becomes a route until the user saves one.
 *
 * One provider failing must not empty the whole list: a broken provider is
 * reported as `unavailable` and the rest still come back.
 */
export function createModelCatalogRpcHandler(
  getLlm: () => DshLlmPort | undefined,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== MODEL_CATALOG_ENDPOINT) {
      return fallback === undefined
        ? error('bad-request', 'invalid model catalog request')
        : await fallback(endpoint, payload, signal)
    }
    if (!requestSchema.safeParse(payload).success) return error('bad-request', 'invalid model catalog request')
    if (signal.aborted) return error('cancelled', 'model catalog request cancelled')

    const llm = getLlm()
    if (llm?.listProviders === undefined || llm.listModels === undefined) {
      // Older hosts have no catalog surface. Say so plainly rather than
      // pretending the installation has zero providers.
      return { ok: true, value: { apiVersion: 1, catalogAvailable: false, providers: [] } }
    }

    let providers: readonly { readonly id: string; readonly name?: string }[]
    try {
      providers = llm.listProviders().slice(0, MAX_PROVIDERS)
    } catch {
      return error('unavailable', 'model catalog unavailable')
    }

    const entries: ModelCatalogResponseV1['providers'] = []
    for (const provider of providers) {
      if (signal.aborted) return error('cancelled', 'model catalog request cancelled')
      try {
        const models = (await llm.listModels(provider.id))
          .slice(0, MAX_MODELS_PER_PROVIDER)
          .map(model => ({
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
          }))
        entries.push({
          id: provider.id,
          ...(provider.name === undefined ? {} : { name: provider.name }),
          models,
        })
      } catch {
        entries.push({
          id: provider.id,
          ...(provider.name === undefined ? {} : { name: provider.name }),
          models: [],
          unavailable: true,
        })
      }
    }
    return { ok: true, value: { apiVersion: 1, catalogAvailable: true, providers: entries } }
  }
}
