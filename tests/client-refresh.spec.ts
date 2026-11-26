import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** 等待客户端的异步请求与 React 状态更新完成。 */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

interface Element {
  type: string
  props: Record<string, any>
  children: unknown[]
}

/** 在纯对象元素树中寻找一个指定节点。 */
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as Element
  if (predicate(element)) return element
  return (element.children ?? []).map(child => find(child, predicate)).find(Boolean)
}

/** 按文案定位按钮；`t` 函数来自词典，因此不与具体语言耦合。 */
function buttonLabeled(tree: unknown, label: string): Element | undefined {
  return find(tree, node => node.type === 'button' && node.children[0] === label)
}

/** 卡片在 fetch 上的调用记录。 */
interface FetchCall {
  url: string
  method: string
}

/**
 * 在 `node:vm` 沙箱里加载真实 client bundle，并返回最小可用的挂载面。
 *
 * 只桩掉 React（用对象树代替 DOM）与宿主 ctx 中被本功能触达的服务；
 * 目录刷新走宿主路由，因此用 fetch 替身捕获请求并注入响应包。
 */
async function mountCard(
  envelope: unknown,
  overrideFetch?: () => Promise<Response>,
  /** 卡片里展示的模型；默认只有一个 m1。 */
  models: { id: string; name: string }[] = [{ id: 'm1', name: 'M1' }],
): Promise<{
  render: () => Element
  dictionary: Record<string, string>
  calls: FetchCall[]
  slots: string[]
}> {
  let registration: { id: string; factory: (require: (name: string) => unknown) => any } | undefined
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const calls: FetchCall[] = []
  const sandbox: Record<string, any> = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      requestAnimationFrame: (callback: () => void) => { callback(); return 1 },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    document: {
      documentElement: { dataset: { platform: 'darwin' } },
      body: { setAttribute: () => undefined, removeAttribute: () => undefined },
    },
    // 目录刷新请求与其它路由共用同一个 `fetch`：按 URL 区分并记录方法与地址。
    fetch: overrideFetch ?? (async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    Response,
    AbortController,
    setInterval,
    clearInterval,
    // 卡片的瞬态提示会挂一个 3.2s 定时器；沙箱里让它不阻塞测试进程退出。
    setTimeout: (callback: () => void, delay?: number) => {
      const timer = setTimeout(callback, delay)
      timer.unref?.()
      return timer
    },
    clearTimeout,
  }
  sandbox.window.__ModuleLoader__ = { load: (entry: typeof registration) => { registration = entry } }
  runInNewContext(client, sandbox)
  assert.ok(registration, 'client bundle 应通过 __ModuleLoader__ 注册自己')

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
  const extension = registration!.factory(() => React)

  const components = new Map<string, (props: { t: (key: string) => string }) => Element>()
  const slots: string[] = []
  let dictionary: Record<string, string> = {}
  const ctx = {
    effect: (setup: () => () => void) => { setup() },
    locale: {
      register: (_ns: string, copy: { zh: Record<string, string> }) => {
        dictionary = copy.zh
        return () => {}
      },
    },
    slots: {
      inject: (name: string, register: () => void) => { slots.push(name); register() },
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
              value: { apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY', showBalanceOverlay: true },
              revision: 1,
            }],
          },
        }),
      },
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: { groups: [{ id: 'opencode-go-live', models }], failures: [] },
        }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: { OPENCODE_GO_LIVE_API_KEY: { configured: true, writable: true } } }),
      },
      $on: () => () => undefined,
    },
  }
  extension.apply(ctx)
  assert.deepEqual(slots, ['settings.models.footer', 'shell.overlay'])
  const component = components.get('settings.models.footer')
  assert.ok(component, '应注册模型提供商卡片')

  /** 执行一次渲染，并运行这次渲染新注册的 effect。 */
  function render(): Element {
    cursor = 0
    const tree = component!({ t: (key: string) => dictionary[key]! })
    for (const next of pending.splice(0)) {
      effects[next.index] = { deps: next.deps, dispose: next.run() }
    }
    return tree
  }
  render()
  await settle()
  return { render, dictionary, calls, slots }
}

test('模型提供商卡片提供刷新按钮，点击后以 POST 调用主动刷新路由', async () => {
  const { render, dictionary, calls } = await mountCard({
    ok: true, checkedAt: new Date().toISOString(), total: 3,
    added: ['a', 'b'], updated: ['d'], removed: ['c'],
  })
  let tree = render()
  const button = buttonLabeled(tree, dictionary.refreshModels)
  assert.ok(button, '卡片应渲染「刷新模型列表」按钮，且位于模型提供商卡片内')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.disabled, false)

  button.props.onClick()
  tree = render()
  // 请求未返回前按钮进入刷新态并被禁用，避免连点叠加请求。
  assert.equal(buttonLabeled(tree, dictionary.refreshModelsBusy)?.props.disabled, true)
  await settle()
  await settle()

  // 卡片挂载时还会读一次套餐额度（GET /limits）；这里只关心主动刷新那一笔。
  assert.deepEqual(calls.filter(call => call.url === '/api/opencode-go-live/refresh'),
    [{ url: '/api/opencode-go-live/refresh', method: 'POST' }])
  tree = render()
  const expected = dictionary.refreshResult
    .replace('{a}', '2')
    .replace('{u}', '1')
    .replace('{r}', '1')
  const toast = find(tree, node => node.type === 'div' && node.props.role === 'status' && node.children[0] === expected)
  assert.ok(toast, `应显示变化提示：${expected}`)
  // 提示是瞬态浮层：固定定位、不拦截点击。
  assert.equal(toast.props.style.position, 'fixed')
  assert.equal(toast.props.style.pointerEvents, 'none')
  // 刷新结束后按钮恢复可点。
  assert.equal(buttonLabeled(tree, dictionary.refreshModels)?.props.disabled, false)
})

test('刷新结果没有变化时提示「已是最新」而不是三个零', async () => {
  const { render, dictionary } = await mountCard({
    ok: true, checkedAt: new Date().toISOString(), total: 1, added: [], updated: [], removed: [],
  })
  let tree = render()
  buttonLabeled(tree, dictionary.refreshModels)!.props.onClick()
  await settle()
  await settle()
  tree = render()
  assert.ok(find(tree, node => node.type === 'div' && node.children[0] === dictionary.refreshUnchanged))
})

test('刷新失败时提示保旧目录，且不渲染变化数字', async () => {
  const { render, dictionary } = await mountCard({
    ok: false, code: 'REFRESH_FAILED', message: 'boom',
  })
  let tree = render()
  buttonLabeled(tree, dictionary.refreshModels)!.props.onClick()
  await settle()
  await settle()
  tree = render()
  const failed = find(tree, node => node.type === 'div' && node.children[0] === dictionary.refreshFailed)
  assert.ok(failed, '失败时应提示已保留上次成功目录')
  assert.equal(failed.props.style.color, 'var(--dsw-alias-state-error-primary)')
  assert.equal(buttonLabeled(tree, dictionary.refreshModels)?.props.disabled, false)
})

test('响应包结构异常时按失败处理，不把异常结构渲染成数字', async () => {
  const { render, dictionary } = await mountCard({ ok: true, added: 'nope' })
  let tree = render()
  buttonLabeled(tree, dictionary.refreshModels)!.props.onClick()
  await settle()
  await settle()
  tree = render()
  assert.ok(find(tree, node => node.type === 'div' && node.children[0] === dictionary.refreshFailed))
})

test('网络失败（旧宿主未注册该路由）时按失败处理', async () => {
  const { render, dictionary } = await mountCard(undefined, async () => { throw new TypeError('network down') })
  let tree = render()
  buttonLabeled(tree, dictionary.refreshModels)!.props.onClick()
  await settle()
  await settle()
  tree = render()
  assert.ok(find(tree, node => node.type === 'div' && node.children[0] === dictionary.refreshFailed))
  assert.equal(buttonLabeled(tree, dictionary.refreshModels)?.props.disabled, false)
})

test('模型行并列显示三档额度，缺失档位与无额度模型显示横杠', async () => {
  const { render, dictionary } = await mountCard({
    ok: true, checkedAt: new Date().toISOString(),
    plans: ['go', 'go-plus', 'go-teams'],
    limits: {
      // 三档都有：15 / 60 / 20
      full: { go: 15, 'go-plus': 60, 'go-teams': 20 },
      // 只给 Go：其余两档显示横杠
      partial: { go: 30 },
      // null 表示不计量（免费模型）
      free: { go: null, 'go-plus': null, 'go-teams': null },
    },
  }, undefined, [{ id: 'full', name: 'Full' }, { id: 'partial', name: 'Partial' }, { id: 'free', name: 'Free' }])
  let tree = render()
  // 行内只渲染 name；本用例的三个模型 name 分别是 Full / Partial / Free。
  const li = (name: string) => find(tree, node =>
    node.type === 'li' && node.children?.includes(name))

  const fullRow = li('Full')
  assert.ok(fullRow, '应有 full 模型行')
  const fullText = JSON.stringify(fullRow)
  assert.ok(fullText.includes('$15'), `Go 档应显示 $15：${fullText}`)
  assert.ok(fullText.includes('$60'), 'Plus 档应显示 $60')
  assert.ok(fullText.includes('$20'), 'Teams 档应显示 $20')

  // 只统计额度那一行的文本：模型名里的破折号不算。
  const quotaText = (row) => find(row, node => node.type === 'div' && node.children.length === 1
    && typeof node.children[0] === 'string' && node.children[0].includes('·'))?.children[0]
  const partialText = quotaText(li('Partial'))
  assert.ok(partialText.includes('$30'), `Go 档应显示 $30：${partialText}`)
  assert.equal((partialText.match(/—/g) ?? []).length, 2, `缺失档位应显示两个横杠：${partialText}`)

  const freeText = quotaText(li('Free'))
  assert.equal((freeText.match(/∞/g) ?? []).length, 3, `免费模型三档都应显示 ∞：${freeText}`)
})

test('模型列表按厂商分组，缺归属的归入「其他」并排在最后', async () => {
  const { render, dictionary } = await mountCard({
    ok: true, checkedAt: new Date().toISOString(),
    plans: ['go', 'go-plus', 'go-teams'],
    limits: {},
    vendors: { a: 'moonshotai', b: 'moonshotai', c: 'openai' },
  }, undefined, [
    { id: 'a', name: 'Kimi K3' },
    { id: 'b', name: 'Kimi K3.1 Pro' },
    { id: 'c', name: 'GPT-6 Luna' },
    { id: 'd', name: 'Mystery Model' }, // 无厂商
  ])
  const tree = render()

  // 三个分组标题：Moonshot(2)、OpenAI(1)、其他(1)
  const headers = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node === null) return
    if (typeof node.children?.[0] === 'string' && /·\s*\d+$/.test(node.children[0])) headers.push(node.children[0])
    walk(node.children)
  }
  walk(tree)

  assert.deepEqual(headers, ['Moonshot · 2', 'OpenAI · 1', `${dictionary.vendorOther} · 1`],
    `分组应按模型数降序、其他组排最后，实际 ${JSON.stringify(headers)}`)
})

test('没有厂商数据时不分组，仍平铺显示全部模型', async () => {
  const { render } = await mountCard({
    ok: true, checkedAt: new Date().toISOString(), plans: ['go', 'go-plus', 'go-teams'], limits: {},
  })
  const tree = render()
  const headers = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node === null) return
    if (typeof node.children?.[0] === 'string' && /·\s*\d+$/.test(node.children[0])) headers.push(node.children[0])
    walk(node.children)
  }
  walk(tree)
  // 没有 vendors 映射时所有模型都进「其他」，只有一个分组标题。
  assert.equal(headers.length, 1, `应只有一个分组标题，实际 ${JSON.stringify(headers)}`)
})
