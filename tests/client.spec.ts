import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseUsageResponse } from '../src/balance.js'

/** 等待客户端的异步读取与 React 状态更新完成。 */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * 浏览器全局替身。
 * client bundle 的 factory 在 `node:vm` 上下文里执行，因此 fetch、AbortController
 * 与定时器都必须显式注入；存储只保留在内存中。
 */
function browserSandbox(options: { response?: () => Promise<Response> } = {}) {
  const stored = new Map<string, string>()
  const session = new Map<string, string>()
  const windowListeners = new Map<string, ((event: any) => void)[]>()
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
      addEventListener(type: string, handler: (event: any) => void) {
        windowListeners.set(type, [...windowListeners.get(type) ?? [], handler])
      },
      removeEventListener(type: string, handler: (event: any) => void) {
        windowListeners.set(type, (windowListeners.get(type) ?? []).filter(item => item !== handler))
      },
    },
    fetch: options.response ?? (async () => new Response('{}', { status: 200 })),
    AbortController,
    setInterval,
    clearInterval,
  }
  return {
    sandbox,
    stored,
    session,
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
  const state: unknown[] = []
  const effects: { deps: unknown[]; dispose?: () => void }[] = []
  const pending: { index: number; run: () => () => void; deps: unknown[] }[] = []
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
    useEffect(run: () => () => void, deps: unknown[]) {
      const index = cursor++
      const previous = effects[index]
      if (previous === undefined || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.dispose?.()
        pending.push({ index, run, deps })
      }
    },
  }
  return {
    React,
    render(component: (props: { t: (key: string) => string }) => Element | null, props: { t: (key: string) => string }): Element | null {
      cursor = 0
      const tree = component(props)
      for (const next of pending.splice(0)) effects[next.index] = { deps: next.deps, dispose: next.run() }
      return tree
    },
    dispose() { for (const effect of effects) effect?.dispose?.() },
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
    /** 常驻锚点：承载悬浮判定与徽章整块拖拽。 */
    anchor: (tree?: unknown): Element => find(
      tree ?? harness.render(component!, { t: (key: string) => dictionary[key]! }),
      node => node.props?.style?.position === 'absolute' && typeof node.props?.onMouseEnter === 'function',
    )!,
    /** 鼠标进入锚点：徽章是默认形态，展开由悬浮驱动。 */
    hover: () => { const node = find(harness.render(component!, { t: (key: string) => dictionary[key]! }), n => n.props?.style?.position === 'absolute' && typeof n.props?.onMouseEnter === 'function')!; node.props.onMouseEnter() },
    /** 鼠标离开锚点：自动回到徽章。 */
    unhover: () => { const node = find(harness.render(component!, { t: (key: string) => dictionary[key]! }), n => n.props?.style?.position === 'absolute' && typeof n.props?.onMouseLeave === 'function')!; node.props.onMouseLeave() },
    dispatchWindow: browser.dispatchWindow,
    windowListenerCount: browser.windowListenerCount,
    setOverlayEnabled: (value: boolean) => { overlayEnabled = value },
    emitSettingsChange: () => {
      for (const listener of listeners.get('settings/document-updated') ?? []) listener('llm-opencode-go-live')
    },
    restore: () => { harness.dispose() },
  }
}

test('徽章是默认形态，悬浮展开三个计费窗口，移开自动收起', async () => {
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
    const chip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip')
    assert.ok(chip, '配置读到后默认渲染徽章')

    // 悬浮展开完整面板：三个窗口行各有一条进度条底轨
    overlay.hover()
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
    assert.equal(tracks.length, 3)

    // 移开鼠标自动收起为徽章
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'))
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
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'),
      '配置里没有该字段时必须默认渲染徽章',
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
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'),
      '重新打开开关且鼠标不在悬浮窗上时应显示徽章',
    )
  } finally {
    overlay.restore()
  }
})

test('徽章显示五小时进度条与用量百分比，固定按钮默认不固定且图标随状态切换', async () => {
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
    const chip = find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip')!
    // 进度条：5 小时窗口的已用占比
    const track = find(chip, node => node.props?.style?.height === 4)
    assert.equal(track?.props.style.width, 56)
    assert.ok(find(track, node => node.props?.style?.width === '38%'))
    assert.ok(find(chip, node => node.type === 'span' && node.children[0] === '38%'))
    // 徽章只保留主体与固定按钮：最小化按钮已被悬浮展开取代
    const chipButtons: Element[] = []
    const collectButtons = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(collectButtons); return }
      if (typeof node !== 'object' || node === null) return
      const element = node as Element
      if (element.type === 'button') chipButtons.push(element)
      element.children?.forEach(collectButtons)
    }
    collectButtons(chip)
    assert.deepEqual(
      chipButtons.map(button => button.props['aria-label']).sort(),
      [overlay.dictionary.pinOverlay, overlay.dictionary.restoreOverlay].sort(),
    )

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

test('徽章与面板拖拽受固定状态门控，拖动后的点击不触发展开', async () => {
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

    // 未固定：徽章整块可拖
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 1)
    overlay.dispatchWindow('pointermove', { clientX: 260, clientY: 240 })
    overlay.dispatchWindow('pointerup', {})
    assert.equal(overlay.windowListenerCount('pointermove'), 0, '拖拽结束必须移除监听')
    assert.equal(overlay.render()?.props.style.left, 160, '拖拽必须更新锚点位置')

    // 拖拽余波内的点击属于移动手势，不得展开面板
    find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.restoreOverlay)!.props.onClick()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'))

    // 固定后：徽章拖拽不再生效
    find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.pinOverlay)!.props.onClick()
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 0, '固定后徽章不得注册拖拽监听')

    // 解除固定后：悬浮展开的面板同样可拖（事件冒泡到锚点）
    overlay.hover()
    overlay.render()
    find(overlay.render(), node => node.type === 'button' && node.props['aria-label'] === overlay.dictionary.unpinOverlay)!.props.onClick()
    overlay.anchor(overlay.render()).props.onPointerDown(dragStart)
    assert.equal(overlay.windowListenerCount('pointermove'), 1, '解除固定后标题栏拖拽必须恢复')

    // 拖拽期间指针越过锚点边界（拖到视口边缘）不得收起
    overlay.unhover()
    assert.ok(
      find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'panel'),
      '拖拽期间不得收起面板',
    )
    // 拖拽结束后恢复悬浮收起语义
    overlay.dispatchWindow('pointerup', {})
    overlay.unhover()
    assert.ok(find(overlay.render(), node => node.props['data-opencode-go-live-overlay'] === 'chip'))
  } finally {
    overlay.restore()
  }
})
