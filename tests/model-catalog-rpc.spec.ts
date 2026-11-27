import { describe, expect, it } from 'vitest'
import { createModelCatalogRpcHandler, MODEL_CATALOG_ENDPOINT } from '../src/adapters/dsh-connection/model-catalog-rpc.js'
import type { DshLlmPort } from '../src/adapters/dsh-llm/restricted-learning-client.js'

const signal = () => new AbortController().signal

function port(overrides: Partial<DshLlmPort> = {}): DshLlmPort {
  return {
    resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }),
    stream: async function * () { yield* [] },
    ...overrides,
  }
}

async function call(llm: DshLlmPort | undefined) {
  const result = await createModelCatalogRpcHandler(() => llm)(MODEL_CATALOG_ENDPOINT, { apiVersion: 1 }, signal())
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`)
  return result.value as {
    apiVersion: number
    catalogAvailable: boolean
    providers: {
      id: string
      name?: string
      models: { id: string; name?: string }[]
      unavailable?: boolean
    }[]
  }
}

describe('model catalog endpoint', () => {
  it('reports the providers and models this installation can route to', async () => {
    const value = await call(port({
      listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }, { id: 'doubao' }],
      listModels: async provider => provider === 'workbuddy'
        ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
        : [{ id: 'person-deepseek-v4-1-flash-261017' }],
    }))

    expect(value).toEqual({
      apiVersion: 1,
      catalogAvailable: true,
      providers: [
        {
          id: 'workbuddy',
          name: 'WorkBuddy',
          models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
        },
        { id: 'doubao', models: [{ id: 'person-deepseek-v4-1-flash-261017' }] },
      ],
    })
  })

  it('says the catalog is unavailable instead of pretending there are no providers', async () => {
    // An older host exposes neither method. Reporting `providers: []` would look
    // like a configured installation with nothing installed, which is a
    // different and misleading fact.
    expect(await call(port())).toEqual({ apiVersion: 1, catalogAvailable: false, providers: [] })
    expect(await call(undefined)).toEqual({ apiVersion: 1, catalogAvailable: false, providers: [] })
  })

  it('keeps the healthy providers when one provider cannot list its models', async () => {
    const value = await call(port({
      listProviders: () => [{ id: 'broken' }, { id: 'workbuddy' }],
      listModels: async provider => {
        if (provider === 'broken') throw new Error('adapter exploded')
        return [{ id: 'deepseek-v4.1-flash' }]
      },
    }))

    expect(value.providers).toEqual([
      { id: 'broken', models: [], unavailable: true },
      { id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash' }] },
    ])
  })

  it('reports the whole catalog unavailable when the provider list itself throws', async () => {
    const result = await createModelCatalogRpcHandler(() => port({
      listProviders: () => { throw new Error('registry closed') },
      listModels: async () => [],
    }))(MODEL_CATALOG_ENDPOINT, { apiVersion: 1 }, signal())

    expect(result.ok).toBe(false)
  })

  it('bounds the response so one settings render cannot pull thousands of models', async () => {
    const value = await call(port({
      listProviders: () => Array.from({ length: 200 }, (_, index) => ({ id: `provider-${String(index)}` })),
      listModels: async () => Array.from({ length: 1000 }, (_, index) => ({ id: `model-${String(index)}` })),
    }))

    expect(value.providers.length).toBeLessThanOrEqual(64)
    expect(value.providers[0]!.models.length).toBeLessThanOrEqual(256)
  })

  it('rejects a malformed request and passes other endpoints down the chain', async () => {
    const handler = createModelCatalogRpcHandler(
      () => port({ listProviders: () => [], listModels: async () => [] }),
      async endpoint => ({ ok: true, value: { forwarded: endpoint } }),
    )

    const bad = await handler(MODEL_CATALOG_ENDPOINT, { apiVersion: 2 }, signal())
    expect(bad.ok).toBe(false)

    const forwarded = await handler('something-else', {}, signal())
    expect(forwarded).toEqual({ ok: true, value: { forwarded: 'something-else' } })
  })

  it('stops instead of answering once the caller has cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await createModelCatalogRpcHandler(() => port({
      listProviders: () => [{ id: 'workbuddy' }],
      listModels: async () => [{ id: 'model' }],
    }))(MODEL_CATALOG_ENDPOINT, { apiVersion: 1 }, controller.signal)

    expect(result.ok).toBe(false)
  })
})
