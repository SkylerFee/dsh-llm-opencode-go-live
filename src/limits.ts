/**
 * OpenCode Go 套餐的按模型额度。
 *
 * 数据源是官方页面自己在用的公开端点：
 * `GET https://opencode.ai/inference/go/v1/models`。
 * 每个模型带 `go.monthly_usage = { go, "go-plus", "go-teams" }`，单位是美元；
 * `null` 表示该模型不计量（免费模型）。这个端点无需鉴权、带 CORS `*`，
 * 但字段没有公开文档承诺，因此解析保持宽松：任何异常都退化为"没有额度"，
 * 绝不影响模型目录本身。
 */

/** 额度端点默认地址。 */
export const OPENCODE_GO_LIMITS_URL = 'https://opencode.ai/inference/go/v1/models'

/** 官方提供的三个订阅档位；顺序用于界面稳定展示。 */
export const LIMIT_PLANS = ['go', 'go-plus', 'go-teams'] as const

/** 订阅档位标识。 */
export type LimitPlan = (typeof LIMIT_PLANS)[number]

/** 单个模型的额度：某档为 null 表示不计量（免费），缺失表示该档未提供。 */
export type ModelLimit = Partial<Record<LimitPlan, number | null>>

/** 一次抓取的完整结果：模型 id → 额度。 */
export type LimitTable = Readonly<Record<string, ModelLimit>>

/** 额度来源的窄接口，便于测试与代理覆盖。 */
export interface LimitsSource {
  fetchLimits(signal: AbortSignal): Promise<LimitTable>
}

/** 额度来源的端点与 Fetch 覆盖。 */
export interface LimitsSourceOptions {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析端点响应。
 *
 * `data` 里每项至少要有字符串 `id`；`go.monthly_usage` 里的每个档位只在是
 * 有限非负数或 `null` 时被采纳。未知档位、非数字、负数一律忽略而不是报错——
 * 上游新增字段或改类型时，插件应降级显示而不是整体失败。
 * @param body - 已解析的 JSON 响应。
 * @returns 模型 id 到额度的映射；结构不符时返回空表。
 */
export function parseLimits(body: unknown): LimitTable {
  if (!isRecord(body) || !Array.isArray(body.data)) return {}
  const table: Record<string, ModelLimit> = {}
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    if (!isRecord(entry.go)) continue
    const usage = entry.go.monthly_usage
    // `monthly_usage: null` 是官方对"所有档位都不计量"的表达（免费模型），
    // 必须映射成三档全 ∞，而不是当作结构不符跳过——否则免费模型会显示横杠。
    if (usage === null) {
      table[entry.id] = Object.fromEntries(LIMIT_PLANS.map(plan => [plan, null])) as ModelLimit
      continue
    }
    if (!isRecord(usage)) continue
    const limit: ModelLimit = {}
    let any = false
    for (const plan of LIMIT_PLANS) {
      const value = usage[plan]
      if (value === null) {
        limit[plan] = null
        any = true
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        limit[plan] = value
        any = true
      }
    }
    if (any) table[entry.id] = limit
  }
  return table
}

/**
 * 创建额度来源适配器。
 * @param options - 端点和 Fetch 覆盖，用于代理与测试替身。
 * @returns 可注入刷新器的额度来源客户端。
 */
export function createLimitsSource(options: LimitsSourceOptions = {}): LimitsSource {
  const baseUrl = options.baseUrl ?? OPENCODE_GO_LIMITS_URL
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async fetchLimits(signal: AbortSignal): Promise<LimitTable> {
      const response = await fetcher(baseUrl, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw new Error(`llm-opencode-go-live: limits endpoint answered ${response.status}`)
      }
      return parseLimits(await response.json())
    },
  }
}
