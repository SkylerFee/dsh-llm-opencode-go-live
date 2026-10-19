import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import * as Live from '../src/index.js'
import { OPENCODE_GO_USAGE_URL } from '../src/balance.js'
import { JsonCatalogStore } from '../src/store.js'
import { transformProvider } from '../src/transform.js'

/** 装好的余额路由处理器；测试直接调用登记的 fetch 面。 */
type BalanceRouteHandler = (request: Request) => Promise<Response>

/** 缓存目录里唯一模型的 id。 */
const MODEL_ID = 'deepseek-v4-flash'

/**
 * 可撤销凭据替身：初始按 `initial` 决定，`revoke()` / `grant()` 后按调用立即生效。
 *
 * 宿主线 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2` 的 `PiAiAdapter.listModels` 会先解析
 * API Key，解析失败且 code 为 `MISSING_CREDENTIAL` 时直接返回空数组；宿主内置路由共用
 * 同一个适配器，这是宿主既有行为。因此挂载期要用可用凭据让模型可见，请求期再撤销凭据
 * 把请求拦在凭据阶段（不触网）。
 */
function revocableCredentials(initial: 'present' | 'missing' = 'present'): {
  resolve: () => Promise<{ value: string } | undefined>
  revoke: () => void
  grant: () => void
} {
  let available = initial === 'present'
  return {
    resolve: async () => (available ? { value: 'sk-test-secret' } : undefined),
    revoke: () => { available = false },
    grant: () => { available = true },
  }
}

type CredentialDouble = ReturnType<typeof revocableCredentials>

/**
 * 挂载 LlmRuntime 与 Live 插件；缓存目录里只有 {@link MODEL_ID} 一个模型。
 * `llm/adapters-updated` 的监听在插件挂载前建立，便于按序列推导事件计数。
 */
async function mountCachedCatalog(credentials: CredentialDouble): Promise<{
  ctx: Context
  fiber: { dispose: () => Promise<void> }
  events: string[]
  dispose: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  const cachePath = join(directory, 'catalog.json')
  const models = transformProvider({ models: {
    [MODEL_ID]: { tool_call: true, limit: { context: 128_000, output: 8_192 } },
  } }).models
  await new JsonCatalogStore(cachePath).save({
    version: 1, checkedAt: new Date(0).toISOString(), models, diagnostics: [],
  })
  const ctx = new Context()
  ctx.provide('credentials', credentials as never)
  await ctx.plugin(LlmRuntime)
  const events: string[] = []
  ctx.on('llm/adapters-updated', () => { events.push(`emit#${events.length + 1}`) })
  const fiber = await ctx.plugin(Live, {
    apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
    catalog: { cachePath, refreshOnStart: false, refreshIntervalMs: 0 },
  })
  return {
    ctx,
    fiber,
    events,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true })
    },
  }
}

/** 等待目录快照恢复发布第二次拓扑通知（第一次来自 registerAdapter 提交路由）。 */
async function waitForCatalogRestore(events: string[]): Promise<void> {
  for (let attempt = 0; events.length < 2 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 轮询模型列表直到非空（快照恢复是异步的）。 */
async function waitForModels(ctx: Context): Promise<{ id: string }[]> {
  let listed = await ctx.llm.listModels(Live.ROUTE_ID)
  for (let attempt = 0; listed.length === 0 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    listed = await ctx.llm.listModels(Live.ROUTE_ID)
  }
  return listed
}

/**
 * 挂载真实 Cordis 树并把 `connection` 服务替换为登记表替身。
 * @returns 上下文、已登记路由表与恢复函数。
 */
async function mountWithBalanceRoute(): Promise<{
  ctx: Context
  routes: Map<string, BalanceRouteHandler>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes = new Map<string, BalanceRouteHandler>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch: BalanceRouteHandler }) => {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  await ctx.plugin(LlmRuntime)
  return {
    ctx,
    routes,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

test('Cordis 挂载后恢复模型并在请求时拒绝缺失凭据', async () => {
  // 挂载期凭据可用：宿主线适配器只有在凭据可解析时才声明模型（快照恢复才可见）。
  const credentials = revocableCredentials()
  const { ctx, fiber, events, dispose } = await mountCachedCatalog(credentials)
  try {
    assert.deepEqual(ctx.llm.listProviders(), [{ id: Live.ROUTE_ID, name: Live.DISPLAY_NAME }])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
    assert.throws(
      () => ctx.llm.registerAdapter([Live.ROUTE_ID], {} as never),
      (error: unknown) => error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER',
    )

    const listed = await waitForModels(ctx)
    assert.deepEqual(listed.map(model => model.id), [MODEL_ID])
    // 事件推导：emit#1 = registerAdapter 提交路由（同步）；emit#2 = 快照恢复经
    // onCatalogUpdated → registration.replace([ROUTE_ID]) 再发布一次（异步）。
    // 凭据解析本身不发布拓扑通知，所以恰好 2 次、且没有第三次。
    await waitForCatalogRestore(events)
    assert.deepEqual(events, ['emit#1', 'emit#2'])

    // 请求前撤销凭据：请求链路按调用解析凭据，以 MISSING_CREDENTIAL 结束而不是触网。
    credentials.revoke()
    const prepared = await ctx.llm.prepareCall({ provider: Live.ROUTE_ID, model: MODEL_ID })
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-1), {
      type: 'finish', reason: {
        kind: 'error', failure: {
          code: 'MISSING_CREDENTIAL',
          message: 'llm-opencode-go-live: missing credential OPENCODE_GO_LIVE_API_KEY',
        },
      },
    })
    await fiber.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
  } finally {
    await dispose()
  }
})

test('凭据未配置时适配器不对外声明模型（宿主线契约）', async () => {
  const credentials = revocableCredentials('missing')
  const { ctx, events, dispose } = await mountCachedCatalog(credentials)
  try {
    // 路由先注册：凭据门控只影响模型声明，不影响 provider 拓扑。
    assert.deepEqual(ctx.llm.listProviders(), [{ id: Live.ROUTE_ID, name: Live.DISPLAY_NAME }])
    // 等快照恢复完成（第二次拓扑通知），以排除"恢复尚未完成"这一替代解释：
    // 目录已恢复但模型仍为空，说明空白来自凭据门控。
    await waitForCatalogRestore(events)
    assert.deepEqual(await ctx.llm.listModels(Live.ROUTE_ID), [])
  } finally {
    await dispose()
  }
})

test('凭据恢复后模型可见：同一适配器按调用重新解析凭据', async () => {
  const credentials = revocableCredentials('missing')
  const { ctx, events, dispose } = await mountCachedCatalog(credentials)
  try {
    await waitForCatalogRestore(events)
    assert.deepEqual(await ctx.llm.listModels(Live.ROUTE_ID), [])

    credentials.grant()
    const listed = await waitForModels(ctx)
    assert.deepEqual(listed.map(model => model.id), [MODEL_ID])
    // 凭据恢复不发布新的拓扑通知：可见性完全由 listModels 内的凭据解析决定，
    // 因此事件序列仍只有挂载期的那两次。
    assert.deepEqual(events, ['emit#1', 'emit#2'])
  } finally {
    await dispose()
  }
})

test('余额路由带凭据查询上游并把归一化结果返回给浏览器', async () => {
  const { ctx, routes, dispose } = await mountWithBalanceRoute()
  const originalFetch = globalThis.fetch
  const upstream: { url: string; authorization: string | null }[] = []
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    upstream.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 42.5, resetsAt: '2026-10-04T08:00:00.000Z' },
        monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-01T00:00:00.000Z' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  try {
    ctx.provide('credentials', { resolve: async () => ({ value: 'sk-test-secret' }) } as never)
    const fiber = await ctx.plugin(Live, {
      apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
      catalog: { refreshOnStart: false, refreshIntervalMs: 0 },
    })
    const handler = routes.get(Live.BALANCE_ROUTE_PATH)
    assert.ok(handler, '插件必须在 connection 可用时登记余额路由')

    const response = await handler(new Request('http://127.0.0.1/api/opencode-go-live/balance'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    const envelope = await response.json() as Record<string, any>
    assert.equal(envelope.ok, true)
    assert.equal(envelope.usage.rolling.percent, 42.5)
    assert.equal(envelope.usage.monthly.status, 'rate-limited')
    assert.equal(envelope.usage.weekly, undefined)
    assert.ok(Number.isFinite(Date.parse(envelope.checkedAt)))
    assert.deepEqual(upstream, [{
      url: OPENCODE_GO_USAGE_URL,
      authorization: 'Bearer sk-test-secret',
    }])
    // 响应不得回显密钥。
    assert.ok(!JSON.stringify(envelope).includes('sk-test-secret'))

    // 卸载插件必须撤下路由，避免残留指向已释放运行时的处理器。
    await fiber.dispose()
    assert.equal(routes.has(Live.BALANCE_ROUTE_PATH), false)
  } finally {
    globalThis.fetch = originalFetch
    await dispose()
  }
})

test('凭据缺失时余额路由回答 MISSING_CREDENTIAL 而不请求上游', async () => {
  const { ctx, routes, dispose } = await mountWithBalanceRoute()
  const originalFetch = globalThis.fetch
  let upstreamCalls = 0
  globalThis.fetch = (async () => {
    upstreamCalls += 1
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch
  try {
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(Live, {
      apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
      catalog: { refreshOnStart: false, refreshIntervalMs: 0 },
    })
    const handler = routes.get(Live.BALANCE_ROUTE_PATH)
    assert.ok(handler)

    const response = await handler(new Request('http://127.0.0.1/api/opencode-go-live/balance'))
    const envelope = await response.json() as Record<string, any>
    assert.equal(response.status, 200)
    assert.equal(envelope.ok, false)
    assert.equal(envelope.code, 'MISSING_CREDENTIAL')
    assert.equal(upstreamCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    await dispose()
  }
})

test('没有 connection 服务时插件照常挂载且不登记余额路由', async () => {
  const ctx = new Context()
  try {
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(LlmRuntime)
    // 纯 CLI composition：没有浏览器载体，插件必须静默降级。
    const fiber = await ctx.plugin(Live, {
      apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
      catalog: { refreshOnStart: false, refreshIntervalMs: 0 },
    })
    assert.deepEqual(ctx.llm.listProviders(), [{ id: Live.ROUTE_ID, name: Live.DISPLAY_NAME }])
    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})
