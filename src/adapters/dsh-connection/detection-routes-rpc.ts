import { z } from 'zod'
import {
  MAX_ROUTE_CANDIDATES,
  RouteCandidateV1Schema,
  RoutePreferenceV1Schema,
  normalizeRouteCandidates,
  type RoutePreferenceV1,
} from '../../domain/retrieval/route-preference.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

/**
 * 语义检测优先次序的读写端点。
 *
 * 为什么不复用宿主 configForms：那套通路是「插件 Config 字段」的投影，写失败时
 * `ConfigFormController.mutate` 只返回 boolean、把失败原因整个丢掉，界面只能
 * 静默回弹。检测路由本身又不是插件启动配置（不需要重挂载），存到插件自己的
 * 存储域、走自己的 RPC，失败能如实报出来，也不会因为 Config schema 的任何一点
 * 形状不合就整块变灰。
 */
export const DETECTION_ROUTES_GET_ENDPOINT = 'detection-routes/get'
export const DETECTION_ROUTES_SET_ENDPOINT = 'detection-routes/set'

const getRequestSchema = z.object({ apiVersion: z.literal(1) }).strict()

const setRequestSchema = z.object({
  apiVersion: z.literal(1),
  /**
   * 客户端提交的完整候选列表，顺序即优先级，第一条最优先。
   *
   * 这里刻意用「允许空串」的宽松形状，而不是复用 `RouteCandidateV1Schema`：
   * 界面上「新增一个候选」刚加出来就是 `{ provider: '', model: '' }`，
   * 用户填 provider 到填 model 之间还会有一段时间是半截行。用严格形状会把这些
   * 中间态整份判成 bad-request，用户看到的是「保存失败」却不知道自己只是还没填完。
   * 规整与丢弃半截行交给 `normalizeRouteCandidates`。
   */
  candidates: z.array(z.object({
    provider: z.string().max(128),
    model: z.string().max(256),
  }).strict()).max(64),
}).strict()

export const DetectionRoutesResponseV1Schema = z.object({
  apiVersion: z.literal(1),
  candidates: z.array(RouteCandidateV1Schema).max(MAX_ROUTE_CANDIDATES),
}).strict()

export type DetectionRoutesResponseV1 = z.infer<typeof DetectionRoutesResponseV1Schema>

/** 端点需要的读写能力；由 RoutePreferenceStore 实现，测试可注入内存替身。 */
export interface RoutePreferencePort {
  current(): RoutePreferenceV1
  replace(next: RoutePreferenceV1): Promise<RoutePreferenceV1>
}

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

function respond(preference: RoutePreferenceV1): ObserveRpcResult<DetectionRoutesResponseV1> {
  const parsed = RoutePreferenceV1Schema.safeParse(preference)
  const candidates = parsed.success ? parsed.data.candidates : []
  return { ok: true, value: { apiVersion: 1, candidates: [...candidates] } }
}

/**
 * 读取时永远返回成功（哪怕设置是空的）：界面要区分「没设置」和「读不到」，
 * 只有真的取不到存储才报错。
 */
export function createDetectionRoutesRpcHandler(
  getPort: () => RoutePreferencePort | undefined,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== DETECTION_ROUTES_GET_ENDPOINT && endpoint !== DETECTION_ROUTES_SET_ENDPOINT) {
      return fallback === undefined
        ? error('bad-request', 'invalid detection routes request')
        : await fallback(endpoint, payload, signal)
    }
    if (signal.aborted) return error('cancelled', 'detection routes request cancelled')
    const port = getPort()
    if (port === undefined) return error('unavailable', 'detection routes storage unavailable')

    if (endpoint === DETECTION_ROUTES_GET_ENDPOINT) {
      const request = getRequestSchema.safeParse(payload)
      if (!request.success) return error('bad-request', 'invalid detection routes request')
      try {
        return respond(port.current())
      } catch (cause) {
        return error('unavailable', cause instanceof Error ? cause.message : 'detection routes unavailable')
      }
    }

    const request = setRequestSchema.safeParse(payload)
    if (!request.success) return error('bad-request', 'invalid detection routes update request')
    try {
      const normalized = normalizeRouteCandidates(request.data.candidates.map(candidate => ({
        provider: candidate.provider ?? '',
        model: candidate.model ?? '',
      })))
      return respond(await port.replace(normalized))
    } catch (cause) {
      // 写失败必须带原因回客户端：界面上「保存没成功」要能说清是存储坏了还是校验没过，
      // 而不是像 configForms 那样只弹回原值。
      return error('unavailable', cause instanceof Error ? cause.message : 'detection routes not saved')
    }
  }
}
