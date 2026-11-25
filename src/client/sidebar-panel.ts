import { createElement, type ReactElement } from 'react'
import { IconSparkleMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'

/** 侧栏条目 id，必须与 `main` 槽位的 key 完全一致，否则点侧栏切不过去。 */
export const RUN2SKILL_PANEL_ID = 'run2skill'

/** 侧栏一行的显示名。 */
const PANEL_LABEL = '技能沉淀'

interface LayoutPageContext {
  readonly slots: {
    inject(name: string, install: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  readonly layout?: { selectPanel?(id: string): void }
}

function collect(stops: unknown[], stop: unknown): void {
  if (typeof stop === 'function') stops.push(stop)
}

function Run2skillSidebarIcon(props: { readonly size?: number }): ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  return createElement(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${String(size)}px`,
        height: `${String(size)}px`,
      },
      'aria-hidden': 'true',
    },
    createElement(IconSparkleMedium, { size }),
  )
}

function OpenPanelAction(props: {
  readonly subject?: { readonly kind?: string; readonly pkg?: { readonly name?: string }; readonly row?: { readonly moduleName?: string } }
  readonly packageName?: string
  readonly onOpen?: () => void
}): ReactElement | null {
  const subject = props.subject
  const packageName = props.packageName
  if (packageName === undefined) return null
  if (subject !== undefined) {
    const matches = subject.kind === 'bundle'
      ? subject.pkg?.name === packageName
      : subject.kind === 'row' ? subject.row?.moduleName === packageName : false
    if (!matches) return null
  }
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => { props.onOpen?.() },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
    },
    createElement(IconSparkleMedium, { size: 14 }),
    `打开${PANEL_LABEL}`,
  )
}

/**
 * 注册左侧栏「技能沉淀」入口。
 *
 * 三个槽位缺一不可，且都必须注册在 layout 服务的 pageCtx 上（不是设置服务的 slots）：
 *  1. `main` —— 面板本体，key 必须等于侧栏条目的 id；
 *  2. `sidebar.panellist` —— 左侧导航里那一行；
 *  3. `plugins.detail.actions` —— 插件详情页里的「打开技能沉淀」按钮。
 *
 * 任何一步失败只丢那一个入口，绝不让整个插件激活失败：设置页比侧栏重要得多。
 */
export function installRun2skillPanel(
  inject: Context['inject'],
  renderPanel: () => ReactElement,
): () => void {
  if (typeof inject !== 'function') return () => undefined
  const invoke = inject as unknown as (
    deps: readonly string[],
    install: (page: unknown) => unknown,
  ) => unknown
  try {
    const dispose = invoke(['layout'], (raw: unknown) => {
      const page = raw as LayoutPageContext | undefined
      if (page === undefined || typeof page.slots?.inject !== 'function') return () => undefined
      const stops: unknown[] = []

      /**
       * 每个槽位各自 try/catch。
       *
       * 早先三个槽位共用一个 try/catch，结果是只要 `main` 那一次注册抛错，
       * 后面的 `sidebar.panellist` 就永远轮不到注册 —— 界面上表现为「设置页一切正常，
       * 但左侧栏没有这一行」，而失败原因只留在一条看不见的 console.warn 里。
       * 现在每个槽位单独兜住，并在告警里点名是哪个槽位失败。
       */
      const slot = (name: string, install: () => unknown): void => {
        try {
          collect(stops, install())
        } catch (error) {
          warnSlot(name, error)
        }
      }

      slot('main', () => page.slots.inject('main', () => page.slots.register({
        name: 'main',
        key: RUN2SKILL_PANEL_ID,
      }, () => renderPanel())))

      slot('sidebar.panellist', () => page.slots.inject('sidebar.panellist', () => page.slots.register({
        name: 'sidebar.panellist',
        id: RUN2SKILL_PANEL_ID,
        order: 44,
        label: () => PANEL_LABEL,
      }, Run2skillSidebarIcon)))

      slot('plugins.detail.actions', () => page.slots.inject('plugins.detail.actions', () => page.slots.register({
        name: 'plugins.detail.actions',
        id: `${RUN2SKILL_PANEL_ID}-open`,
        order: 24,
        inject: () => ({
          packageName: '@duma520/dsh-run2skill',
          onOpen: () => { page.layout?.selectPanel?.(RUN2SKILL_PANEL_ID) },
        }),
      }, OpenPanelAction)))

      return () => {
        for (const stop of stops) {
          try {
            ;(stop as () => void)()
          } catch {
            /* 卸载失败不影响其它入口 */
          }
        }
      }
    })
    return typeof dispose === 'function' ? (dispose as () => void) : () => undefined
  } catch (error) {
    warn(error)
    return () => undefined
  }
}

function warn(error: unknown): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[run2skill] 侧栏入口注册失败，已跳过：${message}`)
}

/** 逐槽位失败告警：点名是哪个槽位挂了，方便对着控制台定位。 */
function warnSlot(slotName: string, error: unknown): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[run2skill] 槽位 ${slotName} 注册失败，已跳过该入口：${message}`)
}
