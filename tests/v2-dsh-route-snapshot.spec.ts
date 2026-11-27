import { describe, expect, it } from 'vitest'
import {
  DshV2RouteSnapshotAdapter,
  V2_ROUTE_BUDGET_POLICY_VERSION,
  V2_ROUTE_FALLBACK_POLICY_SUFFIX,
} from '../src/adapters/dsh-llm/v2-route-snapshot.js'
import type { DshLlmPort } from '../src/adapters/dsh-llm/restricted-learning-client.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function observation(turnEndSeq: number, provider = 'deepseek-official', model = 'deepseek-chat') {
  return {
    ...createMinimalV2Fixtures().turnObservation,
    turnEndSeq,
    routeObservation: { provider, model, complete: true },
  }
}

function llm(modelInfo: Awaited<ReturnType<DshLlmPort['resolveModelInfo']>>): DshLlmPort {
  return {
    resolveModelInfo: async () => modelInfo,
    stream: async function * () { /* no model call is allowed while freezing a route */ },
  }
}

describe('DshV2RouteSnapshotAdapter', () => {
  it('freezes the latest complete Turn route and derives a dynamic total byte budget', async () => {
    const adapter = new DshV2RouteSnapshotAdapter(llm({
      context: { contextWindow: 128_000 },
      defaultMaxTokens: 8_192,
      reasoning: {
        efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
        defaultEffort: 'high',
      },
    }))

    await expect(adapter.capture('sl_session', [
      observation(10, 'old-provider', 'old-model'),
      observation(20),
    ])).resolves.toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      policyVersion: V2_ROUTE_BUDGET_POLICY_VERSION,
      maxInputBytes: 117_760,
      maxOutputBytes: 32_768,
      detectionReasoningEffort: 'off',
    })
  })

  it('uses the smaller model output default and never invokes the model stream', async () => {
    let streamed = false
    const port: DshLlmPort = {
      resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 512 }),
      stream: async function * () { streamed = true; yield* [] },
    }
    const snapshot = await new DshV2RouteSnapshotAdapter(port).capture('sl_session', [observation(10)])

    expect(snapshot).toMatchObject({ maxInputBytes: 29_440, maxOutputBytes: 2_048 })
    expect(snapshot).not.toHaveProperty('detectionReasoningEffort')
    expect(streamed).toBe(false)
  })

  it('fails closed when the latest route or resolved model capacity is unavailable or drifts', async () => {
    const incomplete = { ...observation(20), routeObservation: { complete: false } }
    await expect(new DshV2RouteSnapshotAdapter(llm({ context: { contextWindow: 32_000 } }))
      .capture('sl_session', [observation(10), incomplete]))
      .rejects.toThrow('ROUTE_OBSERVATION_UNAVAILABLE')

    await expect(new DshV2RouteSnapshotAdapter(llm({})).capture('sl_session', [observation(10)]))
      .rejects.toThrow('ROUTE_CAPACITY_UNAVAILABLE')

    let calls = 0
    const drifting: DshLlmPort = {
      resolveModelInfo: async () => ({ context: { contextWindow: calls++ === 0 ? 32_000 : 64_000 } }),
      stream: async function * () { yield* [] },
    }
    await expect(new DshV2RouteSnapshotAdapter(drifting).capture('sl_session', [observation(10)]))
      .rejects.toThrow('ROUTE_CAPACITY_CHANGED')
  })

  it('aborts and fails closed when route capacity resolution never settles', async () => {
    let signal: AbortSignal | undefined
    const blocked: DshLlmPort = {
      resolveModelInfo: async (_provider, _model, currentSignal) => {
        signal = currentSignal
        return await new Promise<never>(() => undefined)
      },
      stream: async function * () { yield* [] },
    }
    const adapter = new DshV2RouteSnapshotAdapter(blocked, { internalTimeoutMs: 5 })

    await expect(adapter.capture('sl_session', [observation(10)]))
      .rejects.toThrow('ROUTE_CAPACITY_UNAVAILABLE')
    expect(signal?.aborted).toBe(true)
  })
})

describe('DshV2RouteSnapshotAdapter fallback routes', () => {
  const incomplete = () => ({ ...observation(20), routeObservation: { complete: false } })

  it('freezes the configured route when the Turn itself exposes no route', async () => {
    const adapter = new DshV2RouteSnapshotAdapter(
      llm({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192 }),
      { fallbackRoutes: () => [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }] },
    )

    await expect(adapter.capture('sl_session', [incomplete()])).resolves.toEqual({
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      // The suffix is the only thing distinguishing a configured route from an
      // observed one, so it must appear even though the shape is identical.
      policyVersion: `${V2_ROUTE_BUDGET_POLICY_VERSION}${V2_ROUTE_FALLBACK_POLICY_SUFFIX}`,
      maxInputBytes: 117_760,
      maxOutputBytes: 32_768,
    })
  })

  it('prefers the route the Turn actually used over any configured route', async () => {
    const adapter = new DshV2RouteSnapshotAdapter(
      llm({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192 }),
      { fallbackRoutes: () => [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }] },
    )

    const snapshot = await adapter.capture('sl_session', [observation(10)])

    expect(snapshot).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      policyVersion: V2_ROUTE_BUDGET_POLICY_VERSION,
    })
    expect(snapshot.policyVersion).not.toContain(V2_ROUTE_FALLBACK_POLICY_SUFFIX)
  })

  it('falls through to the next candidate when an earlier one cannot be resolved', async () => {
    const port: DshLlmPort = {
      resolveModelInfo: async provider => {
        if (provider === 'retired') throw new Error('provider was removed')
        return { context: { contextWindow: 32_000 } }
      },
      stream: async function * () { yield* [] },
    }
    const adapter = new DshV2RouteSnapshotAdapter(port, {
      fallbackRoutes: () => [
        { provider: 'retired', model: 'gone' },
        { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      ],
    })

    await expect(adapter.capture('sl_session', [incomplete()])).resolves.toMatchObject({
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      policyVersion: `${V2_ROUTE_BUDGET_POLICY_VERSION}${V2_ROUTE_FALLBACK_POLICY_SUFFIX}`,
    })
  })

  it('still reports an unavailable route when nothing is configured or every candidate fails', async () => {
    const bare = new DshV2RouteSnapshotAdapter(llm({ context: { contextWindow: 32_000 } }))
    await expect(bare.capture('sl_session', [incomplete()]))
      .rejects.toThrow('ROUTE_OBSERVATION_UNAVAILABLE')

    const broken = new DshV2RouteSnapshotAdapter(
      llm({}),
      { fallbackRoutes: () => [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }] },
    )
    await expect(broken.capture('sl_session', [incomplete()]))
      .rejects.toThrow('ROUTE_OBSERVATION_UNAVAILABLE')
  })

  it('keeps a half-configured route from becoming a candidate', async () => {
    // A provider without a model is not a route. Sending traffic to "some model
    // on this provider" would be a guess the user never made.
    const adapter = new DshV2RouteSnapshotAdapter(
      llm({ context: { contextWindow: 32_000 } }),
      { fallbackRoutes: () => [] },
    )
    await expect(adapter.capture('sl_session', [incomplete()]))
      .rejects.toThrow('ROUTE_OBSERVATION_UNAVAILABLE')
  })

  it('re-reads the configured routes on every capture so a settings change applies immediately', async () => {
    let routes = [{ provider: 'first', model: 'one' }]
    const adapter = new DshV2RouteSnapshotAdapter(
      llm({ context: { contextWindow: 32_000 } }),
      { fallbackRoutes: () => routes },
    )

    expect((await adapter.capture('sl_session', [incomplete()])).provider).toBe('first')
    routes = [{ provider: 'second', model: 'two' }]
    expect((await adapter.capture('sl_session', [incomplete()])).provider).toBe('second')
  })
})
