/**
 * OpenCode Go 订阅用量来源。
 *
 * 上游端点 `GET /zen/go/v1/usage` 依据 opencode 仓库 `packages/console/app/src/routes/zen/go/v1/usage.ts`
 * 核实，未出现在公开文档；端点地址与响应解析集中在本模块，上游演进时只改这一处。
 * 解析对未知字段宽容：字段级非法只丢弃该字段或该窗口，不让整个响应失败。
 */

/** 上游 usage 端点默认地址。 */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** 单个计费窗口的归一化视图。 */
export interface UsageWindow {
  status: 'ok' | 'rate-limited'
  /** 上游百分比；展示层负责 clamp 到 0-100，本层只要求有限数。 */
  percent: number
  /** 上游 ISO 字符串；非法时为 undefined，展示层隐藏倒计时。 */
  resetsAt: string | undefined
}

/** 归一化用量报告；缺失或非法的窗口被丢弃。 */
export interface UsageReport {
  rolling?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
}

/** 宿主路由返回给客户端的错误分类；客户端按 code 显示本地化文案。 */
export type UsageErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'AUTH'
  | 'NO_SUBSCRIPTION'
  | 'NETWORK'
  | 'UNKNOWN'

/** 宿主余额路由的统一响应包。 */
export type UsageEnvelope =
  | { ok: true; checkedAt: string; usage: UsageReport }
  | { ok: false; code: UsageErrorCode; message: string }

/** 来源客户端的端点和 Fetch 覆盖。 */
export interface UsageSourceOptions {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

/** 来源客户端的可测试窄接口。 */
export interface UsageSource {
  fetchUsage(apiKey: string, signal: AbortSignal): Promise<UsageEnvelope>
}

const WINDOW_KEYS = ['rolling', 'weekly', 'monthly'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failure(code: UsageErrorCode, message: string): UsageEnvelope {
  return { ok: false, code, message }
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value)) return undefined
  const status = value.status
  if (status !== 'ok' && status !== 'rate-limited') return undefined
  const percent = value.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
  const resetsAt = typeof value.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt))
    ? value.resetsAt
    : undefined
  return { status, percent, resetsAt }
}

/**
 * 把上游 HTTP 状态与 JSON body 归一化为响应包。
 * @param status - 上游 HTTP 状态码。
 * @param body - 已解析的 JSON；解析失败时传 undefined。
 * @returns 成功包；认证、订阅或解析问题返回带 code 的失败包。
 */
export function parseUsageResponse(status: number, body: unknown): UsageEnvelope {
  if (status === 401) return failure('AUTH', 'llm-opencode-go-live: upstream returned 401')
  if (status === 403) return failure('NO_SUBSCRIPTION', 'llm-opencode-go-live: upstream returned 403')
  if (status < 200 || status >= 300) {
    return failure('UNKNOWN', `llm-opencode-go-live: upstream returned ${status}`)
  }
  if (!isRecord(body) || !isRecord(body.usage)) {
    return failure('UNKNOWN', 'llm-opencode-go-live: upstream response has no usage object')
  }
  const usage: UsageReport = {}
  for (const key of WINDOW_KEYS) {
    const parsed = parseWindow(body.usage[key])
    if (parsed !== undefined) usage[key] = parsed
  }
  if (Object.keys(usage).length === 0) {
    return failure('UNKNOWN', 'llm-opencode-go-live: upstream response has no usable usage window')
  }
  return { ok: true, checkedAt: new Date().toISOString(), usage }
}

/**
 * 创建 Go 用量来源适配器。
 * @param options - 端点和 Fetch 覆盖，用于代理和测试替身。
 * @returns 可注入到余额路由的来源客户端。
 */
export function createUsageSource(options: UsageSourceOptions = {}): UsageSource {
  const baseUrl = options.baseUrl ?? OPENCODE_GO_USAGE_URL
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async fetchUsage(apiKey: string, signal: AbortSignal): Promise<UsageEnvelope> {
      let response: Response
      try {
        response = await fetcher(baseUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal,
        })
      } catch {
        // 失败诊断不含密钥，也不含请求头。
        return failure('NETWORK', 'llm-opencode-go-live: usage request failed')
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      return parseUsageResponse(response.status, body)
    },
  }
}
