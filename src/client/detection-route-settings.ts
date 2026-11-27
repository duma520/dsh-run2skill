import {
  createElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { RetrievalSettings } from '../domain/retrieval/settings.js'
import type { RetrievalSettingsController } from './retrieval-settings.js'

export type ModelCatalogCall = (
  payload: { readonly apiVersion: 1 },
  signal: AbortSignal,
) => Promise<unknown>

interface CatalogProvider {
  readonly id: string
  readonly name?: string
  readonly models: readonly { readonly id: string; readonly name?: string }[]
  readonly unavailable?: boolean
}

interface CatalogState {
  readonly phase: 'LOADING' | 'READY' | 'UNAVAILABLE'
  readonly catalogAvailable: boolean
  readonly providers: readonly CatalogProvider[]
}

const CATALOG_TIMEOUT_MS = 15_000

/**
 * Narrow the untrusted remote payload without throwing on any shape.
 *
 * Everything here arrives from the host, but a stale host or a future schema
 * must degrade to "no picker" rather than break the whole settings page.
 */
function readCatalog(value: unknown): CatalogState {
  if (typeof value !== 'object' || value === null) return { phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] }
  const record = value as Record<string, unknown>
  if (record['apiVersion'] !== 1) return { phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] }
  const catalogAvailable = record['catalogAvailable'] === true
  const providers: CatalogProvider[] = []
  for (const raw of Array.isArray(record['providers']) ? record['providers'] : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry['id'] !== 'string' || entry['id'].length === 0) continue
    const models: { id: string; name?: string }[] = []
    for (const rawModel of Array.isArray(entry['models']) ? entry['models'] : []) {
      if (typeof rawModel !== 'object' || rawModel === null) continue
      const model = rawModel as Record<string, unknown>
      if (typeof model['id'] !== 'string' || model['id'].length === 0) continue
      models.push({
        id: model['id'],
        ...(typeof model['name'] === 'string' ? { name: model['name'] } : {}),
      })
    }
    providers.push({
      id: entry['id'],
      ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}),
      models,
      ...(entry['unavailable'] === true ? { unavailable: true } : {}),
    })
  }
  return { phase: 'READY', catalogAvailable, providers }
}

function useCatalog(call: ModelCatalogCall | undefined, active: boolean): CatalogState {
  // No call means the host has no catalog seam at all (old host, or a caller
  // that did not pass one). Reported as "resolved, no catalog" rather than
  // LOADING, otherwise the section would sit on "正在读取…" forever.
  const [state, setState] = useState<CatalogState>(call === undefined || !active
    ? { phase: 'READY', catalogAvailable: false, providers: [] }
    : { phase: 'LOADING', catalogAvailable: false, providers: [] })
  useEffect(() => {
    if (call === undefined || !active) return
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, CATALOG_TIMEOUT_MS)
    let cancelled = false
    void (async () => {
      try {
        const value = await call({ apiVersion: 1 }, controller.signal)
        if (!cancelled) setState(readCatalog(value))
      } catch {
        if (!cancelled) setState({ phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] })
      } finally {
        clearTimeout(timer)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [call, active])
  return state
}

function oneRoute(
  controller: RetrievalSettingsController,
  settings: RetrievalSettings,
  catalog: CatalogState,
  disabled: boolean,
  providerKey: 'detectionProvider' | 'fallbackProvider',
  modelKey: 'detectionModel' | 'fallbackModel',
  providerLabel: string,
  modelLabel: string,
): ReactElement {
  const provider = settings[providerKey]
  const models = catalog.providers.find(item => item.id === provider)?.models ?? []
  const selectable = catalog.phase === 'READY' && catalog.catalogAvailable && !disabled
  return createElement('div', { key: providerKey },
    createElement('label', null,
      createElement('span', null, providerLabel),
      selectable
        ? createElement('select', {
          'aria-label': providerLabel,
          value: provider,
          onChange: (event: { currentTarget: { value: string } }) => {
            // Clearing the provider also clears the model: keeping a model id
            // from another provider would produce a pair that cannot resolve.
            // The two writes must be sequential — setField declines to run
            // while another save is in flight, so firing both at once would
            // silently drop the reset.
            const value = event.currentTarget.value
            void (async () => {
              await controller.setField(providerKey, value)
              await controller.setField(modelKey, '')
            })()
          },
        },
        createElement('option', { value: '' }, '不指定（跟随会话）'),
        ...catalog.providers.map(item => createElement('option', { key: item.id, value: item.id },
          item.name === undefined ? item.id : `${item.name}（${item.id}）`)),
        )
        : createElement('input', {
          type: 'text',
          'aria-label': providerLabel,
          defaultValue: provider,
          disabled: catalog.phase === 'LOADING' || disabled,
          spellCheck: false,
          maxLength: 128,
          placeholder: 'provider id',
          onBlur: (event: { currentTarget: { value: string } }) => {
            if (event.currentTarget.value.trim() !== provider) {
              void controller.setField(providerKey, event.currentTarget.value.trim())
            }
          },
        }),
    ),
    createElement('label', null,
      createElement('span', null, modelLabel),
      selectable && models.length > 0
        ? createElement('select', {
          'aria-label': modelLabel,
          value: settings[modelKey],
          onChange: (event: { currentTarget: { value: string } }) => {
            void controller.setField(modelKey, event.currentTarget.value)
          },
        },
        createElement('option', { value: '' }, '未选择'),
        ...models.map(model => createElement('option', { key: model.id, value: model.id },
          model.name === undefined ? model.id : `${model.name}（${model.id}）`)),
        )
        : createElement('input', {
          type: 'text',
          'aria-label': modelLabel,
          defaultValue: settings[modelKey],
          disabled: catalog.phase === 'LOADING' || disabled || provider.length === 0,
          spellCheck: false,
          maxLength: 256,
          placeholder: provider.length === 0 ? '先选 provider' : 'model id',
          onBlur: (event: { currentTarget: { value: string } }) => {
            if (event.currentTarget.value.trim() !== settings[modelKey]) {
              void controller.setField(modelKey, event.currentTarget.value.trim())
            }
          },
        }),
    ),
  )
}

/**
 * Pick the model semantic detection runs on when a Turn exposes no route.
 *
 * This is not an optimisation knob. `request/header` is the only event that
 * proves which route a Turn actually used, and DSH does not log it on every
 * Turn, so those Turns have no observable route at all. Before this section
 * existed, such a batch was pinned to `ROUTE_UNAVAILABLE` and never retried,
 * which is why nothing was ever learned. Pinning a model here turns "waiting
 * for a route that will never appear" into "detection runs anyway".
 *
 * Both routes stay optional and empty means "no opinion", which keeps the
 * original strict behaviour available to anyone who wants it.
 */
export function DetectionRouteSection(props: {
  readonly controller: RetrievalSettingsController
  readonly callCatalog?: ModelCatalogCall
  readonly active?: boolean
}): ReactElement {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot)
  const disabled = state.status !== 'ready' || !state.writable || state.saving
  const settings = state.retrieval
  const catalog = useCatalog(props.callCatalog, props.active !== false)
  const pinned = settings.detectionProvider.length > 0 && settings.detectionModel.length > 0
  const hasFallback = settings.fallbackProvider.length > 0 && settings.fallbackModel.length > 0

  const status = catalog.phase === 'LOADING'
    ? '正在读取这台设备可用的模型…'
    : catalog.phase === 'UNAVAILABLE'
      ? '读不到模型清单，下面用文本框手动填写 provider 与 model 的 id。'
      : catalog.catalogAvailable
        ? '下面是这台设备已经接通的 provider 与模型。'
        : '当前 DSH 版本不提供模型清单，下面用文本框手动填写 provider 与 model 的 id。'

  return createElement('section', { 'data-run2skill-detection-route': true },
    createElement('p', null,
      '语义检测要发起一次模型请求，所以必须知道用哪个模型。'
      + '正常情况下它跟着这一轮对话实际用过的模型走；但有相当多的轮次，DSH 没有记下"这一轮用了哪个模型"，'
      + '那种轮次以前会直接判定失败、再也不重试——这也是「从来学不会任何 Skill」的主要原因之一。'
      + '在这里指定一个模型，那些轮次就能正常整理。'),
    createElement('p', null, status),
    oneRoute(props.controller, settings, catalog, disabled,
      'detectionProvider', 'detectionModel', '语义检测 provider', '语义检测模型'),
    createElement('p', null, pinned
      ? `已指定：检测时优先用 ${settings.detectionProvider} / ${settings.detectionModel}。`
        + '如果某一轮本身带着可用的模型信息，仍然优先用那一轮的，不会被这里覆盖。'
      : '未指定。检测只会使用这一轮对话自己记录的模型；记不到就把这一条标成待处理。'),
    createElement('h4', null, '兜底模型（可选）'),
    createElement('p', null,
      '上面那个模型解析不出来时（例如被下线、凭证失效），再试这一个。'
      + '两个都不填也可以，只是没路由的轮次会继续标成待处理。'),
    oneRoute(props.controller, settings, catalog, disabled,
      'fallbackProvider', 'fallbackModel', '兜底 provider', '兜底模型'),
    createElement('p', null, hasFallback
      ? `已指定兜底：${settings.fallbackProvider} / ${settings.fallbackModel}。`
        + '只有主选解析失败时才会用到它。'
      : '未指定兜底。主选解析失败时不会自动换别的模型。'),
    createElement('p', null,
      '用兜底模型跑出来的批次会带上 fallback 标记，方便以后核对：'
      + '这一条不是用会话原本的模型整理的。'),
    state.error ? createElement('p', { role: 'status' }, '设置未保存，请重试。') : null,
  )
}
