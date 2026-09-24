import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JsonCatalogStore } from '../src/store.js'
import { OpenCodeGoLiveRuntime } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { transformProvider } from '../src/transform.js'

test('JSON 存储使用可恢复快照且不写入临时残留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  const path = join(directory, 'catalog.json')
  const store = new JsonCatalogStore(path)
  const snapshot = { version: 1 as const, checkedAt: new Date(0).toISOString(), models: [], diagnostics: [] }
  await store.save(snapshot)
  assert.deepEqual(await store.load(), snapshot)
  assert.match(await readFile(path, 'utf8'), /"version":1/)
  await rm(directory, { recursive: true })
})

test('重启后离线恢复目录，失败刷新保留已知模型的调用策略', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  try {
    const path = join(directory, 'catalog.json')
    const store = new JsonCatalogStore(path)
    const models = transformProvider({ models: {
      'deepseek-v4-flash': { tool_call: true, limit: { context: 128_000, output: 8_192 } },
    } }).models
    assert.ok(models[0]?.compat)
    await store.save({ version: 1, checkedAt: new Date(0).toISOString(), models, diagnostics: [] })
    const config = resolveConfig({ apiKeyEnv: 'OPENCODE_API_KEY', catalog: { cachePath: path, refreshOnStart: false, refreshIntervalMs: 0 } })
    assert.equal(config.catalog.cachePath, path)
    const runtime = new OpenCodeGoLiveRuntime({
      config,
      source: { fetchProvider: async () => { throw new Error('offline') } },
      store: new JsonCatalogStore(config.catalog.cachePath),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    await runtime.start()
    assert.deepEqual(runtime.getSnapshot()?.models, models)
    assert.equal(await runtime.refresh(), undefined)
    assert.deepEqual(runtime.getSnapshot()?.models, models)
    await runtime.dispose()
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('配置拒绝相对缓存路径，持久化目录拒绝改写的请求地址', async () => {
  assert.throws(() => resolveConfig({ apiKeyEnv: 'OPENCODE_API_KEY', catalog: { cachePath: 'catalog.json' } }))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  try {
    const path = join(directory, 'catalog.json')
    const store = new JsonCatalogStore(path)
    const models = transformProvider({ models: {
      'deepseek-v4-flash': { tool_call: true, limit: { context: 128_000, output: 8_192 } },
    } }).models
    await store.save({ version: 1, checkedAt: new Date(0).toISOString(), models: models.map(model => ({ ...model, baseUrl: 'https://invalid.example' })), diagnostics: [] })
    assert.equal(await store.load(), undefined)
  } finally {
    await rm(directory, { recursive: true })
  }
})
