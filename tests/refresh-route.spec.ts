import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Live from '../src/index.js'
import { OpenCodeGoLiveRuntime, diffCatalogs, refreshRoute } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { MemoryCatalogStore } from '../src/store.js'
import type { CatalogSnapshot } from '../src/store.js'
import type { SourceProvider } from '../src/source.js'
import { transformProvider } from '../src/transform.js'

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

/** 构造一份只含给定模型的快照，字段走真实的来源转换流程。 */
function snapshotOf(models: Record<string, {
  name?: string
  context?: number
  output?: number
  input?: ('text' | 'image')[]
  tool_call?: boolean
}>): CatalogSnapshot {
  const source = Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
    name: model.name,
    tool_call: model.tool_call ?? true,
    limit: { context: model.context ?? 128_000, output: model.output ?? 8_192 },
    ...(model.input === undefined ? {} : { modalities: { input: model.input } }),
  }]))
  return {
    version: 1,
    checkedAt: new Date(0).toISOString(),
    models: transformProvider({ models: source }).models,
    diagnostics: [],
  }
}

/** 构造一个不联网的运行时；`source` 由调用方注入。 */
function runtimeWith(
  store: MemoryCatalogStore,
  fetchProvider: () => Promise<SourceProvider>,
): OpenCodeGoLiveRuntime {
  return new OpenCodeGoLiveRuntime({
    config: resolveConfig({ apiKeyEnv: 'K', catalog: { refreshOnStart: false, refreshIntervalMs: 0 } }),
    source: { fetchProvider },
    store,
    logger,
  })
}

/** 读取刷新路由的 JSON 响应。 */
async function body(runtime: OpenCodeGoLiveRuntime): Promise<Record<string, unknown>> {
  const response = await refreshRoute(runtime)
  assert.equal(response.status, 200)
  return await response.json() as Record<string, unknown>
}

test('diff 没有上一份快照时把全部模型算作新增', () => {
  const next = snapshotOf({ a: {}, b: {} })
  const diff = diffCatalogs(undefined, next)
  assert.deepEqual(diff.added, ['a', 'b'])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.updated, [])
})

test('diff 区分新增、移除与资料更新', () => {
  const previous = snapshotOf({ keep: {}, gone: {}, change: { context: 128_000 } })
  const next = snapshotOf({ keep: {}, added: {}, change: { context: 200_000 } })
  const diff = diffCatalogs(previous, next)
  assert.deepEqual(diff.added, ['added'])
  assert.deepEqual(diff.removed, ['gone'])
  assert.deepEqual(diff.updated, ['change'])
})

test('diff 把名称、输入模态与上限变化都算作更新', () => {
  const previous = snapshotOf({ m: { name: 'old', context: 1000, output: 100 } })
  const renamed = snapshotOf({ m: { name: 'new name', context: 1000, output: 100 } })
  assert.deepEqual(diffCatalogs(previous, renamed).updated, ['m'])

  const modality = snapshotOf({ m: { name: 'old', context: 1000, output: 100, input: ['text', 'image'] } })
  assert.deepEqual(diffCatalogs(previous, modality).updated, ['m'])

  const bigger = snapshotOf({ m: { name: 'old', context: 2000, output: 100 } })
  assert.deepEqual(diffCatalogs(previous, bigger).updated, ['m'])
})

test('diff 对完全相同的目录给出空变化', () => {
  const snapshot = snapshotOf({ a: {}, b: {} })
  assert.deepEqual(diffCatalogs(snapshot, snapshot), { added: [], removed: [], updated: [] })
})

test('刷新路由回报相对上一份快照的变化', async () => {
  const store = new MemoryCatalogStore()
  await store.save(snapshotOf({ keep: {}, gone: {}, change: { context: 128_000 } }))
  let source = { models: {
    keep: { tool_call: true, limit: { context: 128_000, output: 8_192 } },
    added: { tool_call: true, limit: { context: 128_000, output: 8_192 } },
    change: { tool_call: true, limit: { context: 200_000, output: 8_192 } },
  } }
  const runtime = runtimeWith(store, async () => source)
  await runtime.start()
  try {
    const payload = await body(runtime)
    assert.equal(payload.ok, true)
    assert.equal(payload.total, 3)
    assert.deepEqual(payload.added, ['added'])
    assert.deepEqual(payload.removed, ['gone'])
    // change 只是上限变化：出现在 updated，不应重复出现在 added。
    assert.deepEqual(payload.updated, ['change'])
  } finally {
    await runtime.dispose()
  }
})

test('刷新失败时路由回报 REFRESH_FAILED 并保留旧快照', async () => {
  const store = new MemoryCatalogStore()
  await store.save(snapshotOf({ keep: {} }))
  const runtime = runtimeWith(store, async () => { throw new Error('offline') })
  await runtime.start()
  try {
    const payload = await body(runtime)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'REFRESH_FAILED')
    // 失败不改变已恢复的目录。
    assert.deepEqual(runtime.getSnapshot()?.models.map(model => model.id), ['keep'])
  } finally {
    await runtime.dispose()
  }
})

test('刷新后没有变化时三个方向都为空', async () => {
  const store = new MemoryCatalogStore()
  await store.save(snapshotOf({ keep: {} }))
  const runtime = runtimeWith(store, async () => ({
    models: { keep: { tool_call: true, limit: { context: 128_000, output: 8_192 } } },
  }))
  await runtime.start()
  try {
    const payload = await body(runtime)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.added, [])
    assert.deepEqual(payload.removed, [])
    assert.deepEqual(payload.updated, [])
  } finally {
    await runtime.dispose()
  }
})

test('插件挂载时同时注册余额与主动刷新路由（后者只接受 POST）', async () => {
  const ctx = new Context()
  const routes = new Map<string, { methods: readonly string[]; fetch: (request: Request) => Promise<Response> }>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  await ctx.plugin(LlmRuntime)
  const fiber = await ctx.plugin(Live, {
    apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
    catalog: { refreshOnStart: false, refreshIntervalMs: 0 },
  })
  try {
    assert.ok(routes.has(Live.BALANCE_ROUTE_PATH), '余额路由应注册')
    assert.ok(routes.has(Live.REFRESH_ROUTE_PATH), '主动刷新路由应注册')
    assert.deepEqual(routes.get(Live.REFRESH_ROUTE_PATH)?.methods, ['POST'])
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
