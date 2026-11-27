import { describe, expect, it } from 'vitest'
import {
  DETECTION_ROUTES_GET_ENDPOINT,
  DETECTION_ROUTES_SET_ENDPOINT,
  createDetectionRoutesRpcHandler,
  type RoutePreferencePort,
} from '../src/adapters/dsh-connection/detection-routes-rpc.js'
import {
  MAX_ROUTE_CANDIDATES,
  normalizeRouteCandidates,
  routePreferenceToRoutes,
  type RoutePreferenceV1,
} from '../src/domain/retrieval/route-preference.js'
import type { ObserveSummaryRpcHandler } from '../src/adapters/dsh-connection/observe-summary-rpc.js'

const signal = () => new AbortController().signal

/** 内存替身：和真的 RoutePreferenceStore 一样按整体替换语义写。 */
function port(initial: RoutePreferenceV1 = { version: 1, candidates: [] }): RoutePreferencePort & {
  readonly writes: RoutePreferenceV1[]
} {
  let current = initial
  const writes: RoutePreferenceV1[] = []
  return {
    current: () => current,
    replace: async next => {
      writes.push(next)
      current = next
      return current
    },
    writes,
  }
}

async function get(target: RoutePreferencePort | undefined) {
  const result = await createDetectionRoutesRpcHandler(() => target)(DETECTION_ROUTES_GET_ENDPOINT, { apiVersion: 1 }, signal())
  return result
}

async function set(target: RoutePreferencePort | undefined, candidates: readonly { provider: string; model: string }[]) {
  const result = await createDetectionRoutesRpcHandler(() => target)(
    DETECTION_ROUTES_SET_ENDPOINT,
    { apiVersion: 1, candidates },
    signal(),
  )
  return result
}

describe('detection routes endpoint', () => {
  it('reads back the stored order', async () => {
    const result = await get(port({
      version: 1,
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
        { provider: 'doubao', model: 'person-deepseek' },
      ],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      apiVersion: 1,
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
        { provider: 'doubao', model: 'person-deepseek' },
      ],
    })
  })

  it('stores the order the client sent, trimming and dropping half-filled rows', async () => {
    const target = port()
    const result = await set(target, [
      { provider: ' workbuddy ', model: ' deepseek-v4.1-flash ' },
      { provider: 'doubao', model: '' },
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'doubao', model: 'person-deepseek' },
    ])
    expect(result.ok).toBe(true)
    expect(target.writes).toEqual([{
      version: 1,
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
        { provider: 'doubao', model: 'person-deepseek' },
      ],
    }])
  })

  it('refuses to invent a route list when the storage domain did not open', async () => {
    const result = await get(undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unavailable')
    expect(result.error.message).toBe('detection routes storage unavailable')
  })

  it('carries the storage failure message back instead of returning false silently', async () => {
    const result = await createDetectionRoutesRpcHandler(() => ({
      current: () => ({ version: 1, candidates: [] }),
      replace: async () => { throw new Error('disk full') },
    }))(DETECTION_ROUTES_SET_ENDPOINT, {
      apiVersion: 1,
      candidates: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }],
    }, signal())

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 这正是旧 configForms 通路的缺陷：那边只返回 false，这里必须带上原因。
    expect(result.error.message).toBe('disk full')
  })

  it('rejects a payload that does not match the contract', async () => {
    const result = await createDetectionRoutesRpcHandler(() => port())(
      DETECTION_ROUTES_SET_ENDPOINT,
      { apiVersion: 2, candidates: [] },
      signal(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
  })

  it('reports cancellation rather than a bogus empty list', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await createDetectionRoutesRpcHandler(() => port())(
      DETECTION_ROUTES_GET_ENDPOINT,
      { apiVersion: 1 },
      controller.signal,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('cancelled')
  })

  it('hands unknown endpoints to the next handler in the chain', async () => {
    const seen: string[] = []
    const fallback: ObserveSummaryRpcHandler = async (endpoint) => {
      seen.push(endpoint)
      return { ok: true, value: {} }
    }
    await createDetectionRoutesRpcHandler(() => port(), fallback)('observe-summary', {}, signal())
    expect(seen).toEqual(['observe-summary'])
  })
})

describe('route preference projection', () => {
  it('drops incomplete candidates instead of handing a half route to detection', () => {
    expect(routePreferenceToRoutes({
      version: 1,
      candidates: [
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
        { provider: '', model: 'orphan' },
      ],
    })).toEqual([{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }])
  })

  it('keeps the first occurrence of a duplicated pair', () => {
    const normalized = normalizeRouteCandidates([
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
      { provider: 'a', model: 'x' },
    ])
    expect(normalized.candidates.map(c => c.provider)).toEqual(['a', 'b'])
  })

  it('caps the list at the documented maximum', () => {
    const many = Array.from({ length: MAX_ROUTE_CANDIDATES + 4 }, (_v, index) => ({ provider: 'p', model: `m${index}` }))
    expect(normalizeRouteCandidates(many).candidates).toHaveLength(MAX_ROUTE_CANDIDATES)
  })

  it('is empty for an empty input, which is what "no opinion" means', () => {
    expect(normalizeRouteCandidates([])).toEqual({ version: 1, candidates: [] })
    expect(routePreferenceToRoutes({ version: 1, candidates: [] })).toEqual([])
  })
})
