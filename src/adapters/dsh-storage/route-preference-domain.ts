import {
  RoutePreferenceV1Schema,
  type RoutePreferenceV1,
} from '../../domain/retrieval/route-preference.js'
import type { Run2skillStorageContext } from './types.js'

/**
 * 「语义检测优先次序」自己的存储域。
 *
 * 单独开一个域而不是塞进 v2 的 GlobalV2：那边是 `.strict()` 的学习数据主库，
 * 加一个纯 UI 偏好的字段会让每次偏好改动都参与迁移与清洗；这里只存一条
 * global 记录，读写都不碰学习记录，坏了也不影响学习。
 */
export const routePreferenceDomainSpec = {
  name: 'run2skill_route_preference_v1',
  version: 1,
  global: {
    schema: RoutePreferenceV1Schema,
    initial: { version: 1 as const, candidates: [] },
  },
  tables: {},
} as const

export interface RoutePreferenceDomain {
  readonly name: 'run2skill_route_preference_v1'
  readonly global: {
    get(): RoutePreferenceV1
    set(value: RoutePreferenceV1): Promise<void>
  }
  close(): Promise<void>
}

export async function openRoutePreferenceDomain(
  context: Run2skillStorageContext,
): Promise<RoutePreferenceDomain> {
  const domain = await context.storageDomain.open(routePreferenceDomainSpec)
  if (domain.name !== routePreferenceDomainSpec.name) {
    throw new Error('route preference domain name mismatch')
  }
  return domain as unknown as RoutePreferenceDomain
}

/**
 * 候选列表的读写门面。
 *
 * 写走 `#tail` 串行链：界面上的「上移 / 下移」是连点操作，并发写会让顺序
 * 取决于网络回包顺序而不是用户点击顺序。读是同步的内存快照，检测每批次都读
 * 一次（和原先 `retrievalConfig` 的读法一致），改完下一批次即生效。
 */
export class RoutePreferenceStore {
  #domain: RoutePreferenceDomain | undefined
  #opening: Promise<RoutePreferenceDomain> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly context: Run2skillStorageContext) {}

  /** 提前打开存储域，让 `current()` 有同步读的来源。失败返回 false，不抛。 */
  async open(): Promise<boolean> {
    try {
      await this.#open()
      return true
    } catch {
      return false
    }
  }

  /** 同步读当前设置；域还没打开或打不开时退回空列表，不抛错。 */
  current(): RoutePreferenceV1 {
    if (this.#domain === undefined) return { version: 1, candidates: [] }
    const parsed = RoutePreferenceV1Schema.safeParse(this.#domain.global.get())
    return parsed.success ? parsed.data : { version: 1, candidates: [] }
  }

  /** 整体替换候选列表，返回落盘后的值。写失败向上抛，由调用方转成可见错误。 */
  replace(next: RoutePreferenceV1): Promise<RoutePreferenceV1> {
    const validated = RoutePreferenceV1Schema.parse(next)
    return this.#enqueue(async () => {
      const domain = await this.#open()
      await domain.global.set(validated)
      return validated
    })
  }

  async close(): Promise<void> {
    await this.#tail
    if (this.#domain !== undefined) {
      const domain = this.#domain
      this.#domain = undefined
      this.#opening = undefined
      await domain.close()
    }
  }

  async #open(): Promise<RoutePreferenceDomain> {
    this.#opening ??= openRoutePreferenceDomain(this.context).then(
      domain => {
        this.#domain = domain
        return domain
      },
      error => {
        this.#opening = undefined
        throw error
      },
    )
    return await this.#opening
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
