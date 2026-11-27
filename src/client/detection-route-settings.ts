import {
  createElement,
  useEffect,
  useState,
  type ReactElement,
} from 'react'

/**
 * 语义检测的模型优先次序。
 *
 * 这里不再走 configForms，也不再是「主选 + 兜底」两段式。原因有两条，都是实测出来的：
 *
 * 1. 两段式表达不了「第三个」。DSH 里一台设备往往接通了好几个 provider，
 *    用户想把 A 排第一、B 第二、C 第三，两段式只能装两个。
 * 2. 走 configForms 的那条写入链路会被宿主拒绝并且只回一个 false，
 *    客户端拿不到原因，界面上表现为「选了但值弹回『不指定』」。
 *    现在改成走插件自己的 RPC 与存储域，失败时宿主会把原因带回来，界面照实显示。
 *
 * 读与写都按「整体替换一份有序列表」处理：宿主保留用户排的顺序，
 * 丢掉 provider 或 model 还空着的半截行，并对重复项去重。
 */

export type ModelCatalogCall = (
  payload: { readonly apiVersion: 1 },
  signal: AbortSignal,
) => Promise<unknown>

export type DetectionRoutesCall = (
  payload: { readonly apiVersion: 1 },
  signal: AbortSignal,
) => Promise<unknown>

export type SaveDetectionRoutesCall = (
  payload: {
    readonly apiVersion: 1
    readonly candidates: readonly { readonly provider: string; readonly model: string }[]
  },
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

interface RouteCandidate {
  readonly provider: string
  readonly model: string
}

interface RouteReadResult {
  readonly ok: boolean
  readonly candidates: readonly RouteCandidate[]
  readonly message?: string
}

const CATALOG_TIMEOUT_MS = 15_000

/** 与宿主侧 MAX_ROUTE_CANDIDATES 保持一致；超出的行直接不让加。 */
const MAX_ROUTE_CANDIDATES = 8

/**
 * Narrow the untrusted remote payload without throwing on any shape.
 *
 * Everything here arrives from the host, but a stale host or a future schema
 * must degrade to "no picker" rather than break the whole settings page.
 */
function readCatalog(value: unknown): CatalogState {
  if (typeof value !== 'object' || value === null) return { phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] }
  // Every run2skill endpoint answers with the { ok, value } carrier, the same
  // shape the other sections already parse. Reading the payload directly here
  // meant the picker silently degraded to free-text fields on every host,
  // because `apiVersion` never appeared at the top level.
  const envelope = value as Record<string, unknown>
  if (envelope['ok'] !== true) return { phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] }
  const payload = envelope['value']
  if (typeof payload !== 'object' || payload === null) {
    return { phase: 'UNAVAILABLE', catalogAvailable: false, providers: [] }
  }
  const record = payload as Record<string, unknown>
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

/**
 * Read a candidate list out of the RPC carrier.
 *
 * A failed call is *not* an empty list. `carrierFailure` on the host turns a
 * thrown error into `{ ok: false, error }`, and treating that as "user has no
 * preference" would silently wipe the very thing they are trying to set — so
 * the failure branch carries the host's message through to the screen.
 */
function readRoutes(value: unknown): RouteReadResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, candidates: [], message: '宿主没有返回可用的回执。' }
  }
  const envelope = value as Record<string, unknown>
  if (envelope['ok'] !== true) {
    const error = envelope['error']
    const raw = typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['message']
      : undefined
    return {
      ok: false,
      candidates: [],
      message: typeof raw === 'string' && raw.length > 0 ? raw : '宿主拒绝了这次请求。',
    }
  }
  const payload = envelope['value']
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, candidates: [], message: '回执里没有候选列表。' }
  }
  const record = payload as Record<string, unknown>
  if (record['apiVersion'] !== 1) {
    return { ok: false, candidates: [], message: '回执版本不认识，可能是插件与宿主版本不匹配。' }
  }
  const candidates: RouteCandidate[] = []
  for (const raw of Array.isArray(record['candidates']) ? record['candidates'] : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const provider = typeof entry['provider'] === 'string' ? entry['provider'] : ''
    const model = typeof entry['model'] === 'string' ? entry['model'] : ''
    if (provider.length === 0 || model.length === 0) continue
    candidates.push({ provider, model })
  }
  return { ok: true, candidates }
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

function providerLabelOf(provider: CatalogProvider): string {
  return provider.name === undefined ? provider.id : `${provider.name}（${provider.id}）`
}

function modelsOf(catalog: CatalogState, provider: string): readonly { readonly id: string; readonly name?: string }[] {
  return catalog.providers.find(item => item.id === provider)?.models ?? []
}

/** 用 provider + model 拼一个稳定 key，避免行错位。 */
function rowKey(row: RouteCandidate, index: number): string {
  return `${index}\u0000${row.provider}\u0000${row.model}`
}

export function DetectionRouteSection(props: {
  readonly callCatalog?: ModelCatalogCall
  readonly callRoutes?: DetectionRoutesCall
  readonly saveRoutes?: SaveDetectionRoutesCall
  readonly active?: boolean
}): ReactElement {
  const active = props.active !== false
  const catalog = useCatalog(props.callCatalog, active)
  const [rows, setRows] = useState<readonly RouteCandidate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // 读一次当前顺序。改完值不重读：宿主的规整（去空行、去重）在界面上会表现为
  // 「正在填的那一行突然消失」，比顺序差一点点更烦人。
  useEffect(() => {
    if (props.callRoutes === undefined || !active) return
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const value = await props.callRoutes!({ apiVersion: 1 }, controller.signal)
        if (cancelled) return
        const result = readRoutes(value)
        setRows(result.candidates)
        setError(result.ok ? undefined : result.message)
      } catch {
        if (!cancelled) setError('读不到当前的优先次序，下面的列表可能是空的。')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [props.callRoutes, active])

  const selectable = catalog.phase === 'READY' && catalog.catalogAvailable
  const canEdit = props.saveRoutes !== undefined && loaded && !saving

  /**
   * 把整份列表交给宿主。
   *
   * 乐观更新：先把界面上的行换掉再发请求，点「上移」立刻有反馈。
   * 失败时不回滚——回滚会让人以为自己点错了，不如把宿主的原话显示出来。
   */
  const commit = async (next: readonly RouteCandidate[]): Promise<void> => {
    setRows(next)
    if (props.saveRoutes === undefined) {
      setError('当前宿主没有提供保存优先次序的接口。')
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const value = await props.saveRoutes(
        { apiVersion: 1, candidates: next.map(row => ({ provider: row.provider, model: row.model })) },
        new AbortController().signal,
      )
      const result = readRoutes(value)
      if (!result.ok) setError(result.message ?? '保存失败，原因未知。')
    } catch {
      setError('保存时出错，改动可能没有落盘。')
    } finally {
      setSaving(false)
    }
  }

  const editRow = (index: number, patch: Partial<RouteCandidate>): void => {
    const current = rows[index]
    if (current === undefined) return
    const changedProvider = patch.provider !== undefined && patch.provider !== current.provider
    const next: RouteCandidate = {
      provider: patch.provider ?? current.provider,
      // 换 provider 时清掉 model：旧 model 属于旧 provider，留着只会在检测时解析失败。
      model: changedProvider ? '' : patch.model ?? current.model,
    }
    void commit(rows.map((row, at) => (at === index ? next : row)))
  }

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    const moved = next[index]
    if (moved === undefined) return
    next.splice(index, 1)
    next.splice(target, 0, moved)
    void commit(next)
  }

  const remove = (index: number): void => {
    void commit(rows.filter((_row, at) => at !== index))
  }

  const append = (): void => {
    void commit([...rows, { provider: '', model: '' }])
  }

  const status = catalog.phase === 'LOADING'
    ? '正在读取这台设备可用的模型…'
    : catalog.phase === 'UNAVAILABLE'
      ? '读不到模型清单，下面用文本框手动填写 provider 与 model 的 id。'
      : catalog.catalogAvailable
        ? '下面是这台设备已经接通的 provider 与模型。'
        : '当前 DSH 版本不提供模型清单，下面用文本框手动填写 provider 与 model 的 id。'

  const completeCount = rows.filter(row => row.provider.length > 0 && row.model.length > 0).length

  return createElement('section', { 'data-run2skill-detection-route': true },
    createElement('p', null,
      '语义检测要发起一次模型请求，所以必须知道用哪个模型。'
      + '正常情况下它跟着这一轮对话实际用过的模型走；但有相当多的轮次，DSH 没有记下"这一轮用了哪个模型"，'
      + '那种轮次以前会直接判定失败、再也不重试——这也是「从来学不会任何 Skill」的主要原因之一。'),
    createElement('p', null,
      '下面按顺序排好你要用的模型：检测时从上往下逐个试，第一个能用的就赢了。'
      + '排在最上面的相当于「主选」，后面的是「主选解析不出来时依次再试」。'
      + '一行都不填也可以，只是没路由的轮次会继续标成待处理。'),
    createElement('p', null, status),
    createElement('ul', { 'data-run2skill-route-list': true },
      ...rows.map((row, index) => createElement('li', { key: rowKey(row, index) },
        createElement('span', { 'data-run2skill-route-rank': true }, `${index + 1}`),
        selectable
          ? createElement('select', {
            'aria-label': `第 ${index + 1} 个 provider`,
            value: row.provider,
            disabled: !canEdit,
            onChange: (event: { currentTarget: { value: string } }) => {
              editRow(index, { provider: event.currentTarget.value })
            },
          },
          createElement('option', { value: '' }, '选择 provider'),
          ...catalog.providers.map(provider => createElement('option', {
            key: provider.id,
            value: provider.id,
          }, providerLabelOf(provider))))
          : createElement('input', {
            type: 'text',
            'aria-label': `第 ${index + 1} 个 provider`,
            defaultValue: row.provider,
            placeholder: 'provider id',
            maxLength: 128,
            disabled: !canEdit,
            onBlur: (event: { currentTarget: { value: string } }) => {
              const value = event.currentTarget.value.trim()
              if (value !== row.provider) editRow(index, { provider: value })
            },
          }),
        selectable
          ? createElement('select', {
            'aria-label': `第 ${index + 1} 个模型`,
            value: row.model,
            disabled: !canEdit || row.provider.length === 0 || modelsOf(catalog, row.provider).length === 0,
            onChange: (event: { currentTarget: { value: string } }) => {
              editRow(index, { model: event.currentTarget.value })
            },
          },
          createElement('option', { value: '' }, row.provider.length === 0
            ? '先选 provider'
            : modelsOf(catalog, row.provider).length === 0 ? '该 provider 没有可用模型' : '选择模型'),
          ...modelsOf(catalog, row.provider).map(model => createElement('option', {
            key: model.id,
            value: model.id,
          }, model.name === undefined ? model.id : `${model.name}（${model.id}）`)))
          : createElement('input', {
            type: 'text',
            'aria-label': `第 ${index + 1} 个模型`,
            defaultValue: row.model,
            placeholder: row.provider.length === 0 ? '先选 provider' : 'model id',
            maxLength: 256,
            disabled: !canEdit || row.provider.length === 0,
            onBlur: (event: { currentTarget: { value: string } }) => {
              const value = event.currentTarget.value.trim()
              if (value !== row.model) editRow(index, { model: value })
            },
          }),
        createElement('button', {
          type: 'button',
          'aria-label': `把第 ${index + 1} 个往上移`,
          disabled: !canEdit || index === 0,
          onClick: () => { move(index, -1) },
        }, '上移'),
        createElement('button', {
          type: 'button',
          'aria-label': `把第 ${index + 1} 个往下移`,
          disabled: !canEdit || index === rows.length - 1,
          onClick: () => { move(index, 1) },
        }, '下移'),
        createElement('button', {
          type: 'button',
          'aria-label': `删除第 ${index + 1} 个`,
          disabled: !canEdit,
          onClick: () => { remove(index) },
        }, '删除'),
      )),
    ),
    createElement('button', {
      type: 'button',
      'data-run2skill-route-add': true,
      disabled: !canEdit || rows.length >= MAX_ROUTE_CANDIDATES,
      onClick: append,
    }, rows.length >= MAX_ROUTE_CANDIDATES
      ? `最多 ${MAX_ROUTE_CANDIDATES} 个，已排满`
      : '新增一个候选'),
    createElement('p', null, completeCount === 0
      ? '当前没有任何候选。检测只会使用这一轮对话自己记录的模型；记不到就把这一条标成待处理。'
      : `已排 ${completeCount} 个候选，按上面的顺序依次尝试。`
        + '如果某一轮本身带着可用的模型信息，仍然优先用那一轮的，不会被这里覆盖。'),
    createElement('p', null,
      '由候选模型跑出来的批次会带上 fallback 标记，方便以后核对：'
      + '这一条不是用会话原本的模型整理的。'),
    saving ? createElement('p', { role: 'status' }, '正在保存…') : null,
    error === undefined ? null : createElement('p', { role: 'status', 'data-run2skill-route-error': true }, `未保存：${error}`),
  )
}
