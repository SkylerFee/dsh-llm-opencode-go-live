import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OpenCodeGoLiveRuntime } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import type { SourceProvider } from '../src/source.js'
import { MemoryCatalogStore } from '../src/store.js'

/**
 * 常规间隔刻意远大于退避上限（400ms vs 10~40ms）：
 * 只有把两者拉开，"失败后快速重试"与"傻等下一轮"才在观测上可区分。
 */
const INTERVAL_MS = 400
const BACKOFF_MIN_MS = 10
const BACKOFF_MAX_MS = 40

/** 不打印的日志替身；只累计警告条数，便于断言每次失败都被记录。 */
function logger(): { info: () => void; warn: () => void; error: () => void; warns: () => number } {
  let warns = 0
  return {
    info: () => undefined,
    warn: () => { warns += 1 },
    error: () => undefined,
    warns: () => warns,
  }
}

/** 一份最小可用来源：一个声明了工具调用与上限的模型。 */
const OK_SOURCE: SourceProvider = {
  models: { keep: { tool_call: true, limit: { context: 1_000, output: 100 } } },
}

/** 建立只跑定时器、不跑启动刷新的运行时。 */
function runtimeWith(
  fetchProvider: () => Promise<SourceProvider>,
  log: ReturnType<typeof logger>,
  catalog: Record<string, number> = {},
): OpenCodeGoLiveRuntime {
  return new OpenCodeGoLiveRuntime({
    config: resolveConfig({
      apiKeyEnv: 'K',
      catalog: {
        refreshOnStart: false,
        refreshIntervalMs: INTERVAL_MS,
        refreshRetryMinMs: BACKOFF_MIN_MS,
        refreshRetryMaxMs: BACKOFF_MAX_MS,
        ...catalog,
      },
    }),
    source: { fetchProvider },
    store: new MemoryCatalogStore(),
    logger: log,
  })
}

/** 等待指定毫秒；只用于观察真实定时器行为，不做忙轮询。 */
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('失败后的重试远早于常规间隔，且每次失败都记录日志', async () => {
  const log = logger()
  let calls = 0
  const runtime = runtimeWith(async () => {
    calls += 1
    throw new Error('offline')
  }, log)

  await runtime.start()
  try {
    // 显式触发一次失败刷新，让退避接管调度；常规间隔 400ms 尚未到点。
    await runtime.refresh()
    const afterFirstFailure = calls
    await wait(120)
    assert.ok(calls - afterFirstFailure >= 2, '失败后应快速重试')
    assert.ok(calls >= 2, `失败后应快速重试，120ms 内实际只调用了 ${calls} 次`)
    assert.equal(log.warns(), calls, '每次失败都应有警告日志')
    assert.equal(runtime.getSnapshot(), undefined, '失败不应产生快照')
  } finally {
    await runtime.dispose()
  }
})

test('连续失败的重试间隔递增到上限为止', async () => {
  let calls = 0
  const stamps: number[] = []
  const runtime = runtimeWith(async () => {
    calls += 1
    stamps.push(Date.now())
    throw new Error('offline')
  }, logger())

  await runtime.start()
  try {
    await runtime.refresh()
    await wait(200)
    assert.ok(stamps.length >= 4, `应发生多次重试，实际 ${stamps.length} 次`)
    const gaps = stamps.slice(1).map((at, index) => at - stamps[index]!)
    // 前几次间隔应递增（允许定时器抖动的容差），且都不超过上限太多。
    assert.ok(gaps[1]! >= gaps[0]!, `间隔应递增，实际 ${JSON.stringify(gaps)}`)
    assert.ok(gaps.every(gap => gap <= BACKOFF_MAX_MS + 30), `间隔不应超过上限太多，实际 ${JSON.stringify(gaps)}`)
  } finally {
    await runtime.dispose()
  }
})

test('一次成功后退回常规间隔，不再高频重试', async () => {
  const log = logger()
  let calls = 0
  let fail = true
  const runtime = runtimeWith(async () => {
    calls += 1
    if (fail) throw new Error('offline')
    return OK_SOURCE
  }, log)

  await runtime.start()
  try {
    // 先失败一次，让退避接管下一次重试。
    await runtime.refresh()
    assert.ok(calls >= 1, '显式刷新应发生一次调用')
    assert.equal(runtime.getSnapshot(), undefined, '第一次刷新失败，不应有快照')

    fail = false
    // 退避把重试提前；成功一次后连续失败计数归零。
    await wait(120)
    assert.ok(runtime.getSnapshot() !== undefined, '成功刷新后应产出快照')

    const afterSuccess = calls
    // 回归常规间隔：这段窗口内最多再发生一次（400ms 间隔），绝不该是退避级的连发。
    await wait(150)
    const duringInterval = calls - afterSuccess
    assert.ok(duringInterval <= 1, `成功后应恢复常规节奏，150ms 内实际刷新 ${duringInterval} 次`)
  } finally {
    await runtime.dispose()
  }
})

test('卸载后定时器停止，不再发起刷新', async () => {
  let calls = 0
  const runtime = runtimeWith(async () => {
    calls += 1
    return OK_SOURCE
  }, logger())

  await runtime.start()
  await wait(INTERVAL_MS + 120)
  assert.ok(calls >= 1, '常规间隔到点后应刷新一次')
  await runtime.dispose()
  const atDispose = calls
  await wait(200)
  assert.equal(calls, atDispose, 'dispose 之后不应再刷新')
})

test('refreshIntervalMs 为 0 时不启动任何定时刷新', async () => {
  let calls = 0
  const runtime = runtimeWith(async () => {
    calls += 1
    return OK_SOURCE
  }, logger(), { refreshIntervalMs: 0 })

  await runtime.start()
  try {
    await wait(200)
    assert.equal(calls, 0, 'interval=0 时只允许启动刷新与显式刷新')
  } finally {
    await runtime.dispose()
  }
})
