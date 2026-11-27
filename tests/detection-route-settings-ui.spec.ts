// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DetectionRouteSection,
  type DetectionRoutesCall,
  type ModelCatalogCall,
  type SaveDetectionRoutesCall,
} from '../src/client/detection-route-settings.js'

afterEach(cleanup)

interface Rendered {
  readonly saved: ReturnType<typeof vi.fn>
  readonly rows: () => { provider: string; model: string }[]
}

/**
 * 渲染优先次序区块。
 *
 * 负载一律走 `{ ok, value }` carrier —— 宿主真实就是这么回的，其它区块也都按这个
 * 形状解析。用真形状当夹具，测的才是宿主真发的东西，而不是我们自己臆想的形状。
 */
function harness(options: {
  readonly providers?: readonly unknown[]
  readonly stored?: readonly { provider: string; model: string }[]
  readonly readError?: string
  readonly saveError?: string
} = {}): Rendered {
  const providers = options.providers ?? []
  const callCatalog: ModelCatalogCall = async () => ({
    ok: true,
    value: { apiVersion: 1, catalogAvailable: providers.length > 0, providers },
  })
  const callRoutes: DetectionRoutesCall = async () => (options.readError === undefined
    ? { ok: true, value: { apiVersion: 1, candidates: options.stored ?? [] } }
    : { ok: false, error: { code: 'unavailable', message: options.readError, details: {} } })
  const saved = vi.fn(async (payload: { candidates: readonly { provider: string; model: string }[] }) => {
    if (options.saveError !== undefined) {
      return { ok: false, error: { code: 'unavailable', message: options.saveError, details: {} } }
    }
    return { ok: true, value: { apiVersion: 1, candidates: payload.candidates } }
  })
  const saveRoutes: SaveDetectionRoutesCall = async payload => saved(payload)
  render(createElement(DetectionRouteSection, { callCatalog, callRoutes, saveRoutes }))
  return { saved, rows: () => (saved.mock.calls.at(-1)?.[0]?.candidates ?? []) as { provider: string; model: string }[] }
}

const twoProviders = [
  { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
  { id: 'doubao', name: 'Doubao', models: [{ id: 'person-deepseek', name: 'Person DeepSeek' }] },
]

it('shows the stored order back to the user with its rank', async () => {
  harness({
    providers: twoProviders,
    stored: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'doubao', model: 'person-deepseek' },
    ],
  })
  await waitFor(() => expect(screen.getByText(/已排 2 个候选/)).toBeTruthy())
  expect((screen.getByLabelText('第 1 个 provider') as HTMLSelectElement).value).toBe('workbuddy')
  expect((screen.getByLabelText('第 2 个 provider') as HTMLSelectElement).value).toBe('doubao')
  expect((screen.getByLabelText('第 1 个模型') as HTMLSelectElement).value).toBe('deepseek-v4.1-flash')
})

it('says what happens when nothing is configured yet', async () => {
  harness()
  await waitFor(() => expect(screen.getByText(/当前没有任何候选/)).toBeTruthy())
  expect(screen.getByText(/记不到就把这一条标成待处理/)).toBeTruthy()
})

it('adds an empty row and saves it as an incomplete row the host can normalise', async () => {
  const { rows } = harness({ providers: twoProviders })
  await waitFor(() => expect(screen.getByText('新增一个候选')).toBeTruthy())
  fireEvent.click(screen.getByText('新增一个候选'))
  await waitFor(() => expect(rows().length).toBe(1))
  // 空行照实送到宿主；宿主那边会跳过半截行，界面不该自己先删掉用户正在填的行。
  expect(rows()[0]).toEqual({ provider: '', model: '' })
})

it('moves a row up and persists the new order', async () => {
  const { rows } = harness({
    providers: twoProviders,
    stored: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'doubao', model: 'person-deepseek' },
    ],
  })
  await waitFor(() => expect(screen.getByLabelText('把第 2 个往上移')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('把第 2 个往上移'))
  await waitFor(() => expect(rows().map(row => row.provider)).toEqual(['doubao', 'workbuddy']))
})

it('disables moving past either end and deleting is always available', async () => {
  harness({
    providers: twoProviders,
    stored: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'doubao', model: 'person-deepseek' },
    ],
  })
  await waitFor(() => expect(screen.getByLabelText('把第 1 个往上移')).toBeTruthy())
  expect((screen.getByLabelText('把第 1 个往上移') as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('把第 2 个往下移') as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('删除第 1 个') as HTMLButtonElement).disabled).toBe(false)
})

it('removes a row and persists the shorter list', async () => {
  const { rows } = harness({
    providers: twoProviders,
    stored: [
      { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      { provider: 'doubao', model: 'person-deepseek' },
    ],
  })
  await waitFor(() => expect(screen.getByLabelText('删除第 1 个')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('删除第 1 个'))
  await waitFor(() => expect(rows()).toEqual([{ provider: 'doubao', model: 'person-deepseek' }]))
})

it('clears the model when the provider changes so a cross-provider pair cannot be saved', async () => {
  const { rows } = harness({
    providers: twoProviders,
    stored: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }],
  })
  await waitFor(() => expect(screen.getByLabelText('第 1 个 provider')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('第 1 个 provider'), { target: { value: 'doubao' } })
  await waitFor(() => expect(rows()).toEqual([{ provider: 'doubao', model: '' }]))
})

it('offers only that provider\'s models once a provider is chosen', async () => {
  harness({
    providers: twoProviders,
    stored: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }],
  })
  await waitFor(() => expect(screen.getByLabelText('第 1 个模型')).toBeTruthy())
  const model = screen.getByLabelText('第 1 个模型') as HTMLSelectElement
  expect([...model.options].map(option => option.value)).toEqual(['', 'deepseek-v4.1-flash'])
})

it('explains an empty provider instead of showing an unfillable dropdown', async () => {
  harness({
    providers: [{ id: 'broken', models: [], unavailable: true }],
    stored: [{ provider: 'broken', model: 'stale-id' }],
  })
  await waitFor(() => expect(screen.getByLabelText('第 1 个模型')).toBeTruthy())
  const model = screen.getByLabelText('第 1 个模型') as HTMLSelectElement
  expect(model.disabled).toBe(true)
  expect(model.options[0]!.textContent).toBe('该 provider 没有可用模型')
})

it('falls back to free text when the host has no model catalog', async () => {
  const { rows } = harness({ providers: [], stored: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }] })
  await waitFor(() => expect(screen.getByText(/当前 DSH 版本不提供模型清单/)).toBeTruthy())
  const provider = screen.getByLabelText('第 1 个 provider') as HTMLInputElement
  expect(provider.tagName).toBe('INPUT')
  fireEvent.change(provider, { target: { value: '  doubao  ' } })
  fireEvent.blur(provider)
  await waitFor(() => expect(rows()).toEqual([{ provider: 'doubao', model: '' }]))
})

it('surfaces the host\'s reason when saving is rejected, instead of silently reverting', async () => {
  harness({
    providers: twoProviders,
    stored: [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }],
    saveError: 'route preference storage unavailable',
  })
  await waitFor(() => expect(screen.getByText('新增一个候选')).toBeTruthy())
  fireEvent.click(screen.getByText('新增一个候选'))
  await waitFor(() => expect(screen.getByText(/未保存：route preference storage unavailable/)).toBeTruthy())
})

it('never treats a failed read as "user has no preference"', async () => {
  harness({ readError: 'detection routes storage unavailable' })
  await waitFor(() => expect(screen.getByText(/未保存：detection routes storage unavailable/)).toBeTruthy())
})

it('stops offering new rows at the host limit', async () => {
  const eight = Array.from({ length: 8 }, (_value, index) => ({ provider: 'workbuddy', model: `m${index}` }))
  harness({ providers: twoProviders, stored: eight })
  await waitFor(() => expect(screen.getByText(/最多 8 个，已排满/)).toBeTruthy())
  expect((screen.getByText(/最多 8 个，已排满/) as HTMLButtonElement).disabled).toBe(true)
})
