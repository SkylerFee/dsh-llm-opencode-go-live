import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OpenCodeGoLiveRuntime } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { createDynamicAdapter, createDynamicProvider, ROUTE_ID } from '../src/provider.js'
import type { SourceProvider } from '../src/source.js'
import { MemoryCatalogStore } from '../src/store.js'
import { transformProvider } from '../src/transform.js'

test('远端目录决定成员，未知模型使用通用协议策略', () => {
  const result = transformProvider({
    models: {
      'deepseek-v4-flash': {
        name: 'DeepSeek V4 Flash',
        tool_call: true,
        reasoning: true,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ['text', 'image'] },
      },
      'future-model': { tool_call: true, limit: { context: 1, output: 1 } },
      'broken-model': { tool_call: true },
      'removed-model': { tool_call: true, status: 'deprecated', limit: { context: 1, output: 1 } },
    },
  })
  assert.equal(result.models.length, 2)
  assert.equal(result.models[0]?.api, 'openai-completions')
  assert.deepEqual(result.models[0]?.input, ['text'])
  assert.equal(result.models[1]?.id, 'future-model')
  assert.equal(result.models[1]?.api, 'openai-completions')
  assert.deepEqual(result.diagnostics.map(item => item.code), ['INVALID_LIMIT', 'DEPRECATED_MODEL'])
})

test('使用 pi-ai 策略基线保留三类 OpenCode Go 协议', () => {
  const result = transformProvider({
    models: {
      'gpt-5.6-luna': { tool_call: true, limit: { context: 100, output: 10 }, modalities: { input: ['text'] } },
      'minimax-m3': { tool_call: true, limit: { context: 100, output: 10 }, modalities: { input: ['text'] } },
      'qwen3.8-flash': { tool_call: true, limit: { context: 100, output: 10 }, modalities: { input: ['text'] } },
    },
  })
  assert.deepEqual(result.models.map(model => [model.id, model.api]), [
    ['gpt-5.6-luna', 'openai-responses'],
    ['minimax-m3', 'anthropic-messages'],
    ['qwen3.8-flash', 'anthropic-messages'],
  ])
})

test('动态 Provider 复用 pi-ai 的请求实现', () => {
  const result = transformProvider({
    models: {
      'deepseek-v4-flash': { tool_call: true, limit: { context: 100, output: 10 }, modalities: { input: ['text'] } },
    },
  })
  const provider = createDynamicProvider(result.models)
  assert.equal(provider.id, 'opencode-go-live')
  assert.equal(provider.getModels().length, 1)
  assert.equal(typeof provider.stream, 'function')
  assert.equal(typeof provider.streamSimple, 'function')
})

test('成功刷新后动态目录可以新增和移除模型', async () => {
  let source: SourceProvider = {
    models: { 'old-model': { tool_call: true, limit: { context: 100, output: 10 } } },
  }
  const runtime = new OpenCodeGoLiveRuntime({
    config: resolveConfig({ apiKeyEnv: 'OPENCODE_API_KEY', catalog: { refreshOnStart: false, refreshIntervalMs: 0 } }),
    source: { fetchProvider: async () => source },
    store: new MemoryCatalogStore(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })
  const adapter = createDynamicAdapter(() => runtime.getSnapshot(), async () => 'test-key')

  await runtime.refresh()
  assert.deepEqual((await adapter.listModels(ROUTE_ID)).map(model => model.id), ['old-model'])
  source = { models: { 'new-model': { tool_call: true, limit: { context: 100, output: 10 } } } }
  await runtime.refresh()
  assert.deepEqual((await adapter.listModels(ROUTE_ID)).map(model => model.id), ['new-model'])
  source = {}
  await runtime.refresh()
  assert.deepEqual((await adapter.listModels(ROUTE_ID)).map(model => model.id), ['new-model'])
  source = { models: {} }
  await runtime.refresh()
  assert.deepEqual((await adapter.listModels(ROUTE_ID)).map(model => model.id), [])
  runtime.dispose()
})
