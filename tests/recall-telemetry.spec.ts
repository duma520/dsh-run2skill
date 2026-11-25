import { describe, expect, it } from 'vitest'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import {
  MAX_RECALL_SUMMARIES,
  RECALL_TELEMETRY_WINDOW_MS,
  collectRecallExposures,
  summarizeRecallTelemetry,
  type RecallExposure,
  type RecallTelemetryIntentProjection,
} from '../src/domain/activity/recall-telemetry.js'
import { createRecallTelemetryRpcHandler } from '../src/adapters/dsh-connection/recall-telemetry-rpc.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const NOW = Date.parse('2026-08-22T02:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString()
const DAY = 24 * 60 * 60 * 1_000

function exposure(overrides: Partial<RecallExposure> = {}): RecallExposure {
  return {
    skillName: 'save-workflow',
    scope: 'USER',
    recalledAt: iso(DAY),
    ...overrides,
  }
}

function intent(
  overrides: Partial<RecallTelemetryIntentProjection> = {},
): RecallTelemetryIntentProjection {
  return {
    sessionLifecycleKey: 'sl-fixed',
    createdAt: iso(DAY),
    recall: {
      state: 'COMPLETE',
      candidates: [{
        bodyDigest: 'a'.repeat(64),
        summary: { name: 'save-workflow', scope: 'USER' },
      }],
    },
    ...overrides,
  }
}

describe('recall telemetry summarization', () => {
  it('counts repeated exposures of the same Skill and scope as one row', () => {
    const items = summarizeRecallTelemetry([
      exposure({ recalledAt: iso(3 * DAY) }),
      exposure({ recalledAt: iso(2 * DAY) }),
      exposure({ recalledAt: iso(DAY) }),
    ], { now: NOW })
    expect(items).toEqual([{
      schemaVersion: 1,
      skillName: 'save-workflow',
      scope: 'USER',
      recallCount: 3,
      lastRecalledAt: iso(DAY),
    }])
  })

  it('keeps distinct Skills in distinct rows', () => {
    const items = summarizeRecallTelemetry([
      exposure({ skillName: 'save-workflow' }),
      exposure({ skillName: 'write-tests' }),
    ], { now: NOW })
    expect(items.map(item => item.skillName)).toEqual(['save-workflow', 'write-tests'])
  })

  it('keeps one Skill name apart when the scope differs', () => {
    const items = summarizeRecallTelemetry([
      exposure({ scope: 'USER' }),
      exposure({ scope: 'PROJECT', workspaceId: 'ws-1' }),
    ], { now: NOW, workspaceId: 'ws-1' })
    expect(items.map(item => item.scope).sort()).toEqual(['PROJECT', 'USER'])
  })

  it('ignores exposures older than the reporting window', () => {
    const items = summarizeRecallTelemetry([
      exposure({ recalledAt: iso(RECALL_TELEMETRY_WINDOW_MS + DAY) }),
      exposure({ recalledAt: iso(DAY) }),
    ], { now: NOW })
    expect(items[0]?.recallCount).toBe(1)
  })

  it('drops PROJECT exposures when no workspace is resolved', () => {
    const items = summarizeRecallTelemetry([
      exposure({ scope: 'PROJECT', workspaceId: 'ws-1' }),
      exposure({ scope: 'PROJECT', workspaceId: 'ws-2' }),
    ], { now: NOW })
    expect(items).toEqual([])
  })

  it('drops PROJECT exposures that belong to a different workspace', () => {
    const items = summarizeRecallTelemetry([
      exposure({ scope: 'PROJECT', workspaceId: 'ws-1' }),
      exposure({ scope: 'PROJECT', workspaceId: 'ws-2' }),
    ], { now: NOW, workspaceId: 'ws-1' })
    expect(items).toHaveLength(1)
    expect(items[0]?.recallCount).toBe(1)
  })

  it('orders by count, then name, then scope so polls stay stable', () => {
    const items = summarizeRecallTelemetry([
      exposure({ skillName: 'b-skill' }),
      exposure({ skillName: 'a-skill' }),
      exposure({ skillName: 'c-skill' }),
      exposure({ skillName: 'c-skill' }),
    ], { now: NOW })
    expect(items.map(item => item.skillName)).toEqual(['c-skill', 'a-skill', 'b-skill'])
  })

  it('caps the number of reported rows', () => {
    const many = Array.from({ length: MAX_RECALL_SUMMARIES + 10 }, (_, index) => (
      exposure({ skillName: `skill-${index}` })
    ))
    expect(summarizeRecallTelemetry(many, { now: NOW })).toHaveLength(MAX_RECALL_SUMMARIES)
  })
})

describe('recall exposure collection', () => {
  it('uses only candidates whose bytes were actually read', () => {
    const exposures = collectRecallExposures({
      intents: [intent({
        recall: {
          state: 'COMPLETE',
          candidates: [
            { bodyDigest: 'a'.repeat(64), summary: { name: 'read-skill', scope: 'USER' } },
            { summary: { name: 'unread-skill', scope: 'USER' } },
          ],
        },
      })],
      projectBindings: new Map(),
    })
    expect(exposures.map(item => item.skillName)).toEqual(['read-skill'])
  })

  it('skips intents whose recall never completed', () => {
    const exposures = collectRecallExposures({
      intents: [intent({ recall: { state: 'SCANNING', candidates: [
        { bodyDigest: 'a'.repeat(64), summary: { name: 'halfway-skill', scope: 'USER' } },
      ] } })],
      projectBindings: new Map(),
    })
    expect(exposures).toEqual([])
  })

  it('attributes a PROJECT skill through its session lifecycle binding', () => {
    const digest = deriveProjectScopeIdentityDigest('D:\\workspace')
    const exposures = collectRecallExposures({
      intents: [intent({
        sessionLifecycleKey: 'sl-bound',
        recall: { state: 'COMPLETE', candidates: [
          { bodyDigest: 'a'.repeat(64), summary: { name: 'project-skill', scope: 'PROJECT' } },
        ] },
      })],
      projectBindings: new Map([['sl-bound', { workspaceId: 'ws-1', scopeIdentityDigest: digest }]]),
      workspace: { workspaceId: 'ws-1', scopeIdentityDigest: digest },
    })
    expect(exposures).toEqual([{
      skillName: 'project-skill',
      scope: 'PROJECT',
      recalledAt: iso(DAY),
      workspaceId: 'ws-1',
    }])
  })

  it('drops a PROJECT skill whose lifecycle was never bound to a workspace', () => {
    const exposures = collectRecallExposures({
      intents: [intent({
        recall: { state: 'COMPLETE', candidates: [
          { bodyDigest: 'a'.repeat(64), summary: { name: 'orphan-skill', scope: 'PROJECT' } },
        ] },
      })],
      projectBindings: new Map(),
    })
    expect(exposures).toEqual([])
  })

  it('drops a PROJECT skill bound to a different workspace identity', () => {
    const exposures = collectRecallExposures({
      intents: [intent({
        sessionLifecycleKey: 'sl-bound',
        recall: { state: 'COMPLETE', candidates: [
          { bodyDigest: 'a'.repeat(64), summary: { name: 'project-skill', scope: 'PROJECT' } },
        ] },
      })],
      projectBindings: new Map([[
        'sl-bound',
        { workspaceId: 'ws-1', scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\other') },
      ]]),
      workspace: {
        workspaceId: 'ws-1',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\workspace'),
      },
    })
    expect(exposures).toEqual([])
  })

  it('keeps USER skills regardless of the resolved workspace', () => {
    const exposures = collectRecallExposures({
      intents: [intent({ recall: { state: 'COMPLETE', candidates: [
        { bodyDigest: 'a'.repeat(64), summary: { name: 'user-skill', scope: 'USER' } },
      ] } })],
      projectBindings: new Map(),
      workspace: {
        workspaceId: 'ws-9',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\unrelated'),
      },
    })
    expect(exposures.map(item => item.skillName)).toEqual(['user-skill'])
  })
})

describe('recall telemetry RPC', () => {
  const userScope = { kind: 'USER_ONLY' as const, generation: 1 }

  function handlerFor(
    domain: ReturnType<typeof createMemoryRun2skillV2Domain> | undefined,
    resolveWorkspace: (workspaceId: string) => Promise<{ workspaceId: string; canonicalPath: string } | undefined>,
    fallback?: Parameters<typeof createRecallTelemetryRpcHandler>[2],
  ) {
    return createRecallTelemetryRpcHandler(
      () => domain,
      resolveWorkspace,
      fallback,
      () => new Date(NOW).toISOString(),
    )
  }

  it('answers with an empty list on a fresh domain', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const result = await handlerFor(domain, async () => undefined)(
      'recall-telemetry/list',
      { apiVersion: 1, currentScope: userScope },
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ apiVersion: 1, windowDays: 30, items: [] })
  })

  it('returns a visibility revision the caller can pin', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const handler = handlerFor(domain, async () => undefined)
    const first = await handler(
      'recall-telemetry/list',
      { apiVersion: 1, currentScope: userScope },
      new AbortController().signal,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const revision = (first.value as { visibilityRevision: string }).visibilityRevision
    const second = await handler(
      'recall-telemetry/list',
      { apiVersion: 1, currentScope: userScope, expectedVisibilityRevision: revision },
      new AbortController().signal,
    )
    expect(second.ok).toBe(true)
  })

  it('rejects a stale visibility revision', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const result = await handlerFor(domain, async () => undefined)(
      'recall-telemetry/list',
      {
        apiVersion: 1,
        currentScope: userScope,
        expectedVisibilityRevision: `visibility_${'0'.repeat(64)}`,
      },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'visibility-stale' } })
  })

  it('reports unavailable when the v2 domain is not open yet', async () => {
    const result = await handlerFor(undefined, async () => undefined)(
      'recall-telemetry/list',
      { apiVersion: 1, currentScope: userScope },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('reports scope-unavailable when the current workspace cannot be resolved', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const result = await handlerFor(domain, async () => undefined)(
      'recall-telemetry/list',
      { apiVersion: 1, currentScope: { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'gone' } },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'scope-unavailable' } })
  })

  it('rejects a malformed request', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const result = await handlerFor(domain, async () => undefined)(
      'recall-telemetry/list',
      { apiVersion: 2, currentScope: userScope },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('falls back to the next handler for other endpoints', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const result = await handlerFor(domain, async () => undefined, async endpoint => (
      { ok: true, value: { handled: endpoint } } as never
    ))('some-other/list', {}, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, value: { handled: 'some-other/list' } })
  })
})
