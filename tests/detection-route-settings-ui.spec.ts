// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RetrievalSettingsController } from '../src/client/retrieval-settings.js'
import { DetectionRouteSection, type ModelCatalogCall } from '../src/client/detection-route-settings.js'
import type { ClientSettingsScopeSnapshot } from '../src/client/retrieval-settings.js'
import type { RetrievalSettings } from '../src/domain/retrieval/settings.js'

afterEach(cleanup)

function harness(catalog?: ModelCatalogCall) {
  let snapshot: ClientSettingsScopeSnapshot<Partial<RetrievalSettings>> = {
    status: 'ready', value: {}, revision: 1, writable: true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (key: string, value: unknown) => {
    snapshot = { ...snapshot, value: { ...snapshot.value!, [key]: value }, revision: snapshot.revision! + 1 }
    for (const listener of listeners) listener()
    return true
  })
  const controller = new RetrievalSettingsController({
    getSnapshot: () => snapshot,
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
    set,
  })
  render(createElement(DetectionRouteSection, { controller, ...(catalog === undefined ? {} : { callCatalog: catalog }) }))
  return { controller, set, snapshot: () => snapshot }
}

const catalogWith = (providers: unknown): ModelCatalogCall => async () => ({
  apiVersion: 1, catalogAvailable: true, providers,
})

it('starts with no pinned route and says detection follows the Turn until one is chosen', async () => {
  const { controller } = harness()
  await waitFor(() => expect(screen.getByText(/读不到模型清单|当前 DSH 版本不提供模型清单/)).toBeTruthy())
  expect(screen.getByLabelText('语义检测 provider')).toBeTruthy()
  expect((screen.getByLabelText('语义检测 provider') as HTMLInputElement).value).toBe('')
  expect(screen.getByText(/未指定。检测只会使用这一轮对话自己记录的模型/)).toBeTruthy()
  expect(screen.getByText(/未指定兜底。主选解析失败时不会自动换别的模型/)).toBeTruthy()
  controller.dispose()
})

it('offers the installed providers as a select and clears the model when the provider changes', async () => {
  const { controller, set } = harness(catalogWith([
    { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
    { id: 'doubao', models: [{ id: 'person-deepseek-v4-1-flash-261017' }] },
  ]))

  await waitFor(() => expect(screen.getByText('下面是这台设备已经接通的 provider 与模型。')).toBeTruthy())
  const provider = screen.getByLabelText('语义检测 provider') as HTMLSelectElement
  expect(provider.tagName).toBe('SELECT')
  // "不指定（跟随会话）" must stay first so the strict behaviour remains reachable.
  expect(provider.options[0]!.value).toBe('')
  expect(provider.options[1]!.textContent).toBe('WorkBuddy（workbuddy）')

  fireEvent.change(provider, { target: { value: 'workbuddy' } })
  await waitFor(() => expect(set).toHaveBeenCalledWith('detectionProvider', 'workbuddy'))
  // Changing provider must also clear the model: a model id from another
  // provider is a pair that cannot resolve.
  expect(set).toHaveBeenCalledWith('detectionModel', '')
  controller.dispose()
})

it('falls back to free text when the host has no model catalog', async () => {
  const { controller, set } = harness(async () => ({ apiVersion: 1, catalogAvailable: false, providers: [] }))

  await waitFor(() => expect(screen.getByText(/当前 DSH 版本不提供模型清单/)).toBeTruthy())
  const provider = screen.getByLabelText('语义检测 provider') as HTMLInputElement
  expect(provider.tagName).toBe('INPUT')
  fireEvent.change(provider, { target: { value: '  workbuddy  ' } })
  fireEvent.blur(provider)
  await waitFor(() => expect(set).toHaveBeenCalledWith('detectionProvider', 'workbuddy'))
  controller.dispose()
})

it('keeps the model box closed until a provider is chosen', async () => {
  const { controller } = harness()
  await waitFor(() => expect(screen.getByLabelText('语义检测模型')).toBeTruthy())
  expect((screen.getByLabelText('语义检测模型') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText('语义检测模型') as HTMLInputElement).placeholder).toBe('先选 provider')
  controller.dispose()
})

it('describes the pinned and fallback routes once both halves are filled in', async () => {
  const { controller } = harness(catalogWith([
    { id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash' }] },
    { id: 'doubao', models: [{ id: 'person-deepseek-v4-1-flash-261017' }] },
  ]))
  await waitFor(() => expect(screen.getByText('下面是这台设备已经接通的 provider 与模型。')).toBeTruthy())

  fireEvent.change(screen.getByLabelText('语义检测 provider'), { target: { value: 'workbuddy' } })
  await waitFor(() => expect(screen.getByLabelText('语义检测模型')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('语义检测模型'), { target: { value: 'deepseek-v4.1-flash' } })
  await waitFor(() => expect(screen.getByText(/已指定：检测时优先用 workbuddy \/ deepseek-v4\.1-flash/)).toBeTruthy())
  // The observed route still wins when a Turn has one.
  expect(screen.getByText(/仍然优先用那一轮的/)).toBeTruthy()

  fireEvent.change(screen.getByLabelText('兜底 provider'), { target: { value: 'doubao' } })
  await waitFor(() => expect(screen.getByLabelText('兜底模型')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('兜底模型'), { target: { value: 'person-deepseek-v4-1-flash-261017' } })
  await waitFor(() => expect(screen.getByText(/已指定兜底：doubao \/ person-deepseek-v4-1-flash-261017/)).toBeTruthy())
  controller.dispose()
})

it('surfaces a host that cannot be reached as "type it yourself" rather than an empty picker', async () => {
  const { controller } = harness(async () => { throw new Error('offline') })
  await waitFor(() => expect(screen.getByText(/读不到模型清单/)).toBeTruthy())
  expect((screen.getByLabelText('语义检测 provider') as HTMLInputElement).tagName).toBe('INPUT')
  controller.dispose()
})

it('keeps a provider that could not list its models out of the model choices', async () => {
  const { controller } = harness(catalogWith([
    { id: 'broken', models: [], unavailable: true },
    { id: 'workbuddy', models: [{ id: 'deepseek-v4.1-flash' }] },
  ]))
  await waitFor(() => expect(screen.getByText('下面是这台设备已经接通的 provider 与模型。')).toBeTruthy())

  fireEvent.change(screen.getByLabelText('语义检测 provider'), { target: { value: 'broken' } })
  await waitFor(() => expect(screen.getByLabelText('语义检测模型')).toBeTruthy())
  // No models were returned, so the model box must stay free text instead of
  // showing an empty select the user cannot fill.
  expect((screen.getByLabelText('语义检测模型') as HTMLInputElement).tagName).toBe('INPUT')
  controller.dispose()
})
