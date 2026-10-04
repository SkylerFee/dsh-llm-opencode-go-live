import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Config, resolveConfig } from '../src/config.js'

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

test('余额悬浮面板默认开启且可由 volatile 字段覆盖', () => {
  // schema 默认值必须与 resolveConfig 的默认值一致：两者共同决定卡片开关的初始状态。
  assert.equal(Config({}).showBalanceOverlay.get(), true)
  assert.equal(Config({ showBalanceOverlay: false }).showBalanceOverlay.get(), false)
  assert.equal(resolveConfig({ apiKeyEnv: LIVE_ROUTE_REF }).showBalanceOverlay, true)
  assert.equal(resolveConfig({ apiKeyEnv: LIVE_ROUTE_REF, showBalanceOverlay: false }).showBalanceOverlay, false)
})

test('余额悬浮面板字段拒绝非布尔值', () => {
  assert.throws(
    () => resolveConfig({ apiKeyEnv: LIVE_ROUTE_REF, showBalanceOverlay: 'yes' }),
    (error: unknown) => error instanceof TypeError
      && error.message === 'llm-opencode-go-live: showBalanceOverlay must be boolean',
  )
})

test('bundle 补丁不为余额悬浮面板重复默认值', async () => {
  // 默认值由 schema 提供；写进 patch 会让用户覆盖失去单一来源。
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /showBalanceOverlay/)
})

test('git 安装依赖的构建钩子是 prepack 而不是 prepare', async () => {
  // pnpm 安装 git 依赖时只执行 `<pm> install` 与 prepublish/prepack/publish，
  // 不会执行 prepare；钩子改回 prepare 会让 git 安装装出缺少 lib/ 的包，
  // 而 `pnpm pack` 与本地 checkout 两条路径都读取 lib/。
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts.prepack, 'pnpm run build')
  assert.equal(manifest.scripts.prepare, undefined)
})

test('npm 发布确认允许元数据延迟，重试耗尽仍失败', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  const step = workflow.slice(workflow.indexOf('      - name: 确认 npm 版本可见'))
  const script = step.split('        run: |\n')[1]
  assert.ok(script, '必须运行工作流中的实际 shell 脚本')
  // npm 和 sleep 使用 shell 函数替身，离线验证传播延迟且无需真实等待。
  const mocks = `
    calls=0
    npm() {
      calls=$((calls + 1))
      echo "query:$*"
      test "$calls" -gt "$FAILURES"
    }
    sleep() { echo "sleep:$*"; }
  `
  for (const [failures, queries, sleeps, status] of [[0, 1, 0, 0], [2, 3, 2, 0], [12, 12, 11, 1]]) {
    const result = spawnSync('bash', ['-ec', mocks + script.replace(/^ {10}/gm, '')], {
      encoding: 'utf8',
      env: { ...process.env, FAILURES: String(failures), NPM_PACKAGE_VERSION: '0.1.0-alpha.5' },
    })
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stderr)
    assert.equal(result.stdout.split('\n').filter(line => line === 'query:view @skylerfee/dsh-llm-opencode-go-live@0.1.0-alpha.5 version --registry=https://registry.npmjs.org').length, queries)
    assert.equal(result.stdout.split('\n').filter(line => line === 'sleep:10').length, sleeps)
  }
})
