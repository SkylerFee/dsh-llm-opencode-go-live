import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createUsageSource,
  OPENCODE_GO_USAGE_URL,
  parseUsageResponse,
} from '../src/balance.js'

/** 上游成功的完整三窗口响应。 */
const FULL_RESPONSE = {
  usage: {
    rolling: { status: 'ok', percent: 37.5, resetsAt: '2026-10-04T08:00:00.000Z' },
    weekly: { status: 'ok', percent: 12, resetsAt: '2026-10-06T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-01T00:00:00.000Z' },
  },
}

test('完整响应归一化三个计费窗口', () => {
  const envelope = parseUsageResponse(200, FULL_RESPONSE)
  assert.equal(envelope.ok, true)
  assert.ok(envelope.ok)
  assert.ok(Number.isFinite(Date.parse(envelope.checkedAt)))
  assert.deepEqual(envelope.usage.rolling, {
    status: 'ok', percent: 37.5, resetsAt: '2026-10-04T08:00:00.000Z',
  })
  assert.deepEqual(envelope.usage.monthly, {
    status: 'rate-limited', percent: 100, resetsAt: '2026-11-01T00:00:00.000Z',
  })
})

test('缺少的窗口不进入报告', () => {
  const envelope = parseUsageResponse(200, { usage: { rolling: { status: 'ok', percent: 5 } } })
  assert.ok(envelope.ok)
  assert.equal(envelope.usage.rolling?.percent, 5)
  assert.equal(envelope.usage.weekly, undefined)
  assert.equal(envelope.usage.monthly, undefined)
})

test('未知 status 丢弃该窗口', () => {
  const envelope = parseUsageResponse(200, {
    usage: {
      rolling: { status: 'exhausted', percent: 10, resetsAt: '2026-10-04T08:00:00.000Z' },
      weekly: { status: 'ok', percent: 10, resetsAt: '2026-10-06T00:00:00.000Z' },
    },
  })
  assert.ok(envelope.ok)
  assert.equal(envelope.usage.rolling, undefined)
  assert.equal(envelope.usage.weekly?.percent, 10)
})

test('非有限 percent 丢弃该窗口', () => {
  for (const percent of ['10', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const envelope = parseUsageResponse(200, {
      usage: {
        rolling: { status: 'ok', percent },
        weekly: { status: 'ok', percent: 10, resetsAt: '2026-10-06T00:00:00.000Z' },
      },
    })
    assert.ok(envelope.ok, String(percent))
    assert.equal(envelope.usage.rolling, undefined, String(percent))
    assert.equal(envelope.usage.weekly?.percent, 10, String(percent))
  }
})

test('非法 resetsAt 只丢字段并保留窗口', () => {
  const envelope = parseUsageResponse(200, {
    usage: { rolling: { status: 'ok', percent: 42, resetsAt: 'not-a-date' } },
  })
  assert.ok(envelope.ok)
  assert.equal(envelope.usage.rolling?.percent, 42)
  assert.equal(envelope.usage.rolling?.resetsAt, undefined)
})

test('全部窗口非法或 body 非对象时返回 UNKNOWN', () => {
  for (const body of [
    { usage: {} },
    { usage: { rolling: { status: 'ok' } } },
    undefined,
    null,
    'not json',
    { usage: 'rolling' },
  ]) {
    const envelope = parseUsageResponse(200, body)
    assert.equal(envelope.ok, false)
    assert.ok(!envelope.ok)
    assert.equal(envelope.code, 'UNKNOWN')
  }
})

test('上游 401 与 403 映射为认证与订阅错误', () => {
  const auth = parseUsageResponse(401, { error: { type: 'AuthError' } })
  assert.ok(!auth.ok)
  assert.equal(auth.code, 'AUTH')
  const subscription = parseUsageResponse(403, { error: { type: 'EntitlementError' } })
  assert.ok(!subscription.ok)
  assert.equal(subscription.code, 'NO_SUBSCRIPTION')
  const other = parseUsageResponse(500, undefined)
  assert.ok(!other.ok)
  assert.equal(other.code, 'UNKNOWN')
})

test('来源客户端带 Bearer 头请求上游并把网络失败归为 NETWORK', async () => {
  const calls: { url: string; authorization: string | null }[] = []
  const source = createUsageSource({
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify(FULL_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  })
  const envelope = await source.fetchUsage('sk-test-secret', new AbortController().signal)
  assert.ok(envelope.ok)
  assert.deepEqual(calls, [{ url: OPENCODE_GO_USAGE_URL, authorization: 'Bearer sk-test-secret' }])

  const failing = createUsageSource({
    fetch: (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch,
  })
  const failure = await failing.fetchUsage('sk-test-secret', new AbortController().signal)
  assert.ok(!failure.ok)
  assert.equal(failure.code, 'NETWORK')
  // 诊断不得携带密钥。
  assert.ok(!failure.message.includes('sk-test-secret'))
})

test('端点覆盖与 JSON 解析失败都进入确定分支', async () => {
  const source = createUsageSource({
    baseUrl: 'https://proxy.example/usage',
    fetch: (async (input: URL | RequestInfo) => {
      assert.equal(String(input), 'https://proxy.example/usage')
      return new Response('<html>not json</html>', { status: 200 })
    }) as typeof globalThis.fetch,
  })
  const envelope = await source.fetchUsage('sk-test-secret', new AbortController().signal)
  assert.ok(!envelope.ok)
  assert.equal(envelope.code, 'UNKNOWN')
})
