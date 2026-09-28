import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Config } from '../src/config.js'

/** 插件路由默认使用的凭据引用。 */
const LIVE_ROUTE_REF = 'OPENCODE_GO_LIVE_API_KEY'

/**
 * DSH Models 页为内置 `opencode-go` 路由派生的凭据引用，
 * 等价于 `deriveKeyRef('opencode-go')`。
 */
const BUILTIN_ROUTE_REF = 'OPENCODE_GO_API_KEY'

test('默认凭据引用与内置 opencode-go 的派生引用相互独立', () => {
  assert.equal(Config({}).apiKeyEnv.get(), LIVE_ROUTE_REF)
  assert.notEqual(LIVE_ROUTE_REF, BUILTIN_ROUTE_REF)
})

test('bundle 补丁使用与 schema 默认值相同的凭据引用', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const match = /^\s*apiKeyEnv:\s*(\S+)\s*$/m.exec(patch)
  assert.equal(match?.[1], LIVE_ROUTE_REF)
})

test('bundle 补丁把目录快照放在 Harness home 的 cache 目录', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /cachePath:\s*!!js dshHomePath\('cache', 'opencode-go-live\.json'\)/)
})
