/**
 * One provider/model pair a caller can freeze as a batch route.
 *
 * Kept as a plain pair instead of an object with optional members so callers
 * cannot hand us a half-filled route: either both halves are known or the
 * route does not exist.
 */
export interface DetectionRoute {
  readonly provider: string
  readonly model: string
}
export interface RetrievalSettings {
  readonly advancedRecall: boolean
  readonly embeddingEndpoint: string
  readonly embeddingModel: string
  readonly embeddingApiKeyEnv: string
  readonly rerankerMode: 'SESSION' | 'SERVICE'
  readonly rerankerEndpoint: string
  readonly rerankerModel: string
  readonly rerankerApiKeyEnv: string
  /**
   * Route used to run semantic detection when the Turn itself carries no
   * observable route.
   *
   * The observation layer only trusts `request/header`, and DSH does not emit
   * that event on every Turn, so "semantic detection has no route" is a normal
   * state rather than a fault. Letting the user pin a model turns that state
   * from "batch is stuck forever" into "detection runs on a known model".
   */
  readonly detectionProvider: string
  readonly detectionModel: string
  /** Second choice, tried only when the pinned route above cannot be resolved. */
  readonly fallbackProvider: string
  readonly fallbackModel: string
}
export const RETRIEVAL_DEFAULTS: RetrievalSettings = Object.freeze({
  advancedRecall: false,
  embeddingEndpoint: '',
  embeddingModel: 'Qwen/Qwen3-Embedding-0.6B',
  embeddingApiKeyEnv: '',
  rerankerMode: 'SESSION' as 'SESSION' | 'SERVICE',
  rerankerEndpoint: '',
  rerankerModel: 'Qwen/Qwen3-Reranker-0.6B',
  rerankerApiKeyEnv: '',
  // Empty means "no opinion": detection then depends on the Turn carrying an
  // observable route, which is the pre-existing behaviour.
  detectionProvider: '',
  detectionModel: '',
  fallbackProvider: '',
  fallbackModel: '',
})

/**
 * Read one route out of the four flat settings fields.
 *
 * A half-filled pair is treated as absent on purpose. Guessing the missing half
 * would silently send detection traffic to a model nobody selected.
 */
export function detectionRoute(
  provider: string,
  model: string,
): DetectionRoute | undefined {
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}
