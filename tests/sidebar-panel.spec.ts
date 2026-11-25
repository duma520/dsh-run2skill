import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { RUN2SKILL_PANEL_ID, installRun2skillPanel } from '../src/client/sidebar-panel.js'

interface Registered {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: unknown
}

function makePage() {
  const registered: Registered[] = []
  const stops: string[] = []
  const page = {
    slots: {
      inject(name: string, install: () => unknown): () => void {
        install()
        return () => { stops.push(name) }
      },
      register(options: Record<string, unknown>, component: unknown): () => void {
        registered.push({ name: String(options.name), options, component })
        return () => { /* per-slot disposer */ }
      },
    },
    layout: { selectPanel: vi.fn() },
  }
  return { page, registered, stops }
}

describe('run2skill sidebar panel entry', () => {
  it('registers main, sidebar row and the plugin detail action', () => {
    const { page, registered } = makePage()
    const inject = vi.fn((deps: readonly string[], install: (p: unknown) => unknown) => {
      expect(deps).toEqual(['layout'])
      return install(page)
    })

    installRun2skillPanel(inject as never, () => createElement('div', null, 'panel'))

    expect(registered.map(item => item.name)).toEqual([
      'main', 'sidebar.panellist', 'plugins.detail.actions',
    ])
    const [main, row, detail] = registered
    // main 的 key 必须等于侧栏 id，否则点击侧栏切不过去
    expect(main!.options.key).toBe(RUN2SKILL_PANEL_ID)
    expect(row!.options.id).toBe(RUN2SKILL_PANEL_ID)
    expect(row!.options.label).toBeTypeOf('function')
    expect((row!.options.label as () => string)()).toBe('技能沉淀')
    expect(detail!.options.id).toBe(`${RUN2SKILL_PANEL_ID}-open`)
    const detailInject = (detail!.options.inject as () => Record<string, unknown>)()
    expect(detailInject.packageName).toBe('@duma520/dsh-run2skill')
    // 详情页按钮必须跳到本插件自己的面板
    ;(detailInject.onOpen as () => void)()
    expect(page.layout.selectPanel).toHaveBeenCalledWith(RUN2SKILL_PANEL_ID)
  })

  it('survives a host without ctx.inject', () => {
    const dispose = installRun2skillPanel(undefined as never, () => createElement('div'))
    expect(dispose).toBeTypeOf('function')
    expect(() => { dispose() }).not.toThrow()
  })

  it('drops only the sidebar entries when a slot registration throws', () => {
    const { page } = makePage()
    page.slots.inject = () => { throw new Error('layout unavailable') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const inject = (_deps: readonly string[], install: (p: unknown) => unknown) => install(page)

    const dispose = installRun2skillPanel(inject as never, () => createElement('div'))

    expect(dispose).toBeTypeOf('function')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('侧栏入口注册失败')
    warn.mockRestore()
  })

  it('disposes every slot it registered', () => {
    const { page, stops } = makePage()
    const inject = (_deps: readonly string[], install: (p: unknown) => unknown) => install(page)

    const dispose = installRun2skillPanel(inject as never, () => createElement('div'))
    dispose()

    expect(stops).toEqual(['main', 'sidebar.panellist', 'plugins.detail.actions'])
  })

  it('renders the supplied panel inside the main slot', () => {
    const { page, registered } = makePage()
    const inject = (_deps: readonly string[], install: (p: unknown) => unknown) => install(page)
    installRun2skillPanel(inject as never, () => createElement('span', null, '技能沉淀面板'))

    const renderMain = registered[0]!.component as () => unknown
    const element = renderMain() as { type: string; props: Record<string, unknown> }
    expect(element.type).toBe('span')
    expect(element.props.children).toBe('技能沉淀面板')
  })
})
