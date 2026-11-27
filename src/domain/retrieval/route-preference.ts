import { z } from 'zod'
import type { DetectionRoute } from './settings.js'

/**
 * 一条候选路由（provider + model 都必须是完整给出的对）。
 *
 * 与 `DetectionRoute` 同形，但这里用 schema 约束住持久化的形状：写进存储的
 * 东西可能来自旧版本或被人手改过，读回来必须先过一遍校验。
 */
export const RouteCandidateV1Schema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
}).strict()

export type RouteCandidateV1 = z.infer<typeof RouteCandidateV1Schema>

/** 有序候选列表最多存这么多条，防止界面被无限追加撑爆。 */
export const MAX_ROUTE_CANDIDATES = 8

/**
 * 语义检测的路由优先级设置。
 *
 * 为什么不再是「主选 + 兜底」两段固定字段：那样只能表达两个位置，且必须
 * 先选 provider 才能选 model，用户没法表达「第一个不行试第二个，再不行试
 * 第三个」。这里改成一个有序数组，检测时从头逐个尝试，语义更直白。
 */
export const RoutePreferenceV1Schema = z.object({
  version: z.literal(1),
  candidates: z.array(RouteCandidateV1Schema).max(MAX_ROUTE_CANDIDATES),
}).strict()

export type RoutePreferenceV1 = z.infer<typeof RoutePreferenceV1Schema>

/** 空设置：一条候选都没有，检测行为退回「跟随本轮对话自己记录的模型」。 */
export const ROUTE_PREFERENCE_INITIAL: RoutePreferenceV1 = Object.freeze({
  version: 1 as const,
  candidates: Object.freeze([]) as unknown as readonly RouteCandidateV1[],
}) as RoutePreferenceV1

/**
 * 把持久化的候选列表投影成检测层直接能吃的路由数组。
 *
 * 存储层已经用 schema 卡过一遍，这里再过滤一次空值：`domain.global.get()`
 * 在首次 `set` 之前返回的是 spec 的 initial，而旧版本写下的记录可能来自
 * 更宽松的 schema，宁可丢掉一条也不要把半截路由交出去。
 */
export function routePreferenceToRoutes(preference: RoutePreferenceV1): readonly DetectionRoute[] {
  return preference.candidates
    .filter(candidate => candidate.provider.length > 0 && candidate.model.length > 0)
    .map(candidate => ({ provider: candidate.provider, model: candidate.model }))
}

/**
 * 校验并规整一份来自客户端的候选列表。
 *
 * 客户端只该送 `{ provider, model }[]`；这里做去重（同一个 provider+model 出现
 * 两次没有意义，只会让检测重复重试）并保留用户排的顺序。半截行（provider 选了
 * 但 model 还空着）直接跳过：那是界面上的中间态，存进来只会在检测时被过滤掉。
 */
export function normalizeRouteCandidates(
  candidates: readonly { readonly provider: string; readonly model: string }[],
): RoutePreferenceV1 {
  const seen = new Set<string>()
  const normalized: RouteCandidateV1[] = []
  for (const candidate of candidates) {
    const provider = candidate.provider.trim()
    const model = candidate.model.trim()
    if (provider.length === 0 || model.length === 0) continue
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ provider, model })
    if (normalized.length >= MAX_ROUTE_CANDIDATES) break
  }
  return { version: 1, candidates: normalized }
}
