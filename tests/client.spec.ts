import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseUsageResponse } from '../src/balance.js'

/** 等待客户端的异步读取与 React 状态更新完成。 */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * 只替换 `Date.now()` 的时钟替身：`parse`、构造与格式化仍由真实 Date 提供，
 * 因此校验时间戳、倒计时与 `toLocaleTimeString` 的行为不变，只有节流窗口可控。
 */
function controlledDate(clock: { now: number }): DateConstructor {
  const RealDate = Date
  const FakeDate = function (this: unknown, ...args: unknown[]) {
    return args.length === 0 ? new RealDate(clock.now) : new (RealDate as any)(...args)
  } as unknown as DateConstructor
  FakeDate.now = () => clock.now
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  FakeDate.prototype = RealDate.prototype
  return FakeDate
}

/**
 * 浏览器全局替身。
 * client bundle 的 factory 在 `node:vm` 上下文里执行，因此 fetch、AbortController
 * 与定时器都必须显式注入；存储只保留在内存中。
 * `document` 桩提供宿主窗口拖拽区重算所需的 html 平台标记与 body 属性读写。
 */
function browserSandbox(options: {
  response?: () => Promise<Response>
  /** html 的平台标记；默认 darwin（Electron 桌面端）。 */
  platform?: string
  /** 预置的 localStorage 内容，用于验证偏好跨挂载恢复。 */
  seed?: Record<string, string>
  /** 提供后 client bundle 内的 `Date.now()` 改由该时钟驱动（用于节流窗口）。 */
  clock?: { now: number }
  /** 为 true 时 `matchMedia('(prefers-reduced-motion: reduce)')` 报告命中。 */
  reducedMotion?: boolean
} = {}) {
  const stored = new Map<string, string>(Object.entries(options.seed ?? {}))
  const session = new Map<string, string>()
  const windowListeners = new Map<string, ((event: any) => void)[]>()
  const bodyAttributes = new Map<string, string>()
  const frames: (() => void)[] = []
  /** 可控的 setTimeout 队列：记录到期时刻（以受控时钟为准），测试按需 flush。 */
  const timeouts = new Map<number, { callback: () => void; due: number }>()
  let nextTimeoutId = 1
  /** 当前时刻：提供受控时钟时以它为准，否则用真实时间。 */
  const now = () => options.clock?.now ?? Date.now()
  const sandbox: Record<string, any> = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value) },
        removeItem: (key: string) => { stored.delete(key) },
      },
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => { session.set(key, value) },
        removeItem: (key: string) => { session.delete(key) },
      },
      requestAnimationFrame(callback: () => void) {
        frames.push(callback)
        return frames.length
      },
      /** 刷新加载动画按减少动态效果降级；默认不命中，测试可开启。 */
      matchMedia(query: string) {
        return { matches: options.reducedMotion === true && query.includes('prefers-reduced-motion') }
      },
      addEventListener(type: string, handler: (event: any) => void) {
        windowListeners.set(type, [...windowListeners.get(type) ?? [], handler])
      },
      removeEventListener(type: string, handler: (event: any) => void) {
        windowListeners.set(type, (windowListeners.get(type) ?? []).filter(item => item !== handler))
      },
    },
    document: {
      documentElement: { dataset: { platform: options.platform ?? 'darwin' } },
      body: {
        setAttribute: (name: string, value: string) => { bodyAttributes.set(name, value) },
        removeAttribute: (name: string) => { bodyAttributes.delete(name) },
      },
    },
    fetch: options.response ?? (async () => new Response('{}', { status: 200 })),
    AbortController,
    setInterval,
    clearInterval,
    setTimeout: (callback: () => void, delay = 0) => {
      timeouts.set(nextTimeoutId, { callback, due: now() + delay })
      return nextTimeoutId++
    },
    clearTimeout: (id: number) => { timeouts.delete(id) },
  }
  if (options.clock !== undefined) sandbox.Date = controlledDate(options.clock)
  return {
    sandbox,
    stored,
    session,
    bodyAttributes,
    /** 执行已排队的动画帧回调：重算脉冲的清除动作就在其中。 */
    flushFrames: () => { for (const frame of frames.splice(0)) frame() },
    /** 执行已到期（按受控时钟判断）的 setTimeout 回调：刷新冷却与「刷新中」兜底都在其中。 */
    flushTimers: () => {
      for (const [id, timer] of [...timeouts]) {
        if (timer.due > now()) continue
        timeouts.delete(id)
        timer.callback()
      }
    },
    /** 派发一次 window 事件，供拖拽等真实监听路径使用。 */
    dispatchWindow: (type: string, event: any) => {
      for (const handler of windowListeners.get(type) ?? []) handler(event)
    },
    windowListenerCount: (type: string) => (windowListeners.get(type) ?? []).length,
  }
}

/** 在纯对象元素树中寻找一个指定节点。 */
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as Element
  if (predicate(element)) return element
  return element.children?.map(child => find(child, predicate)).find(Boolean)
}

interface Element {
  type: string
  props: Record<string, any>
  children: unknown[]
}

/** 收集子树里的全部 button 元素，用于断言各形态的按钮集合。 */
function collectButtons(node: unknown): Element[] {
  const found: Element[] = []
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(walk); return }
    if (typeof current !== 'object' || current === null) return
    const element = current as Element
    if (element.type === 'button') found.push(element)
    element.children?.forEach(walk)
  }
  walk(node)
  return found
}

/**
 * 定位卡片的密钥输入框。
 * 卡片同时渲染展示开关的复选框，因此必须按 `type` 精确匹配而不是取第一个 input。
 */
function passwordInput(tree: unknown): Element | undefined {
  return find(tree, node => node.type === 'input' && node.props.type === 'password')
}

/** 定位展示开关的复选框。 */
function overlaySwitch(tree: unknown): Element | undefined {
  return find(tree, node => node.type === 'input' && node.props.type === 'checkbox')
}

test('客户端卡片仅在点击编辑后允许修改密钥并显示动态模型', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')

  let registration: { id: string; factory: (require: (name: string) => unknown) => any } | undefined
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const browser = browserSandbox()
  browser.sandbox.window.__ModuleLoader__ = { load: (entry: typeof registration) => { registration = entry } }
  runInNewContext(client, browser.sandbox)
  assert.equal(registration?.id, pkg.name)

  const state: unknown[] = []
  const effects: { deps: unknown[]; dispose?: () => void }[] = []
  const pending: { index: number; run: () => void; deps: unknown[] }[] = []
  let cursor = 0
  const React = {
    createElement: (type: string, props: Record<string, any> | null, ...children: unknown[]): Element => ({
      type, props: props ?? {}, children,
    }),
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect(run: () => (() => void), deps: unknown[]) {
      const index = cursor++
      const previous = effects[index]
      if (previous === undefined || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.dispose?.()
        pending.push({ index, run, deps })
      }
    },
  }
  const extension = registration!.factory((name: string) => {
    assert.equal(name, 'react')
    return React
  })
  const components = new Map<string, (props: { t: (key: string) => string }) => Element>()
  const injectedSlots: string[] = []
  let dictionary: Record<string, string> = {}
  let ref = 'OPENCODE_GO_LIVE_API_KEY'
  let models = [{ id: 'new-model', name: 'New Model' }]
  let configured = false
  let overlayEnabled = true
  const saved: [string, string][] = []
  const mutations: { ns: string; ops: unknown[]; revision: unknown }[] = []
  const listeners = new Map<string, ((...args: string[]) => void)[]>()
  const ctx = {
    effect: (setup: () => () => void) => { setup() },
    locale: { register: (_ns: string, copy: { zh: Record<string, string> }) => {
      dictionary = copy.zh
      return () => {}
    } },
    slots: {
      inject: (name: string, register: () => void) => { injectedSlots.push(name); register() },
      register: (meta: { name: string }, render: (props: { t: (key: string) => string }) => Element) => {
        components.set(meta.name, render)
      },
    },
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            namespaces: [{
              ns: 'llm-opencode-go-live',
              value: { apiKeyEnv: ref, showBalanceOverlay: overlayEnabled },
              revision: 7,
            }],
          },
        }),
        mutate: async (ns: string, ops: unknown[], revision: unknown) => {
          mutations.push({ ns, ops, revision })
          overlayEnabled = (ops[0] as { value: boolean }).value
          return { ok: true, value: { ns, value: { showBalanceOverlay: overlayEnabled } } }
        },
      },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'opencode-go-live', models }], failures: [] } }) },
      credentials: {
        describe: async () => ({ ok: true, value: { [ref]: { configured, writable: true } } }),
        set: async (name: string, key: string) => { saved.push([name, key]); configured = true; return { ok: true } },
      },
      $on: (event: string, callback: (...args: string[]) => void) => {
        listeners.set(event, [...listeners.get(event) ?? [], callback])
        return () => { listeners.set(event, listeners.get(event)!.filter(item => item !== callback)) }
      },
    },
  }
  extension.apply(ctx)
  assert.deepEqual(injectedSlots, ['settings.models.footer', 'shell.overlay'])
  const component = components.get('settings.models.footer')
  assert.ok(component)
  const t = (key: string): string => dictionary[key]!
  /** 执行模拟 React 渲染及这次渲染新注册的 effect。 */
  function render(): Element {
    cursor = 0
    const tree = component!({ t })
    for (const next of pending.splice(0)) {
      effects[next.index] = { deps: next.deps, dispose: next.run() }
    }
    return tree
  }

  render()
  await settle()
  let tree = render()
  assert.equal(find(tree, node => node.type === 'code' && node.children[0] === 'new-model')?.children[0], 'new-model')
  assert.equal(passwordInput(tree), undefined)
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  const input = passwordInput(tree)!
  input.props.onChange({ target: { value: 'discarded-key' } })
  tree = render()
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.cancel)!.props.onClick()
  tree = render()
  assert.equal(passwordInput(tree), undefined)
  assert.deepEqual(saved, [])
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  assert.equal(passwordInput(tree)?.props.value, '')
  const activeInput = passwordInput(tree)!
  activeInput.props.onChange({ target: { value: 'sk-test-live' } })
  tree = render()
  await find(tree, node => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
  await settle()
  tree = render()
  await settle()
  tree = render()
  assert.deepEqual(saved, [['OPENCODE_GO_LIVE_API_KEY', 'sk-test-live']])
  assert.equal(passwordInput(tree), undefined)
  assert.ok(find(tree, node => node.type === 'p' && node.children[0] === dictionary.configured))

  // 编辑期间凭据引用变化：草稿作废，旧引用的密钥不得写进新引用
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  passwordInput(tree)!.props.onChange({ target: { value: 'stale-draft-key' } })
  tree = render()
  assert.equal(passwordInput(tree)?.props.value, 'stale-draft-key')

  ref = 'CUSTOM_GO_KEY'
  models = [{ id: 'later-model', name: 'Later Model' }]
  listeners.get('settings/document-updated')![0]!('llm-opencode-go-live')
  await settle()
  tree = render()
  assert.ok(find(tree, node => node.type === 'code' && node.children[0] === 'later-model'))
  tree = render()
  assert.equal(passwordInput(tree), undefined)
  assert.deepEqual(saved, [['OPENCODE_GO_LIVE_API_KEY', 'sk-test-live']])
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  passwordInput(tree)!.props.onChange({ target: { value: 'sk-next-live' } })
  tree = render()
  await find(tree, node => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(saved[1], ['CUSTOM_GO_KEY', 'sk-next-live'])

  // 展示开关：默认跟随配置，点击后写入同一 namespace 的 showBalanceOverlay 路径
  const switchNode = overlaySwitch(tree)!
  assert.equal(switchNode.props.checked, true)
  assert.equal(switchNode.props['aria-label'], dictionary.showOverlay)
  await switchNode.props.onChange({ target: { checked: false } })
  await settle()
  tree = render()
  // ops 数组来自 vm 上下文，跨 realm 的 deepEqual 会因原型不同失败，按值比较。
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0]!.ns, 'llm-opencode-go-live')
  assert.equal(mutations[0]!.revision, 7)
  assert.deepEqual(JSON.parse(JSON.stringify(mutations[0]!.ops)), [
    { op: 'set', path: ['showBalanceOverlay'], value: false },
  ])
  assert.equal(overlaySwitch(tree)?.props.checked, false)

  // 写入被拒绝时必须回滚乐观状态并显示宿主诊断
  ctx.remote.settings.mutate = async () => ({ ok: false, error: { message: 'settings-conflict' } })
  await overlaySwitch(tree)!.props.onChange({ target: { checked: true } })
  await settle()
  tree = render()
  assert.equal(overlaySwitch(tree)?.props.checked, false)
  assert.ok(find(tree, node => node.type === 'p' && node.children[0] === 'settings-conflict'))
  for (const effect of effects) effect?.dispose?.()
})

/** 无 DOM 的假 React：函数式初始值按真实语义执行，effect 在渲染后统一结算。 */
function createFakeReact() {
  // 每个组件实例拥有独立的 hook 序列：key 是「父组件渲染路径」，与真实 React
  // 按组件实例分槽的行为一致。这样条件分支里多调/少调 hook 才会被发现。
  const slots = new Map<string, { state: unknown[]; effects: { deps: unknown[]; dispose?: () => void }[]; hookCount: number }>()
  const pending: { run: () => void; slot: string; index: number; deps: unknown[] }[] = []
  let cursor = 0
  let currentSlot = 'root'
  /** 取当前组件的 hook 槽位，首次出现时创建。 */
  function slotOf(name: string) {
    let slot = slots.get(name)
    if (slot === undefined) {
      slot = { state: [], effects: [], hookCount: 0 }
      slots.set(name, slot)
    }
    return slot
  }
  /**
   * 校验「同一组件实例每轮渲染的 hook 数一致」——真实 React 的硬性规则。
   * 缺了这条校验，把带 hook 的函数组件当普通函数调用（hook 落进父组件序列、
   * 且调用点在各形态分支里数量不同）在测试里完全看不出来，上线才崩。
   */
  function assertHookStability(name: string, count: number) {
    const slot = slotOf(name)
    if (slot.hookCount !== 0 && slot.hookCount !== count) {
      throw new Error(
        `违反 Hooks 规则：组件「${name}」上一轮渲染调用了 ${slot.hookCount} 个 hook，本轮 ${count} 个。`
        + '真实 React 会抛「Rendered more hooks than during the previous render」并让组件崩溃。'
        + '带 hook 的函数组件必须用 h(Component) 渲染，不能当普通函数调用。',
      )
    }
    slot.hookCount = count
  }
  const React = {
    createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): any => {
      // 函数组件立即展开——与真实 React 渲染子组件一致，其 hook 记在独立槽位。
      if (typeof type === 'function') {
        const savedSlot = currentSlot
        const savedCursor = cursor
        const childSlot = `${savedSlot}/${(type as Function).name || 'anon'}`
        currentSlot = childSlot
        cursor = 0
        try {
          // children 必须按真实 React 语义传：0 个为 undefined、1 个为该节点本身、
          // 多个才是数组。用 rest 数组会掩盖「对单个子节点做展开」这类崩溃。
          const childArgs = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
          const rendered = (type as Function)({ ...(props ?? {}), children: childArgs })
          assertHookStability(childSlot, cursor)
          return rendered
        } finally {
          currentSlot = savedSlot
          cursor = savedCursor
        }
      }
      return { type, props: props ?? {}, children }
    },
    useState(initial: unknown) {
      const slot = slotOf(currentSlot)
      const index = cursor++
      if (!(index in slot.state)) {
        slot.state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      return [slot.state[index], (next: any) => {
        slot.state[index] = typeof next === 'function' ? next(slot.state[index]) : next
      }]
    },
    useEffect(run: () => () => void, deps: unknown[]) {
      const slot = slotOf(currentSlot)
      const index = cursor++
      const previous = slot.effects[index]
      if (previous === undefined || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.dispose?.()
        pending.push({ run, slot: currentSlot, index, deps })
      }
    },
  }
  return {
    React,
    render(component: (props: { t: (key: string) => string }) => Element | null, props: { t: (key: string) => string }): Element | null {
      currentSlot = 'root'
      cursor = 0
      const tree = component(props)
      assertHookStability('root', cursor)
      for (const next of pending.splice(0)) {
        const slot = slotOf(next.slot)
        // deps 必须回写真实依赖：写空会让下一轮误判「依赖变了」而反复重跑副作用。
        slot.effects[next.index] = { deps: next.deps, dispose: next.run() }
      }
      return tree
    },
    dispose() {
      for (const slot of slots.values()) for (const effect of slot.effects) effect?.dispose?.()
    },
  }
}

/**
 * 建立悬浮窗测试环境：浏览器存储桩、宿主描述替身与可替换的余额响应。
 * @returns 组件、词典、渲染器与恢复函数。
 */
async function mountOverlay(options: {
  overlayEnabled?: boolean
  /** 为 true 时宿主描述里不出现该字段，用于验证「未配置即默认开启」。 */
  omitOverlayField?: boolean
  response?: () => Promise<Response>
  /** html 的平台标记；默认 darwin。 */
  platform?: string
  /** 预置 localStorage，用于验证位置、固定与尺寸偏好跨挂载恢复。 */
  seed?: Record<string, string>
  /** 提供后 client bundle 内的 `Date.now()` 由该时钟驱动，用于节流窗口测试。 */
  clock?: { now: number }
  /** 为 true 时报告系统开启了「减少动态效果」。 */
  reducedMotion?: boolean
}) {
  let registration: { id: string; factory: (require: (name: string) => unknown) => any } | undefined
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const browser = browserSandbox(options)
  browser.sandbox.window.__ModuleLoader__ = { load: (entry: typeof registration) => { registration = entry } }
  runInNewContext(client, browser.sandbox)

  const harness = createFakeReact()
  const components = new Map<string, (props: { t: (key: string) => string }) => Element | null>()
  const listeners = new Map<string, ((...args: string[]) => void)[]>()
  const mutations: { ns: string; ops: unknown[]; revision: unknown }[] = []
  const addedListeners: string[] = []
  const baseAddEventListener = (browser.sandbox.window as Record<string, any>)['addEventListener'] as (type: string, handler: (event: any) => void) => void
  ;(browser.sandbox.window as Record<string, any>)['addEventListener'] = (type: string, handler: (event: any) => void) => {
    addedListeners.push(type)
    baseAddEventListener(type, handler)
  }
  let dictionary: Record<string, string> = {}
  let overlayEnabled = options.overlayEnabled ?? true

  const ctx = {
    effect: (setup: () => () => void) => { setup() },
    locale: { register: (_ns: string, copy: { zh: Record<string, string> }) => { dictionary = copy.zh; return () => {} } },
    slots: {
      inject: (_name: string, register: () => void) => { register() },
      register: (meta: { name: string }, render: (props: { t: (key: string) => string }) => Element) => {
        components.set(meta.name, render)
      },
    },
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            namespaces: [{
              ns: 'llm-opencode-go-live',
              value: options.omitOverlayField === true ? {} : { showBalanceOverlay: overlayEnabled },
              revision: 1,
            }],
          },
        }),
        mutate: async (ns: string, ops: unknown[], revision: unknown) => {
          mutations.push({ ns, ops, revision })
          return { ok: true, value: { ns, value: {} } }
        },
      },
      $on: (event: string, callback: (...args: string[]) => void) => {
        listeners.set(event, [...listeners.get(event) ?? [], callback])
        return () => { listeners.set(event, listeners.get(event)!.filter(item => item !== callback)) }
      },
    },
  }
  registration!.factory((name: string) => {
    assert.equal(name, 'react')
    return harness.React
  }).apply(ctx)
  const component = components.get('shell.overlay')
  assert.ok(component, '插件必须把自己注册进 shell.overlay')
  return {
    harness,
    component,
    dictionary,
    stored: browser.stored,
    session: browser.session,
    bodyAttributes: browser.bodyAttributes,
    flushFrames: browser.flushFrames,
    flushTimers: browser.flushTimers,
    mutations,
    addedListeners,
    render: () => harness.render(component!, { t: (key: string) => dictionary[key]! }),
    /** 等待配置读取与首次查询落地：fetch 与其 JSON 解析各占一拍。 */
    ready: async () => {
      const props = { t: (key: string) => dictionary[key]! }
      harness.render(component!, props)
      await settle()
      harness.render(component!, props)
      await settle()
      harness.render(component!, props)
    },
    /** 常驻锚点：承载悬浮判定与收缩态整块拖拽。 */
    anchor: (tree?: unknown): Element => find(
      tree ?? harness.render(component!, { t: (key: string) => dictionary[key]! }),
      node => node.props?.style?.position === 'absolute' && typeof node.props?.onMouseEnter === 'function',
    )!,
    /** 鼠标进入锚点：收缩态升为 brief。 */
    hover: () => { const node = find(harness.render(component!, { t: (key: string) => dictionary[key]! }), n => n.props?.style?.position === 'absolute' && typeof n.props?.onMouseEnter === 'function')!; node.props.onMouseEnter() },
    /** 鼠标离开锚点：brief 回到收缩态，full 保持不动。 */
    unhover: () => { const node = find(harness.render(component!, { t: (key: string) => dictionary[key]! }), n => n.props?.style?.position === 'absolute' && typeof n.props?.onMouseLeave === 'function')!; node.props.onMouseLeave() },
    /** 点击「展开／收起」按钮切换 brief 与 full。 */
    toggleFull: () => {
      const tree = harness.render(component!, { t: (key: string) => dictionary[key]! })
      find(tree, n => n.props?.['data-opencode-go-live-overlay'] === 'expand')!.props.onClick()
    },
    dispatchWindow: browser.dispatchWindow,
    windowListenerCount: browser.windowListenerCount,
    setOverlayEnabled: (value: boolean) => { overlayEnabled = value },
    emitSettingsChange: () => {
      for (const listener of listeners.get('settings/document-updated') ?? []) listener('llm-opencode-go-live')
    },
    restore: () => { harness.dispose() },
  }
}

test('三态互切时悬浮窗组件的 hook 数量保持稳定，不会因形态变化崩溃', async () => {
  // 回归守护：v0.2.4 之后曾把带 hook 的提示按钮当普通函数调用，调用点又分布在各形态
  // 分支里，导致 ring/brief/full 的 hook 数不同。真实 React 会抛
  // 「Rendered more hooks than during the previous render」并让整个悬浮窗消失。
  // 沙箱的 render 已内置 hook 稳定性校验，这里把三态来回切两轮以确保覆盖。
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    // ring → brief（悬停）
    overlay.hover()
    overlay.render()
    // brief → full（点展开）
    overlay.toggleFull()
    overlay.render()
    // full → brief（点收起）
    overlay.toggleFull()
    overlay.render()
    // brief → ring（移出）
    overlay.unhover()
    overlay.render()
    // 再来一轮，确认槽位没有被前一轮污染
    overlay.hover()
    overlay.render()
    overlay.toggleFull()
    overlay.render()
    // 能渲染出完整面板即说明三态互切没有让组件崩溃
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '三态多次互切后仍必须正常渲染',
    )
  } finally {
    overlay.restore()
  }
})

test('按钮悬浮提示延迟出现、移出与按下立即消失，禁用按钮不显示', async () => {
  // client bundle 的 TOOLTIP_DELAY_MS 平行定义。
  const TOOLTIP_DELAY_MS = 220
  const clock = { now: 1_000_000 }
  const overlay = await mountOverlay({ clock, response: rollingOnly })
  try {
    await overlay.ready()
    overlay.hover()

    /** 当前渲染树里可见的提示气泡（同一时刻最多一个）。 */
    const tipOf = () => find(
      overlay.render(), node => node.props?.['data-opencode-go-live-overlay'] === 'tooltip',
    )
    /** 提示气泡的文案；没有提示时返回 undefined。 */
    const tipText = () => tipOf()?.children[0]
    /** 取某个按钮元素（内层 button 带 data-* 标记）。 */
    const buttonOf = (marker: string) => find(
      overlay.render(), node => node.props?.['data-opencode-go-live-overlay'] === marker,
    )!
    /** 按提示文案定位提示气泡：多个按钮各有独立实例，只认目标那个。 */
    const tipByText = (text: string) => find(
      overlay.render(), node => node.props?.['data-opencode-go-live-overlay'] === 'tooltip'
        && node.props['data-tip'] === text,
    )

    // 初始无提示
    assert.equal(tipOf(), undefined, '未悬停时不得显示提示')

    // 悬停后未到期：不显示（避免掠过的指针弹提示）
    buttonOf('pin').props.onMouseEnter({})
    assert.equal(tipOf(), undefined, '提示必须延迟出现')
    clock.now += TOOLTIP_DELAY_MS - 1
    overlay.flushTimers()
    assert.equal(tipOf(), undefined, '未到延迟阈值不得显示')

    // 到期：显示，且文案来自词典短标签
    clock.now += 2
    overlay.flushTimers()
    const tip = tipByText(overlay.dictionary.pinOverlay)
    assert.ok(tip, '到期后必须显示 pin 的提示')
    assert.equal(tip.props.role, 'tooltip', '提示必须带 tooltip 角色')
    assert.equal(tip.children[0], overlay.dictionary.pinOverlay, '提示文案使用现有短标签')
    assert.equal(tip.props.style.pointerEvents, 'none', '提示不得参与点击命中')

    // 移出：立即消失
    buttonOf('pin').props.onMouseLeave({})
    assert.equal(tipOf(), undefined, '移出后提示必须立即消失')

    // 按下：立即消失，且原 pointerdown 仍被调用（stopDrag 依赖它）
    let dragStopped = false
    buttonOf('pin').props.onMouseEnter({})
    clock.now += TOOLTIP_DELAY_MS + 1
    overlay.flushTimers()
    assert.ok(tipOf(), '再次悬停到期后应显示')
    buttonOf('pin').props.onPointerDown({ stopPropagation: () => { dragStopped = true } })
    assert.equal(tipOf(), undefined, '按下后提示必须消失')
    assert.equal(dragStopped, true, '提示组件必须转发原有的 pointerdown 处理')

    // 刷新按钮在请求进行中禁用：悬停不显示提示
    const refresh = () => overlay.render()
    find(refresh(), node => node.props['data-opencode-go-live-overlay'] === 'refresh')!.props.onClick()
    const disabledRefresh = find(refresh(), node => node.props['data-opencode-go-live-overlay'] === 'refresh')!
    assert.equal(disabledRefresh.props.disabled, true)
    disabledRefresh.props.onMouseEnter({})
    clock.now += TOOLTIP_DELAY_MS + 1
    overlay.flushTimers()
    assert.equal(tipOf(), undefined, '禁用按钮不得显示提示')
  } finally {
    overlay.restore()
  }
})

test('收缩态渲染圆环，悬停升为长条，点击展开显示三个计费窗口，移开回到圆环', async () => {
  // 契约测试：客户端消费的正是宿主路由真实产出的 envelope，而不是手写的近似结构。
  const overlay = await mountOverlay({
    overlayEnabled: true,
    response: async () => new Response(JSON.stringify(parseUsageResponse(200, {
      usage: {
        rolling: { status: 'ok', percent: 37.5, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
        weekly: { status: 'ok', percent: 12, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        monthly: { status: 'rate-limited', percent: 100, resetsAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
      },
    })), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    // 配置未读到时既不渲染也不查询。
    assert.equal(overlay.render(), null)
    await overlay.ready()

    // ① 收缩态：圆环 + Go-38%，无按钮。
    const ring = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip')
    assert.ok(ring, '配置读到后默认渲染收缩态圆环胶囊')
    assert.ok(find(ring, node => node.props['data-opencode-go-live-overlay'] === 'ring'), '收缩态必须含圆环')
    assert.ok(find(ring, node => node.type === 'span' && node.children[0] === 'Go-38%'), '收缩态文字为 Go-已用%')
    assert.equal(collectButtons(ring).length, 0, '收缩态不显示任何按钮')

    // ② 悬停态：保留长条形态并补全全部按钮。
    overlay.hover()
    const brief = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip')!
    assert.ok(brief, '悬停后升为长条形态')
    assert.ok(find(brief, node => node.props?.style?.height === 4), '长条形态保留横条进度')
    // 主体是纯展示，只有四个操作按钮；进入完整态的唯一入口是「展开」按钮。
    const briefButtons = collectButtons(brief)
    assert.equal(briefButtons.length, 4, '长条形态只有四个操作按钮，主体不可点击')
    assert.deepEqual(
      [...new Set(briefButtons.map(button => button.props['aria-label']))].sort(),
      [
        overlay.dictionary.expandOverlay,
        overlay.dictionary.pinOverlay,
        overlay.dictionary.refresh,
        overlay.dictionary.closeOverlay,
      ].sort(),
      '悬停态必须显示全部四个操作按钮',
    )
    // 回归守护：长条主体曾是按钮，点它也会展开，导致「hover 后随手点一下」就进完整态。
    // 现在主体是纯展示，进入完整态的唯一入口是「展开」按钮。
    const chipMain = find(brief, node => node.props['data-opencode-go-live-overlay'] === 'chip-main')!
    assert.equal(chipMain.type, 'span', '长条主体必须是纯展示元素，不能是按钮')
    assert.equal(chipMain.props.onClick, undefined, '长条主体不得绑定点击处理')
    assert.equal(chipMain.props.style?.cursor, undefined, '纯展示主体不得显示可点击光标')

    // ③ 完整态：点击展开显示三个窗口行。
    overlay.toggleFull()
    const panel = overlay.render()
    assert.ok(find(panel, node => node.props['data-opencode-go-live-overlay'] === 'panel'))
    assert.equal(find(panel, node => node.type === 'span' && node.children[0] === overlay.dictionary.overlayTitle) !== undefined, true)
    assert.equal(find(panel, node => node.type === 'span' && node.children[0] === '38%') !== undefined, true)
    assert.equal(find(panel, node => node.type === 'span' && node.children[0] === '100%') !== undefined, true)
    const tracks = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node !== 'object' || node === null) return
      const element = node as Element
      if (element.props?.style?.height === 4) tracks.push(element)
      element.children?.forEach(walk)
    }
    walk(panel)
    assert.equal(tracks.length, 3, '完整态显示三个计费窗口的进度条')

    // 完整态对鼠标移出不响应：读完三个窗口前不会自己缩回去。
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '完整态移出鼠标不得自动降级',
    )

    // 点「收起」回到长条；此时指针已不在悬浮窗上，再移出即回收缩态。
    overlay.toggleFull()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'), '收起后回到长条形态')
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'), '移出后回到收缩态圆环')
  } finally {
    overlay.restore()
  }
})

test('悬浮窗按错误码显示本地化文案且开关关闭时不渲染', async () => {
  const failing = await mountOverlay({
    overlayEnabled: true,
    response: async () => new Response(JSON.stringify({ ok: false, code: 'NO_SUBSCRIPTION', message: 'x' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  })
  try {
    await failing.ready()
    failing.hover()
    failing.toggleFull()
    const tree = failing.render()
    assert.ok(find(tree, node => node.children?.[0] === failing.dictionary.errorNoSubscription))
  } finally {
    failing.restore()
  }

  const disabled = await mountOverlay({ overlayEnabled: false })
  try {
    await disabled.ready()
    assert.equal(disabled.render(), null)
    assert.equal(disabled.render(), null)
  } finally {
    disabled.restore()
  }
})

test('未配置展示字段时悬浮窗默认开启', async () => {
  const overlay = await mountOverlay({
    omitOverlayField: true,
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      usage: { rolling: { status: 'ok', percent: 5, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await overlay.ready()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'),
      '配置里没有该字段时必须默认渲染收缩态圆环',
    )
  } finally {
    overlay.restore()
  }
})

test('关闭按钮写入配置同步关闭模型页开关，重新打开开关后徽章恢复', async () => {
  const overlay = await mountOverlay({
    overlayEnabled: true,
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      usage: { rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await overlay.ready()
    // 悬停升为长条形态，关闭按钮在那里可见
    overlay.hover()
    const tree = overlay.render()
    await find(tree, node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.closeOverlay)!.props.onClick()
    await settle()
    assert.equal(overlay.mutations.length, 1)
    assert.equal(overlay.mutations[0]!.ns, 'llm-opencode-go-live')
    assert.deepEqual(JSON.parse(JSON.stringify(overlay.mutations[0]!.ops)), [
      { op: 'set', path: ['showBalanceOverlay'], value: false },
    ])
    assert.equal(overlay.render(), null, '关闭后徽章与面板都必须消失')

    // 宿主广播关闭结果后仍隐藏；重新打开开关（卡片侧写入 true）后徽章恢复
    overlay.setOverlayEnabled(false)
    overlay.emitSettingsChange()
    await settle()
    assert.equal(overlay.render(), null)
    overlay.setOverlayEnabled(true)
    overlay.emitSettingsChange()
    await settle()
    // 隐藏期间不残留形态：指针从未移出过，重新打开也必须先显示收缩态
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'),
      '重新打开开关时必须回到收缩态，而不是停在长条或完整面板',
    )
    overlay.hover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'))
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'),
      '重新打开开关且鼠标不在悬浮窗上时应显示收缩态圆环',
    )
  } finally {
    overlay.restore()
  }
})

test('收缩态圆环弧长等于已用占比，长条形态显示横条百分比，固定按钮状态双向切换', async () => {
  const overlay = await mountOverlay({
    overlayEnabled: true,
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      // 已用 37.5% → 展示取整为 38%
      usage: { rolling: { status: 'ok', percent: 37.5, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await overlay.ready()

    // 收缩态：圆环由底轨 + 进度弧两段描边组成，弧长按已用占比计算
    const ringChip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip')!
    const ring = find(ringChip, node => node.props['data-opencode-go-live-overlay'] === 'ring')!
    const arcs = collectButtons(ring)
    assert.equal(arcs.length, 0, '圆环内不得有按钮')
    const circles: Element[] = []
    const walkCircles = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walkCircles); return }
      if (typeof node !== 'object' || node === null) return
      const element = node as Element
      if (element.type === 'circle') circles.push(element)
      element.children?.forEach(walkCircles)
    }
    walkCircles(ring)
    assert.equal(circles.length, 2, '圆环 = 底轨 + 进度弧')
    // 回归守护：底轨曾用 `bg-layer-3`，而浅色主题下 bg-layer-1/2/3 全部解析为同一个
    // `#fff`，底轨与胶囊背景同色，圆环只剩进度弧、看不出「圈」。
    // 必须使用与背景有对比的 token（label-tertiary：浅色 #81858c / 深色 #adb2b8）。
    assert.equal(
      circles[0]!.props.style.stroke, 'var(--dsw-alias-label-tertiary)',
      '圆环底轨必须用与背景有对比的颜色，不能用与胶囊背景同色的 bg-layer-3',
    )
    assert.notEqual(
      circles[0]!.props.style.stroke, 'var(--dsw-alias-bg-layer-3)',
      '底轨不得回退到 bg-layer-3（浅色主题下与背景同色）',
    )
    // 弧长断言：38% 的周长（r = (16-3)/2 = 6.5 → C ≈ 40.84 → 15.52）
    const dash = String(circles[1]!.props['stroke-dasharray'])
    const [usedArc] = dash.split(' ')
    const circumference = 2 * Math.PI * 6.5
    assert.ok(
      Math.abs(Number(usedArc) / circumference - 0.38) < 0.001,
      `进度弧长必须等于已用占比，实际 ${usedArc}/${circumference}`,
    )
    assert.ok(find(ringChip, node => node.type === 'span' && node.children[0] === 'Go-38%'), '收缩态文字为 Go-已用%')

    // 长条形态：保留横条进度与百分比
    overlay.hover()
    const chip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip')!
    const track = find(chip, node => node.props?.style?.height === 4)
    assert.equal(track?.props.style.width, 56)
    // 回归守护：横条底轨曾用 bg-layer-2，浅色主题下与胶囊背景同为 #fff（对比度 1.00），
    // 未填充部分完全隐形。必须与圆环底轨一样用与背景有对比的 token。
    assert.equal(
      track?.props.style.background, 'var(--dsw-alias-label-tertiary)',
      '横条底轨必须用与背景有对比的颜色，不能用与胶囊背景同色的 bg-layer-2',
    )
    assert.ok(find(track, node => node.props?.style?.width === '38%'))
    assert.ok(find(chip, node => node.type === 'span' && node.children[0] === '38%'))

    // 默认不固定：空心图标
    const pin = find(chip, node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.pinOverlay)!
    assert.equal(pin.props['aria-pressed'], false)
    assert.equal(find(pin, node => node.type === 'circle')?.props.fill, 'none')
    assert.equal(overlay.stored.get('opencode-go-live.overlay.pinned') ?? null, null)

    // 选中后变为实心并写入本地存储
    pin.props.onClick()
    const unpin = find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.unpinOverlay)!
    assert.equal(unpin.props['aria-pressed'], true)
    assert.equal(find(unpin, node => node.type === 'circle')?.props.fill, 'currentColor')
    assert.equal(overlay.stored.get('opencode-go-live.overlay.pinned'), '1')
  } finally {
    overlay.restore()
  }
})

test('收缩态与完整面板拖拽受固定状态门控，拖动后的点击不触发形态变化', async () => {
  const overlay = await mountOverlay({
    overlayEnabled: true,
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      usage: { rolling: { status: 'ok', percent: 20, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await overlay.ready()
    // 拖拽处理器绑在锚点上：currentTarget 即锚点，其 offsetParent 才是 frame。
    const frame = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) }
    const anchorStub = { offsetParent: frame, getBoundingClientRect: () => ({ left: 100, top: 100, width: 180, height: 28 }) }
    const dragStart = { clientX: 200, clientY: 200, currentTarget: anchorStub, preventDefault() {} }

    // 未固定：收缩态整块可拖
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 1)
    overlay.dispatchWindow('pointermove', { clientX: 260, clientY: 240 })
    overlay.dispatchWindow('pointerup', {})
    assert.equal(overlay.windowListenerCount('pointermove'), 0, '拖拽结束必须移除监听')
    assert.equal(overlay.render()?.props.style.left, 160, '拖拽必须更新锚点位置')

    // 拖拽余波内的点击属于移动手势，不得进入长条形态
    find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip')!.props.onClick()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'))

    // 固定后：收缩态拖拽不再生效
    overlay.hover()
    find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.pinOverlay)!.props.onClick()
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 0, '固定后收缩态不得注册拖拽监听')

    // 解除固定后：完整面板同样可拖（事件冒泡到锚点）
    find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.unpinOverlay)!.props.onClick()
    overlay.toggleFull()
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 1, '解除固定后标题栏拖拽必须恢复')

    // 拖拽期间指针越过锚点边界（拖到视口边缘）不得降级
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '拖拽期间不得降级形态',
    )
    // 拖拽结束后：完整态移交出不降级，点「收起」后再移出才回到收缩态
    overlay.dispatchWindow('pointerup', {})
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '完整态对移出不响应',
    )
    overlay.toggleFull()
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'))
  } finally {
    overlay.restore()
  }
})

/** 新增用例共用的成功响应替身：只有 5 小时窗口，已用 37.5%。 */
const rollingOnly = async (): Promise<Response> => new Response(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  usage: { rolling: { status: 'ok', percent: 37.5, resetsAt: new Date(Date.now() + 3600_000).toISOString() } },
}), { status: 200, headers: { 'content-type': 'application/json' } })

test('悬浮窗锚点从窗口拖拽几何中减除，并在几何变化后请求重算拖拽区', async () => {
  // 宿主按几何（而非层级）合成 Electron 的 app-region：悬浮窗移到顶部与
  // `data-window-drag` 行重叠时，不在锚点上声明 no-drag 就会拖动整个窗口。
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    const anchor = overlay.anchor(overlay.render())
    // 宿主 base.css 的交互元素规则带 [tabindex]：-1 让整块锚点命中它，且不进 Tab 顺序
    assert.equal(anchor.props.tabIndex, -1, '锚点必须带 tabindex，才能命中宿主 [tabindex] 的 no-drag 规则')
    // 内联声明两种拼写：不同引擎只暴露其中一种 CSSOM 别名
    assert.equal(anchor.props.style.WebkitAppRegion, 'no-drag', '锚点必须把悬浮窗从窗口拖拽几何中减除')
    assert.equal(anchor.props.style.webkitAppRegion, 'no-drag')

    // Electron 只在 app-region 计算值变化时重算拖拽矩形，展开与移动后必须补一次脉冲
    assert.equal(overlay.bodyAttributes.get('data-window-drag-recall'), '', '挂载后必须请求重算拖拽区')
    overlay.flushFrames()
    assert.equal(overlay.bodyAttributes.has('data-window-drag-recall'), false, '脉冲必须在下一次重算后清除')

    overlay.hover()
    overlay.render()
    assert.equal(overlay.bodyAttributes.get('data-window-drag-recall'), '', '展开改变几何后必须重新请求重算')
    overlay.flushFrames()
  } finally {
    overlay.restore()
  }

  // 非 darwin 平台没有窗口拖拽行（Windows 的标题栏在 frame 之外），不得写宿主标记
  const web = await mountOverlay({ platform: 'win32', response: rollingOnly })
  try {
    await web.ready()
    assert.equal(web.bodyAttributes.has('data-window-drag-recall'), false)
  } finally {
    web.restore()
  }
})

test('收缩态无按钮，点击或键盘进入长条形态作为无 hover 设备的入口', async () => {
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    const ringChip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip')!
    assert.equal(collectButtons(ringChip).length, 0, '收缩态不得出现任何按钮')
    assert.equal(ringChip.props.role, 'button', '收缩态本身是可点击的整体')
    assert.equal(ringChip.props.tabIndex, 0, '收缩态必须可聚焦，键盘用户才能进入')

    // 点击进入长条形态
    ringChip.props.onClick()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'),
      '点击收缩态必须升为长条形态',
    )
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'))

    // 键盘 Enter / 空格同样进入长条形态
    for (const key of ['Enter', ' ']) {
      const chip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip')!
      let prevented = false
      chip.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
      assert.equal(prevented, true, `${key} 必须阻止默认行为`)
      assert.ok(
        find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'),
        `${key} 必须升为长条形态`,
      )
      overlay.unhover()
    }
  } finally {
    overlay.restore()
  }
})

test('圆环在无数据时只画底轨，查询失败时文字显示失败标记', async () => {
  // 尚无数据：配置已读到但首次查询还没落地
  const pending = await mountOverlay({ response: () => new Promise<Response>(() => {}) })
  try {
    await pending.ready()
    const ring = find(pending.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring')!
    const circles: Element[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node !== 'object' || node === null) return
      const element = node as Element
      if (element.type === 'circle') circles.push(element)
      element.children?.forEach(walk)
    }
    walk(ring)
    assert.equal(circles.length, 1, '无数据时只有底轨，不画进度弧')
    assert.ok(
      find(pending.render(), node => node.type === 'span' && node.children[0] === 'Go-…'),
      '无数据时文字为占位符',
    )
  } finally {
    pending.restore()
  }

  // 查询失败：圆环保留底轨，文字给出失败标记
  const failed = await mountOverlay({
    response: async () => new Response(JSON.stringify({ ok: false, code: 'AUTH', message: 'x' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  })
  try {
    await failed.ready()
    assert.ok(
      find(failed.render(), node => node.type === 'span' && node.children[0] === 'Go-⚠'),
      '查询失败时收缩态文字显示失败标记',
    )
  } finally {
    failed.restore()
  }
})

test('展开与收起按钮的箭头方向相反，作为形态的双向提示', async () => {
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    overlay.hover()
    // 长条形态：箭头指向外（展开）。先取值再切换形态——每次 render 都返回新树。
    const arrowPath = () => find(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'expand')!,
      node => node.type === 'path',
    )!
    const expandD = arrowPath().props.d
    assert.equal(expandD, 'M9 15L15 9M10.5 9H15V13.5', '展开箭头指向外')

    // 完整形态：箭头指向内（收起）
    overlay.toggleFull()
    const collapseD = arrowPath().props.d
    assert.equal(collapseD, 'M15 9L9 15M13.5 15H9V10.5', '收起箭头指向内')
    assert.notEqual(collapseD, expandD, '两种形态的箭头方向必须不同')
  } finally {
    overlay.restore()
  }
})

test('展开按钮在长条与完整面板之间切换，收起后指针移出才回收缩态', async () => {
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    overlay.hover()
    // 长条形态：按钮为「展开」，图标箭头指向外，不写任何持久化键
    let expand = find(overlay.render(), node =>
      node.props['data-opencode-go-live-overlay'] === 'expand')!
    assert.equal(expand.props['aria-label'], overlay.dictionary.expandOverlay)
    assert.equal(expand.props['aria-pressed'], false)
    assert.equal(overlay.stored.get('opencode-go-live.overlay.expanded') ?? null, null, '形态不持久化')

    // 点击展开：进入完整面板，按钮变为「收起」
    expand.props.onClick()
    let tree = overlay.render()
    assert.ok(find(tree, node => node.props['data-opencode-go-live-overlay'] === 'panel'))
    assert.equal(find(tree, node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'), undefined)
    const collapse = find(tree, node => node.props['data-opencode-go-live-overlay'] === 'expand')!
    assert.equal(collapse.props['aria-label'], overlay.dictionary.collapseOverlay)
    assert.equal(collapse.props['aria-pressed'], true)

    // 完整态对鼠标移出不响应：便于读完三个窗口
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '完整态移出鼠标不得自动降级',
    )

    // 点「收起」回到长条形态；指针此时已在悬浮窗外，再移出即回收缩态
    collapse.props.onClick()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'), '收起后回到长条形态')
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'ring-chip'),
      '收起后移出指针回到收缩态',
    )
  } finally {
    overlay.restore()
  }
})

test('展开面板可调整大小并受最小与最大尺寸限制，尺寸跨挂载保持', async () => {
  const overlay = await mountOverlay({ response: rollingOnly })
  try {
    await overlay.ready()
    overlay.hover()
    overlay.toggleFull()
    let tree = overlay.render()
    let panel = find(tree, node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 264, '默认宽度')
    assert.equal(panel.props.style.height, undefined, '未调整过时高度随内容自适应')
    // 边框盒尺寸：写入的宽高与 getBoundingClientRect 同一坐标系，开始调整大小不跳变
    assert.equal(panel.props.style.boxSizing, 'border-box')

    // 手柄按下必须阻止冒泡：否则会同时触发锚点的移动拖拽
    let stopped = false
    const handle = find(tree, node => node.props['data-opencode-go-live-overlay'] === 'resize')!
    assert.equal(handle.props['aria-label'], overlay.dictionary.resizeOverlay)
    handle.props.onPointerDown({
      clientX: 300, clientY: 300,
      currentTarget: { offsetParent: { getBoundingClientRect: () => ({ width: 264, height: 100 }) } },
      stopPropagation: () => { stopped = true }, preventDefault() {},
    })
    assert.equal(stopped, true)
    assert.equal(overlay.windowListenerCount('pointermove'), 1, '调整大小只注册自己的监听')

    // 拖动 60×40 → 尺寸同步变化
    overlay.dispatchWindow('pointermove', { clientX: 360, clientY: 340 })
    panel = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 324)
    assert.equal(panel.props.style.height, 140)

    // 调整期间指针移出锚点不得收起
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'))

    // 上限：视口内的最大尺寸
    overlay.dispatchWindow('pointermove', { clientX: 3000, clientY: 3000 })
    panel = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 480)
    assert.equal(panel.props.style.height, 520)

    // 下限：不得小于最小尺寸
    overlay.dispatchWindow('pointermove', { clientX: -3000, clientY: -3000 })
    panel = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 200)
    assert.equal(panel.props.style.height, 120)

    overlay.dispatchWindow('pointerup', {})
    assert.equal(overlay.windowListenerCount('pointermove'), 0, '调整结束必须移除监听')
    assert.deepEqual(
      JSON.parse(overlay.stored.get('opencode-go-live.overlay.size')!),
      { width: 200, height: 120 },
    )
  } finally {
    overlay.restore()
  }

  // 越界的历史尺寸在挂载时收敛到边界内，键盘调整同样受钳制
  const restored = await mountOverlay({
    response: rollingOnly,
    seed: { 'opencode-go-live.overlay.size': JSON.stringify({ width: 9999, height: 5 }) },
  })
  try {
    await restored.ready()
    restored.hover()
    restored.toggleFull()
    let panel = find(restored.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 480, '越界宽度按最大尺寸收敛')
    assert.equal(panel.props.style.height, 120, '越界高度按最小尺寸收敛')

    const handle = find(restored.render(), node => node.props['data-opencode-go-live-overlay'] === 'resize')!
    handle.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
    panel = find(restored.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel')!
    assert.equal(panel.props.style.width, 464)
    assert.deepEqual(
      JSON.parse(restored.stored.get('opencode-go-live.overlay.size')!),
      { width: 464, height: 120 },
    )
  } finally {
    restored.restore()
  }
})

test('刷新按钮只在请求进行中禁用，动画一结束即可再次点击', async () => {
  const clock = { now: Date.UTC(2026, 9, 12, 6, 0, 0) }
  let calls = 0
  const overlay = await mountOverlay({
    clock,
    response: async () => {
      calls += 1
      return new Response(JSON.stringify({
        ok: true,
        checkedAt: new Date(clock.now).toISOString(),
        usage: {
          rolling: {
            status: 'ok',
            // 每次查询返回不同的用量，用于断言刷新结果确实进了面板
            percent: calls === 1 ? 10 : 55 + calls,
            resetsAt: new Date(clock.now + 3_600_000).toISOString(),
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    await overlay.ready()
    assert.equal(calls, 1, '挂载时查询一次')
    overlay.hover()
    // 完整面板才注入旋转动画的 keyframes
    overlay.toggleFull()
    assert.ok(
      find(overlay.render(), node => node.type === 'span' && node.children[0] === '10%'),
      '首次查询结果必须渲染',
    )

    /** 按稳定标记取按钮，避免随状态变化的 aria-label 影响定位。 */
    const refreshButton = () => find(overlay.render(), node =>
      node.props['data-opencode-go-live-overlay'] === 'refresh')!

    // 查询落地后立刻可点：不再有 10 秒节流窗口
    assert.equal(calls, 1)
    assert.equal(refreshButton().props.disabled, false, '查询结束后按钮必须立刻可点')
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refresh)
    assert.equal(find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner'), undefined)
    assert.equal(refreshButton().children[0], '⟳')

    // 点击后立即进入「刷新中」：禁用、显示进行中文案，图标换成旋转中的加载动画
    refreshButton().props.onClick()
    const busy = refreshButton()
    assert.equal(busy.props.disabled, true, '请求进行中按钮必须禁用')
    assert.equal(busy.props['aria-label'], overlay.dictionary.refreshing)
    assert.equal(busy.props['aria-busy'], true)
    const spinner = find(busy, node => node.props['data-opencode-go-live-overlay'] === 'spinner')
    assert.ok(spinner, '刷新中必须显示加载动画图标')
    assert.match(spinner!.props.style.animation, /^opencode-go-live-spin /, '加载图标必须挂上旋转动画')
    // keyframes 随面板注入，动画名由插件自带（宿主没有可直接复用的全局 keyframes）
    assert.ok(
      find(overlay.render(), node => node.type === 'style' && node.children?.[0] === '@keyframes opencode-go-live-spin{to{transform:rotate(360deg)}}'),
      '面板必须注入旋转动画的 keyframes',
    )

    // 响应落地：请求数增加、新数据渲染、动画退出、按钮立刻回到可点状态
    await settle()
    overlay.render()
    await settle()
    const tree = overlay.render()
    assert.equal(calls, 2, '点击必须重新查询')
    assert.ok(
      find(tree, node => node.type === 'span' && node.children[0] === '57%'),
      '刷新结果必须渲染到面板',
    )
    assert.equal(find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner'), undefined)
    assert.equal(refreshButton().children[0], '⟳')
    assert.equal(refreshButton().props['aria-busy'], false)
    assert.equal(refreshButton().props.disabled, false, '动画结束即恢复可点')
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refresh)

    // 关键回归点：动画结束后立刻再点（不推进时钟）必须再发一次请求
    clock.now += 1_000
    refreshButton().props.onClick()
    assert.equal(refreshButton().props.disabled, true)
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refreshing)
    await settle()
    overlay.render()
    await settle()
    overlay.render()
    assert.equal(calls, 3, '动画结束后立刻再点必须再次查询，而不是被节流吞掉')
  } finally {
    overlay.restore()
  }
})

test('刷新请求异常挂起时「刷新中」有兜底上限，不会永久锁死按钮', async () => {
  // client bundle 的 REFRESHING_MAX_MS 平行定义。
  const REFRESHING_MAX_MS = 20_000
  const clock = { now: Date.UTC(2026, 9, 12, 6, 0, 0) }
  const overlay = await mountOverlay({
    clock,
    // 永不落地的响应：模拟宿主或 HTTP 层挂起，客户端查询本身没有超时
    response: () => new Promise<Response>(() => {}),
  })
  try {
    await overlay.ready()
    // 刷新按钮只存在于展开面板，先悬浮展开（首次查询仍在挂起）。
    overlay.hover()
    const refreshButton = () => find(overlay.render(), node =>
      node.props['data-opencode-go-live-overlay'] === 'refresh')!
    // 首次查询挂起时还没有 lastQueryAt，按钮仍可点
    assert.equal(refreshButton().props.disabled, false)

    refreshButton().props.onClick()
    assert.equal(refreshButton().props.disabled, true)
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refreshing)
    assert.ok(
      find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner'),
      '挂起期间必须保持加载动画',
    )

    // 兜底上限之前：请求仍在挂起，按钮保持禁用、动画继续
    clock.now += REFRESHING_MAX_MS - 1_000
    overlay.flushTimers()
    assert.equal(refreshButton().props.disabled, true, '请求仍在挂起时按钮必须保持禁用')
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refreshing)
    assert.ok(find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner'))

    // 兜底上限到期：按钮恢复可点、动画退出，迟到结果不会把禁用态带回来
    clock.now += 2_000
    overlay.flushTimers()
    assert.equal(refreshButton().props.disabled, false, '请求挂起不得永久锁死按钮')
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refresh)
    assert.equal(
      find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner'),
      undefined,
      '超时退出加载动画',
    )
    assert.equal(refreshButton().children[0], '⟳')
  } finally {
    overlay.restore()
  }
})

test('系统开启减少动态效果时加载图标不旋转但仍表示进行中', async () => {
  const clock = { now: Date.UTC(2026, 9, 12, 6, 0, 0) }
  const overlay = await mountOverlay({
    clock,
    reducedMotion: true,
    response: () => new Promise<Response>(() => {}),
  })
  try {
    await overlay.ready()
    overlay.hover()
    const refreshButton = () => find(overlay.render(), node =>
      node.props['data-opencode-go-live-overlay'] === 'refresh')!
    refreshButton().props.onClick()
    const spinner = find(refreshButton(), node => node.props['data-opencode-go-live-overlay'] === 'spinner')
    assert.ok(spinner, '减少动态效果下仍显示加载图标')
    assert.equal(spinner!.props.style.animation, undefined, '减少动态效果下不得挂旋转动画')
    assert.equal(refreshButton().props['aria-label'], overlay.dictionary.refreshing)
  } finally {
    overlay.restore()
  }
})

test('更新时间使用 24 小时制，无法解析的时间戳隐藏该行', async () => {
  // 默认区域是 en-US 时 `toLocaleTimeString()` 会输出「2:30:05 PM」，
  // 因此这里断言与本地时分秒完全一致的 24 小时制文本，且不含 AM/PM 标记。
  const checkedAt = '2026-10-12T06:30:05.000Z'
  const overlay = await mountOverlay({
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt,
      usage: { rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await overlay.ready()
    overlay.hover()
    overlay.toggleFull()
    const tree = overlay.render()
    const local = new Date(checkedAt)
    const expected = [local.getHours(), local.getMinutes(), local.getSeconds()]
      .map(value => String(value).padStart(2, '0')).join(':')
    const footer = find(tree, node => typeof node.children?.[0] === 'string'
      && node.children[0].startsWith(overlay.dictionary.updatedAtPrefix))!
    assert.ok(footer, '面板必须渲染更新时间行')
    assert.equal(footer.children[0], `${overlay.dictionary.updatedAtPrefix} ${expected}`)
    assert.doesNotMatch(String(footer.children[0]), /[AP]\.?M/i, '不得出现 12 小时制的 AM/PM 标记')
  } finally {
    overlay.restore()
  }

  // 时间戳不可解析：隐藏该行，而不是渲染 "Invalid Date"
  const broken = await mountOverlay({
    response: async () => new Response(JSON.stringify({
      ok: true,
      checkedAt: 'not-a-timestamp',
      usage: { rolling: { status: 'ok', percent: 10 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  try {
    await broken.ready()
    broken.hover()
    assert.equal(
      find(broken.render(), node => typeof node.children?.[0] === 'string'
        && node.children[0].startsWith(broken.dictionary.updatedAtPrefix)),
      undefined,
      '无法解析的时间戳必须隐藏更新时间行',
    )
  } finally {
    broken.restore()
  }
})
