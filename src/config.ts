import { isAbsolute } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'

/** OpenCode Go 动态目录插件的配置。 */
export interface Config {
  /** Harness 凭据引用，不是 API Key 本身。 */
  apiKeyEnv: Volatile<string>
  /** 目录刷新策略。 */
  catalog?: CatalogConfig
  /**
   * 是否在 Web 客户端渲染余额悬浮面板。
   * 仅客户端消费：Host 运行时不读取该值，只把它作为 volatile 字段暴露给供应商卡片编辑。
   */
  showBalanceOverlay?: Volatile<boolean>
}

/**
 * 暴露凭据引用供供应商页面编辑，目录参数仍由插件配置管理。
 * 默认引用名取自 live 路由，避免与 Models 页为内置 `opencode-go` 派生的 `OPENCODE_GO_API_KEY` 撞名。
 * `showBalanceOverlay` 保持顶层 volatile 字段：嵌套对象的 volatile 投影未经验证，顶层与 `apiKeyEnv` 同构。
 */
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENCODE_GO_LIVE_API_KEY').volatile(),
  catalog: z.object({
    cachePath: z.string(),
    refreshOnStart: z.boolean(),
    refreshIntervalMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
    refreshTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  showBalanceOverlay: z.boolean().default(true).volatile(),
})

/** 目录刷新配置。 */
export interface CatalogConfig {
  /**
   * 可选的绝对路径；启用跨重启目录恢复。
   * bundle 的 `cordis.patch.yml` 默认将其设为 Harness home 下的 `cache/opencode-go-live.json`
   * （默认即 `~/.dsh/cache/opencode-go-live.json`，设置 `$DSH_HOME` 时位于其下）；未设置时目录只保存在内存。
   */
  cachePath?: string
  /** 启动后是否允许网络刷新。默认值为 true。 */
  refreshOnStart?: boolean
  /** 连续刷新间隔；零表示仅启动和显式刷新。 */
  refreshIntervalMs?: number
  /** 单次来源访问超时。 */
  refreshTimeoutMs?: number
}

/** 已解析的不可变配置。 */
export interface ResolvedConfig {
  apiKeyEnv: CredentialRef
  catalog: {
    cachePath?: string
    refreshOnStart: boolean
    refreshIntervalMs: number
    refreshTimeoutMs: number
  }
  /** 余额悬浮面板的展示意图；客户端读取，Host 不消费。 */
  showBalanceOverlay: boolean
}

const DEFAULTS: ResolvedConfig['catalog'] = {
  refreshOnStart: true,
  refreshIntervalMs: 21_600_000,
  refreshTimeoutMs: 10_000,
}

const DEFAULT_SHOW_BALANCE_OVERLAY = true

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
  const apiKeyEnv = credentialRef(input.apiKeyEnv)
  const catalog = isRecord(input.catalog) ? input.catalog : {}
  if (catalog.cachePath !== undefined && (typeof catalog.cachePath !== 'string' || !isAbsolute(catalog.cachePath))) {
    throw new TypeError('llm-opencode-go-live: catalog.cachePath must be an absolute path')
  }
  const refreshOnStart = catalog.refreshOnStart === undefined ? DEFAULTS.refreshOnStart : catalog.refreshOnStart
  if (typeof refreshOnStart !== 'boolean') {
    throw new TypeError('llm-opencode-go-live: catalog.refreshOnStart must be boolean')
  }
  const showBalanceOverlay = input.showBalanceOverlay === undefined
    ? DEFAULT_SHOW_BALANCE_OVERLAY
    : input.showBalanceOverlay
  if (typeof showBalanceOverlay !== 'boolean') {
    throw new TypeError('llm-opencode-go-live: showBalanceOverlay must be boolean')
  }
  const resolved: ResolvedConfig = {
    apiKeyEnv,
    catalog: {
      ...(catalog.cachePath === undefined ? {} : { cachePath: catalog.cachePath }),
      refreshOnStart,
      refreshIntervalMs: catalog.refreshIntervalMs === undefined
        ? DEFAULTS.refreshIntervalMs
        : nonNegativeSafeInteger(catalog.refreshIntervalMs, 'catalog.refreshIntervalMs'),
      refreshTimeoutMs: catalog.refreshTimeoutMs === undefined
        ? DEFAULTS.refreshTimeoutMs
        : nonNegativeSafeInteger(catalog.refreshTimeoutMs, 'catalog.refreshTimeoutMs'),
    },
    showBalanceOverlay,
  }
  return Object.freeze({
    apiKeyEnv: resolved.apiKeyEnv,
    catalog: Object.freeze(resolved.catalog),
    showBalanceOverlay,
  })
}
