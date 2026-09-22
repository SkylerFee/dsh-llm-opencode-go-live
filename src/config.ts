/** OpenCode Go 动态目录插件的配置。 */
export interface Config {
  /** Harness 凭据引用，不是 API Key 本身。 */
  apiKeyEnv: string
  /** 目录刷新策略。 */
  catalog?: CatalogConfig
}

/** 目录刷新配置。 */
export interface CatalogConfig {
  /** 启动后是否允许网络刷新。默认值为 true。 */
  refreshOnStart?: boolean
  /** 连续刷新间隔；零表示仅启动和显式刷新。 */
  refreshIntervalMs?: number
  /** 单次来源访问超时。 */
  refreshTimeoutMs?: number
}

/** 已解析的不可变配置。 */
export interface ResolvedConfig {
  apiKeyEnv: string
  catalog: {
    refreshOnStart: boolean
    refreshIntervalMs: number
    refreshTimeoutMs: number
  }
}

const DEFAULTS: ResolvedConfig['catalog'] = {
  refreshOnStart: true,
  refreshIntervalMs: 21_600_000,
  refreshTimeoutMs: 10_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`llm-opencode-go-live: ${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * 校验并解析插件配置。
 * @param input - Cordis 配置输入。
 * @returns 可供运行时使用的配置快照。
 */
export function resolveConfig(input: unknown): ResolvedConfig {
  if (!isRecord(input) || typeof input.apiKeyEnv !== 'string' || input.apiKeyEnv.length === 0) {
    throw new TypeError('llm-opencode-go-live: apiKeyEnv is required')
  }
  const catalog = isRecord(input.catalog) ? input.catalog : {}
  const refreshOnStart = catalog.refreshOnStart === undefined ? DEFAULTS.refreshOnStart : catalog.refreshOnStart
  if (typeof refreshOnStart !== 'boolean') {
    throw new TypeError('llm-opencode-go-live: catalog.refreshOnStart must be boolean')
  }
  const resolved: ResolvedConfig = {
    apiKeyEnv: input.apiKeyEnv,
    catalog: {
      refreshOnStart,
      refreshIntervalMs: catalog.refreshIntervalMs === undefined
        ? DEFAULTS.refreshIntervalMs
        : nonNegativeSafeInteger(catalog.refreshIntervalMs, 'catalog.refreshIntervalMs'),
      refreshTimeoutMs: catalog.refreshTimeoutMs === undefined
        ? DEFAULTS.refreshTimeoutMs
        : nonNegativeSafeInteger(catalog.refreshTimeoutMs, 'catalog.refreshTimeoutMs'),
    },
  }
  return Object.freeze({
    apiKeyEnv: resolved.apiKeyEnv,
    catalog: Object.freeze(resolved.catalog),
  })
}
