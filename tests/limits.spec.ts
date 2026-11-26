import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createLimitsSource, LIMIT_PLANS, parseLimits } from '../src/index.js'

/** 官方响应里单个模型的最小形状（取自实测）。 */
function entry(id: string, usage: unknown): unknown {
  return { id, object: 'model', go: { monthly_usage: usage } }
}

test('解析三档额度：数字、null（不计量）与缺失档位', () => {
  const table = parseLimits({
    object: 'list',
    data: [
      entry('qwen3.8-max', { go: 15, 'go-plus': 60, 'go-teams': 20 }),
      entry('beam-free', { go: null, 'go-plus': null, 'go-teams': null }),
      // 只给了部分档位：缺的档位不应被补成 0。
      entry('partial', { go: 30 }),
    ],
  })
  assert.deepEqual(table['qwen3.8-max'], { go: 15, 'go-plus': 60, 'go-teams': 20 })
  assert.deepEqual(table['beam-free'], { go: null, 'go-plus': null, 'go-teams': null })
  assert.deepEqual(table['partial'], { go: 30 })
  assert.equal('go-plus' in table['partial']!, false)
})

test('解析宽容：非法值被忽略，结构不符返回空表', () => {
  const table = parseLimits({
    object: 'list',
    data: [
      entry('bad-values', { go: -1, 'go-plus': 'sixty', 'go-teams': Number.NaN }),
      entry('mostly-ok', { go: 15, 'go-plus': Number.POSITIVE_INFINITY }),
      { id: 'no-go', object: 'model' },
      { go: { monthly_usage: { go: 15 } } },
      null,
    ],
  })
  // 全是非法值的条目整条丢弃，不留下空对象。
  assert.equal('bad-values' in table, false)
  assert.deepEqual(table['mostly-ok'], { go: 15 })
  assert.equal('no-go' in table, false)

  for (const broken of [null, undefined, 42, 'text', {}, { data: 'nope' }]) {
    assert.deepEqual(parseLimits(broken), {})
  }
})

test('monthly_usage 整体为 null 表示全部档位不计量（免费模型）', () => {
  // 官方对免费模型返回的是 `monthly_usage: null`，而不是三档为 null 的对象。
  // 早期实现把它当"结构不符"跳过，导致免费模型显示横杠而不是 ∞。
  const table = parseLimits({
    object: 'list',
    data: [{ id: 'beam-free', object: 'model', go: { monthly_usage: null } }],
  })
  assert.deepEqual(table['beam-free'], { go: null, 'go-plus': null, 'go-teams': null })
})

test('缺少 go.monthly_usage 字段的条目仍然跳过', () => {
  const table = parseLimits({
    object: 'list',
    data: [
      { id: 'no-usage', object: 'model', go: { training: false } },
      { id: 'ok', object: 'model', go: { monthly_usage: { go: 10 } } },
    ],
  })
  assert.equal('no-usage' in table, false)
  assert.deepEqual(table.ok, { go: 10 })
})

test('三档顺序固定，便于界面稳定展示', () => {
  assert.deepEqual([...LIMIT_PLANS], ['go', 'go-plus', 'go-teams'])
})

test('来源客户端解析成功，非 2xx 抛出（由运行时降级）', async () => {
  const ok = createLimitsSource({
    fetch: (async () => new Response(JSON.stringify({
      object: 'list',
      data: [entry('m', { go: 15, 'go-plus': 60, 'go-teams': 20 })],
    }), { status: 200 })) as typeof globalThis.fetch,
  })
  assert.deepEqual(await ok.fetchLimits(new AbortController().signal), {
    m: { go: 15, 'go-plus': 60, 'go-teams': 20 },
  })

  const failing = createLimitsSource({
    fetch: (async () => new Response('boom', { status: 503 })) as typeof globalThis.fetch,
  })
  await assert.rejects(() => failing.fetchLimits(new AbortController().signal), /503/)
})

test('默认端点指向官方 inference 明细表', async () => {
  let seen: string | undefined
  const source = createLimitsSource({
    fetch: (async (input: unknown) => {
      seen = String(input)
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof globalThis.fetch,
  })
  await source.fetchLimits(new AbortController().signal)
  assert.equal(seen, 'https://opencode.ai/inference/go/v1/models')
})

test('额度端点失败时目录照常发布，快照不带额度', async () => {
  const { OpenCodeGoLiveRuntime } = await import('../src/index.js')
  const { resolveConfig } = await import('../src/config.js')
  const { MemoryCatalogStore } = await import('../src/store.js')

  const runtime = new OpenCodeGoLiveRuntime({
    config: resolveConfig({ apiKeyEnv: 'K', catalog: { refreshOnStart: false, refreshIntervalMs: 0 } }),
    source: { fetchProvider: async () => ({ models: { keep: { tool_call: true, limit: { context: 1_000, output: 100 } } } }) },
    // 额度端点整个挂掉
    limits: { fetchLimits: async () => { throw new Error('limits endpoint down') } },
    store: new MemoryCatalogStore(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })
  try {
    const snapshot = await runtime.refresh()
    assert.ok(snapshot !== undefined, '额度失败不应阻止目录刷新')
    assert.deepEqual(snapshot!.models.map(model => model.id), ['keep'])
    assert.equal(snapshot!.limits, undefined, '额度失败时快照不带额度，界面显示横杠')
  } finally {
    await runtime.dispose()
  }
})

test('额度成功时随快照发布，并可在恢复后读回', async () => {
  const { OpenCodeGoLiveRuntime } = await import('../src/index.js')
  const { resolveConfig } = await import('../src/config.js')
  const { MemoryCatalogStore } = await import('../src/store.js')

  const store = new MemoryCatalogStore()
  const runtime = new OpenCodeGoLiveRuntime({
    config: resolveConfig({ apiKeyEnv: 'K', catalog: { refreshOnStart: false, refreshIntervalMs: 0 } }),
    source: { fetchProvider: async () => ({ models: { keep: { tool_call: true, limit: { context: 1_000, output: 100 } } } }) },
    limits: { fetchLimits: async () => ({ keep: { go: 15, 'go-plus': 60, 'go-teams': 20 } }) },
    store,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })
  try {
    const snapshot = await runtime.refresh()
    assert.deepEqual(snapshot?.limits, { keep: { go: 15, 'go-plus': 60, 'go-teams': 20 } })

    // 恢复路径也要带回额度，否则重启后界面会丢这一列。
    const restored = await new OpenCodeGoLiveRuntime({
      config: resolveConfig({ apiKeyEnv: 'K', catalog: { refreshOnStart: false, refreshIntervalMs: 0 } }),
      source: { fetchProvider: async () => ({ models: {} }) },
      store,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }).start().then(() => store.load())
    assert.deepEqual(restored?.limits, { keep: { go: 15, 'go-plus': 60, 'go-teams': 20 } })
  } finally {
    await runtime.dispose()
  }
})
