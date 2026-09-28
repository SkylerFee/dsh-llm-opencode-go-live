import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import * as Live from '../src/index.js'
import { JsonCatalogStore } from '../src/store.js'
import { transformProvider } from '../src/transform.js'

test('Cordis 挂载后恢复模型并在请求时拒绝缺失凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  const ctx = new Context()
  try {
    const cachePath = join(directory, 'catalog.json')
    const models = transformProvider({ models: {
      'deepseek-v4-flash': { tool_call: true, limit: { context: 128_000, output: 8_192 } },
    } }).models
    await new JsonCatalogStore(cachePath).save({
      version: 1, checkedAt: new Date(0).toISOString(), models, diagnostics: [],
    })
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await ctx.plugin(LlmRuntime)
    let catalogEvents = 0
    ctx.on('llm/adapters-updated', () => { catalogEvents += 1 })
    const fiber = await ctx.plugin(Live, {
      apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
      catalog: { cachePath, refreshOnStart: false, refreshIntervalMs: 0 },
    })
    assert.deepEqual(ctx.llm.listProviders(), [{ id: Live.ROUTE_ID, name: Live.DISPLAY_NAME }])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
    assert.throws(
      () => ctx.llm.registerAdapter([Live.ROUTE_ID], {} as never),
      (error: unknown) => error instanceof LlmError && error.code === 'DUPLICATE_ADAPTER',
    )

    let listed = await ctx.llm.listModels(Live.ROUTE_ID)
    for (let attempt = 0; listed.length === 0 && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      listed = await ctx.llm.listModels(Live.ROUTE_ID)
    }
    assert.deepEqual(listed.map(model => model.id), ['deepseek-v4-flash'])
    assert.equal(catalogEvents, 2)
    const prepared = await ctx.llm.prepareCall({ provider: Live.ROUTE_ID, model: 'deepseek-v4-flash' })
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
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true })
  }
})
