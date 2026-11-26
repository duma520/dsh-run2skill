import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import { analyzeCheapTriggerV1 } from '../../domain/observe/trigger.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  RUN2SKILL_V2_LIMITS,
  TurnObservationV2Schema,
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
  selectBoundedEvidenceRefsV2,
  type TurnObservationV2,
} from '../../domain/v2/index.js'
import type { WorkspaceBindingPort } from '../../application/capture/turn-capture-processor.js'
import { buildTurnObservation } from './observation.js'
import type { DshSessionEvent, DshSessionHeader } from './types.js'

const MAX_ASSISTANT_SUMMARY_BYTES = 4 * 1024
const MAX_TOOL_SUMMARIES = 32
const TRUNCATION_MARKER = '\n…\n'
const SUPPORTED_TURN_EVENT_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'agent/inbox/spliced',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  // Host system surface and upload receipts are not direct user evidence.
  'system/message',
  'session-log-deepseek/delivery-accepted',
  'job/registered', // Host bookkeeping; tool results remain the execution evidence.
  'job/settled',
  'team/mode', // Session setting; it supplies no turn evidence.
  'model/selection', // Only request/header supplies the route actually used.
  'assistant/chunk',
  'assistant/attempt',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'session/end-seed',
])

// DSH 0.2.3 added event types this plugin never learned to read. They are *known*
// to be presentation, host bookkeeping or transport detail, so they cannot carry
// the evidence a turn observation needs. Listing them explicitly keeps the
// original contract intact: a genuinely unknown type still fails closed, and only
// these audited names may pass without contributing evidence. Each entry records
// why it cannot change the learning verdict.
const NO_EVIDENCE_TURN_EVENT_TYPES = new Set([
  // Subagent routing/policy plumbing. Subagent turns are CHILD sessions and are
  // skipped before projection, so their policy events carry no root evidence.
  'subagent/model-selection-policy',
  'subagent/catalog',
  // A working tree diff is a side effect of tool calls; tool/call and tool/result
  // already record what ran, so the diff itself adds no user intent.
  'workspace/changes',
  // Developer-supplied system prompt text: host configuration, not user input.
  'developer/message',
  // Retry bookkeeping: the retried attempt is replayed as its own
  // assistant/attempt plus tool events, so the retry markers are duplicates.
  'llm/retry',
  'llm/retry-started',
  // Compaction changes what the model sees, never what the user asked for.
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'compaction/summary',
  // PTC dispatch is the transport half of a tool call; tool/call and tool/result
  // are the authoritative pair.
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  // Hook invocation receipts: a hook's own effects surface as ordinary
  // tool/result or message events.
  'hook/invoked',
  'hook/result',
  // Web search request envelope; the assistant message and tool result carry the
  // content that actually reaches the transcript.
  'web/deepseek-search-llm-request',
  // Slash-command lifecycle. Any text a command produces arrives as a normal
  // user/message or assistant/message event.
  'command/run',
  'command/done',
  // Deliverable presentation is a UI action on artifacts already described by
  // assistant/tool events.
  'deliverables/presented',
  // Preset selection is host configuration; request/header carries the route that
  // was actually used.
  'agent-preset/selected',
  // Goal and team coordination are orchestration metadata. Their substantive
  // content is delivered as user/message or assistant/message events.
  'goal/change',
  'team/member',
  'team/task',
  'team/message/queued',
  'team/message/delivered',
])

/** True when the event is an audited no-evidence type this build knowingly skips. */
function isAuditedNoEvidenceEvent(type: string): boolean {
  return NO_EVIDENCE_TURN_EVENT_TYPES.has(type)
}

export type DshTurnObservationV2Result =
  | { readonly status: 'OBSERVED'; readonly observation: TurnObservationV2 }
  | { readonly status: 'CHILD' }
  | {
    readonly status: 'UNAVAILABLE'
    readonly healthCode:
      | 'ROOT_IDENTITY_UNAVAILABLE'
      | 'TURN_BOUNDARY_INCOMPLETE'
      | 'OBSERVATION_PROJECTION_UNAVAILABLE'
    readonly sessionId?: string
    readonly turnEndSeq?: number
  }

interface ProjectionPart<T> {
  readonly value: T
  readonly complete: boolean
}

export interface DshRequestRouteSnapshot {
  readonly requestHeaderSeq: number
  readonly complete: boolean
  readonly provider?: string
  readonly model?: string
}

interface ToolCallFact {
  readonly seq: number
  readonly step: number
  readonly callId: string
  readonly name: string
}

interface ToolResultFact {
  readonly seq: number
  readonly step: number
  readonly callId: string
  readonly failed: boolean
  readonly contentDigest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function isCoordinateIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break
    result += character
  }
  return result
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let result = ''
  for (const character of [...value].reverse()) {
    if (Buffer.byteLength(character + result, 'utf8') > maxBytes) break
    result = character + result
  }
  return result
}

function boundUtf8(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const available = Math.max(0, maxBytes - markerBytes)
  const headBytes = Math.ceil(available / 2)
  const tailBytes = Math.floor(available / 2)
  return {
    text: `${takeUtf8Prefix(value, headBytes)}${TRUNCATION_MARKER}${takeUtf8Suffix(value, tailBytes)}`,
    truncated: true,
  }
}

// A model answer normally arrives as several blocks: reasoning, text, and one or
// more tool calls. Treating any non-text block as malformed dropped the whole
// assistant projection, so the observation came out INCOMPLETE and the direct-user
// evidence was wiped with it: 245 of 265 historical Turns failed on this alone.
// Non-text blocks are simply not part of the summary - reasoning is internal and a
// tool call is carried by the tool projection - so they are skipped rather than
// rejected. A structurally broken message still fails closed.
function textContent(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const block of value) {
    if (!isRecord(block) || typeof block['type'] !== 'string') return undefined
    if (block['type'] !== 'text') continue
    if (typeof block['text'] !== 'string') return undefined
    result.push(block['text'])
  }
  return result
}

function projectDirectEvidence(
  messages: readonly { readonly messageSeq: number; readonly textBlocks: readonly string[] }[],
  hasText: boolean,
): ProjectionPart<{
  readonly evidence: TurnObservationV2['directUserEvidence']
  readonly explicitSaveRequested: boolean
}> {
  const candidates = messages.map(item => ({
    messageSeq: item.messageSeq,
    sourceKind: 'user' as const,
    text: item.textBlocks.join('\n'),
  }))
  const analysis = analyzeCheapTriggerV1(candidates)
  if (
    analysis.status === 'INCOMPLETE'
    || candidates.length > RUN2SKILL_V2_LIMITS.maxObservationEvidence
    || !hasText
  ) return { value: { evidence: [], explicitSaveRequested: false }, complete: false }

  try {
    const evidence = selectBoundedEvidenceRefsV2(candidates.map(candidate => {
      const processed = preprocessPersistentText(candidate.text)
      return {
        source: 'USER_DIRECT' as const,
        messageSeq: candidate.messageSeq,
        excerpt: processed.text,
        excerptDigest: sha256Utf8(processed.text),
        redactionKinds: processed.redactionKinds,
        truncated: false,
      }
    }), RUN2SKILL_V2_LIMITS.maxObservationEvidenceTotalBytes)
    return {
      value: {
        evidence,
        explicitSaveRequested: analysis.triggerHits.some(hit => hit.kind === 'EXPLICIT_SAVE'),
      },
      complete: true,
    }
  } catch {
    return { value: { evidence: [], explicitSaveRequested: false }, complete: false }
  }
}

function projectAssistantSummary(
  events: readonly DshSessionEvent[],
  turn: number,
): ProjectionPart<string> {
  let latest = ''
  let complete = true
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (!isRecord(event.data) || event.data['turn'] !== turn) {
      complete = false
      continue
    }
    const message = event.data['message']
    if (
      !isRecord(message)
      || message['role'] !== 'assistant'
      || !isRecord(message['source'])
    ) {
      complete = false
      continue
    }
    const texts = textContent(message['content'])
    if (texts === undefined) {
      complete = false
      continue
    }
    try {
      latest = boundUtf8(
        preprocessPersistentText(texts.join('\n')).text,
        MAX_ASSISTANT_SUMMARY_BYTES,
      ).text
    } catch {
      complete = false
      latest = ''
    }
  }
  return { value: latest, complete }
}

// A Direct User message that carries at least one text block can be evidence even
// when the same message also carries an image or an attachment: the text is what
// the User actually wrote, and dropping it because of a sibling image is what
// starved the batch detector of evidence (479 of 540 observations ended up with an
// empty directUserEvidence, and the detector then rejected every model answer as
// unbound). Content with no text block at all still fails closed: there is nothing
// to cite, and an empty evidence set must never be presented as complete.
function directUserContentHasText(events: readonly DshSessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'user/message' || !isRecord(event.data)) continue
    const source = event.data['source']
    if (!isRecord(source) || source['kind'] !== 'user') continue
    const content = event.data['content']
    if (!Array.isArray(content)) return false
    let hasText = false
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') hasText = true
    }
    if (!hasText) return false
  }
  return true
}

function hasUnsupportedRequiredEvent(events: readonly DshSessionEvent[]): boolean {
  return events.some(event => (
    event.type === 'working-directory/change'
      // Audited no-evidence types are allowed through; anything else unknown
      // still fails closed unless its own envelope says it is ignorable.
      || (!SUPPORTED_TURN_EVENT_TYPES.has(event.type)
        && !isAuditedNoEvidenceEvent(event.type)
        && event.ignorable !== true)
  ))
}

function parseToolCall(event: DshSessionEvent, turn: number): ToolCallFact | undefined {
  if (!isRecord(event.data) || event.data['turn'] !== turn || !isSafeCoordinate(event.data['step'])) return undefined
  const callId = event.data['callId']
  const name = event.data['name']
  if (!isCoordinateIdentity(callId) || !isIdentity(name) || typeof event.data['arguments'] !== 'string') return undefined
  return { seq: event.seq, step: event.data['step'], callId, name }
}

function parseToolResult(event: DshSessionEvent, turn: number): ToolResultFact | undefined {
  if (!isRecord(event.data) || event.data['turn'] !== turn || !isSafeCoordinate(event.data['step'])) return undefined
  const message = event.data['message']
  if (
    !isRecord(message)
    || !isRecord(message['source'])
    || message['source']['kind'] !== 'tool'
  ) return undefined
  const callId = message['source']['callId']
  if (!isCoordinateIdentity(callId)) return undefined
  let content: unknown
  let isError: unknown
  if (message['role'] === 'tool') {
    if (message['toolCallId'] !== callId || !Array.isArray(message['content'])) return undefined
    content = message['content']
    isError = message['isError']
  } else if (message['role'] === 'user') {
    const blocks = message['content']
    if (!Array.isArray(blocks) || blocks.length !== 1 || !isRecord(blocks[0])) return undefined
    const block = blocks[0]
    if (block['type'] !== 'tool-result' || block['toolCallId'] !== callId || !Array.isArray(block['content'])) return undefined
    content = block['content']
    isError = block['isError']
  } else return undefined
  if (isError !== undefined && typeof isError !== 'boolean') return undefined
  const error = event.data['error']
  if (
    error !== undefined
    && (!isRecord(error) || !isIdentity(error['name']) || !isIdentity(error['code']))
  ) return undefined
  try {
    return {
      seq: event.seq,
      step: event.data['step'],
      callId,
      failed: isError === true || error !== undefined,
      contentDigest: sha256Utf8(canonicalJson({
        content,
        isError: isError === true,
        error: error ?? null,
      })),
    }
  } catch {
    return undefined
  }
}

function projectToolSummaries(
  events: readonly DshSessionEvent[],
  turn: number,
): ProjectionPart<TurnObservationV2['toolOutcomeSummary']> {
  const calls = new Map<string, ToolCallFact>()
  const results = new Map<string, ToolResultFact>()
  let complete = true
  for (const event of events) {
    if (event.type === 'tool/call') {
      const call = parseToolCall(event, turn)
      if (call === undefined || calls.has(call.callId)) complete = false
      else calls.set(call.callId, call)
    } else if (event.type === 'tool/result') {
      const result = parseToolResult(event, turn)
      if (result === undefined || results.has(result.callId)) complete = false
      else results.set(result.callId, result)
    }
  }
  if (calls.size > MAX_TOOL_SUMMARIES) complete = false
  for (const [callId, result] of results) {
    const call = calls.get(callId)
    if (call === undefined || result.seq <= call.seq || result.step !== call.step) complete = false
  }
  const summaries = [...calls.values()]
    .sort((left, right) => left.seq - right.seq || left.callId.localeCompare(right.callId))
    .slice(0, MAX_TOOL_SUMMARIES)
    .map(call => {
      const result = results.get(call.callId)
      const matched = result !== undefined && result.seq > call.seq && result.step === call.step
        ? result
        : undefined
      return {
        toolName: call.name,
        outcome: matched === undefined ? 'OUTCOME_UNKNOWN' : matched.failed ? 'FAILED' : 'SUCCEEDED',
        contentDigest: matched?.contentDigest ?? sha256Utf8(canonicalJson({ callId: call.callId, result: 'MISSING' })),
      }
    })
  if (summaries.some(summary => summary.outcome === 'OUTCOME_UNKNOWN')) complete = false
  return { value: summaries, complete }
}

export function projectDshRequestRouteV2(event: DshSessionEvent): DshRequestRouteSnapshot | undefined {
  if (event.type !== 'request/header') return undefined
  if (!isRecord(event.data)) return { requestHeaderSeq: event.seq, complete: false }
  const header = event.data['header']
  const config = isRecord(header) ? header['config'] : undefined
  const provider = isRecord(config) ? config['provider'] : undefined
  const model = isRecord(config) ? config['model'] : undefined
  if (!isIdentity(provider) || !isIdentity(model)) {
    return { requestHeaderSeq: event.seq, complete: false }
  }
  return { requestHeaderSeq: event.seq, provider, model, complete: true }
}

export function advanceDshRequestRouteV2(
  inheritedRoute: DshRequestRouteSnapshot | undefined,
  events: readonly DshSessionEvent[],
  throughSeq: number,
): DshRequestRouteSnapshot | undefined {
  let latest = inheritedRoute?.requestHeaderSeq !== undefined
    && inheritedRoute.requestHeaderSeq <= throughSeq
    ? inheritedRoute
    : undefined
  for (const event of events) {
    if (event.seq > throughSeq) continue
    const candidate = projectDshRequestRouteV2(event)
    if (
      candidate !== undefined
      && (latest === undefined || candidate.requestHeaderSeq >= latest.requestHeaderSeq)
    ) latest = candidate
  }
  return latest
}

function projectRoute(
  events: readonly DshSessionEvent[],
  turnEndSeq: number,
  inheritedRoute?: DshRequestRouteSnapshot,
): ProjectionPart<TurnObservationV2['routeObservation']> {
  const latest = advanceDshRequestRouteV2(inheritedRoute, events, turnEndSeq)
  if (
    latest?.complete !== true
    || latest.provider === undefined
    || latest.model === undefined
  ) return { value: { complete: false }, complete: false }
  return { value: { provider: latest.provider, model: latest.model, complete: true }, complete: true }
}

async function projectScope(
  cwd: string | undefined,
  workspace: WorkspaceBindingPort,
): Promise<TurnObservationV2['scopeBinding']> {
  if (cwd === undefined) return { status: 'UNRESOLVED', reason: 'NO_CWD' }
  try {
    const resolution = await workspace.resolve(cwd)
    if (resolution.status !== 'BOUND') {
      return {
        status: 'UNRESOLVED',
        reason: resolution.status === 'UNREGISTERED' ? 'UNREGISTERED' : 'UNAVAILABLE',
      }
    }
    if (!isIdentity(resolution.workspaceId)) return { status: 'UNRESOLVED', reason: 'UNAVAILABLE' }
    return {
      status: 'PROJECT',
      workspaceId: resolution.workspaceId,
      scopeIdentityDigest: deriveProjectScopeIdentityDigest(resolution.canonicalPath),
    }
  } catch {
    return { status: 'UNRESOLVED', reason: 'UNAVAILABLE' }
  }
}

function unavailable(
  header: DshSessionHeader,
  turnEndSeq: number,
): Extract<DshTurnObservationV2Result, { status: 'UNAVAILABLE' }> {
  return {
    status: 'UNAVAILABLE',
    healthCode: 'OBSERVATION_PROJECTION_UNAVAILABLE',
    ...(typeof header.id === 'string' && header.id.length > 0 ? { sessionId: header.id } : {}),
    ...(isSafeCoordinate(turnEndSeq) ? { turnEndSeq } : {}),
  }
}

/**
 * Projects one durable DSH root Turn into the bounded v2 observation record.
 * This adapter is deterministic and model-free; it never reads a Skill Catalog.
 */
export async function projectDshTurnObservationV2(
  header: DshSessionHeader,
  sessionEvents: readonly DshSessionEvent[],
  turnEndSeq: number,
  workspace: WorkspaceBindingPort,
  recovery?: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
  inheritedRoute?: DshRequestRouteSnapshot,
): Promise<DshTurnObservationV2Result> {
  const base = buildTurnObservation(header, sessionEvents, turnEndSeq)
  if (base.status !== 'OBSERVED') return base
  const observed = base.observation
  const observedAt = new Date(observed.turnEndTime)
  if (!Number.isFinite(observedAt.getTime())) return unavailable(header, turnEndSeq)
  const observedPrefix = sessionEvents.filter(event => event.seq <= observed.turnEndSeq)
  if (hasUnsupportedRequiredEvent(observedPrefix)) return unavailable(header, turnEndSeq)
  const turnEvents = observedPrefix.filter(event => (
    event.seq >= observed.turnStartSeq && event.seq <= observed.turnEndSeq
  ))
  const direct = projectDirectEvidence(
    observed.directUserMessages,
    directUserContentHasText(turnEvents),
  )
  const assistant = projectAssistantSummary(turnEvents, observed.turn)
  const tools = projectToolSummaries(turnEvents, observed.turn)
  const route = projectRoute(sessionEvents, observed.turnEndSeq, inheritedRoute)
  const scopeBinding = await projectScope(header.cwd, workspace)
  const complete = direct.complete && assistant.complete && tools.complete && route.complete
  const directUserEvidence = complete ? direct.value.evidence : []
  const evidenceDigest = sha256Utf8(canonicalJson(directUserEvidence))
  const contentFacts = {
    outcomeKind: observed.turnOutcomeKind,
    assistantOutcomeSummary: assistant.value,
    toolOutcomeSummary: tools.value,
    routeObservation: route.value,
    completeness: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const,
    explicitSaveRequested: complete && direct.value.explicitSaveRequested,
    scopeBinding,
    evidenceDigest,
  }
  try {
    return {
      status: 'OBSERVED',
      observation: TurnObservationV2Schema.parse({
        schemaVersion: 1,
        revision: 1,
        observationId: deriveTurnObservationIdV2(observed),
        sessionLifecycleKey: observed.sessionLifecycleKey,
        turn: observed.turn,
        turnStartSeq: observed.turnStartSeq,
        turnEndSeq: observed.turnEndSeq,
        turnInstanceDigest: observed.turnInstanceDigest,
        observedAt: observedAt.toISOString(),
        ...contentFacts,
        directUserEvidence,
        contentDigest: deriveTurnObservationContentDigestV2(contentFacts),
        ...(recovery === undefined ? {} : { sessionRecovery: recovery }),
      }),
    }
  } catch {
    return unavailable(header, turnEndSeq)
  }
}
