import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { Config, ResolvedConfig } from './config.js'
import { createDynamicAdapter, ROUTE_ID } from './provider.js'
import { createModelsSource } from './source.js'
import type { ModelsSource } from './source.js'
import { MemoryCatalogStore } from './store.js'
import type { CatalogSnapshot, CatalogStore } from './store.js'
import { transformProvider } from './transform.js'

export { resolveConfig } from './config.js'
export type { Config, CatalogConfig, ResolvedConfig } from './config.js'
export { OPEN_CODE_GO_POLICIES, policyFor } from './policy.js'
export type { OpenCodeGoApi, OpenCodeGoPolicy } from './policy.js'
export { createModelsSource } from './source.js'
export type { ModelsSource, ModelsSourceOptions, SourceModel, SourceProvider } from './source.js'
export { JsonCatalogStore, MemoryCatalogStore } from './store.js'
export type { CatalogSnapshot, CatalogStore } from './store.js'
export { transformProvider } from './transform.js'
export type { CatalogDiagnostic, TransformResult } from './transform.js'
export { createDynamicAdapter, createDynamicProvider, DISPLAY_NAME, ROUTE_ID } from './provider.js'

export const name = 'llm-opencode-go-live'
export const inject = ['llm']
const STARTUP_RETRY_MS = 15_000
const MAX_STARTUP_RETRIES = 4

interface RuntimeOptions {
  config: ResolvedConfig
  source: ModelsSource
  store: CatalogStore
  logger: Pick<Context['logger'], 'info' | 'warn' | 'error'>
}

/** 目录运行时，负责快照恢复和原子刷新。 */
export class OpenCodeGoLiveRuntime {
  private snapshot: CatalogSnapshot | undefined
  private refreshPromise: Promise<CatalogSnapshot | undefined> | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  private disposed = false

  public constructor(private readonly options: RuntimeOptions) {}

  /** 恢复快照并按配置执行启动刷新。 */
  async start(): Promise<void> {
    this.snapshot = await this.options.store.load()
    if (this.options.config.catalog.refreshOnStart) {
      for (let attempt = 0; attempt <= MAX_STARTUP_RETRIES && !this.disposed; attempt += 1) {
        if (await this.refresh() !== undefined) break
        if (attempt < MAX_STARTUP_RETRIES) await new Promise(resolve => setTimeout(resolve, STARTUP_RETRY_MS))
      }
    }
    if (this.disposed) return
    const interval = this.options.config.catalog.refreshIntervalMs
    if (interval > 0 && this.refreshTimer === undefined) {
      this.refreshTimer = setInterval(() => { void this.refresh() }, interval)
      this.refreshTimer.unref?.()
    }
  }

  /** 获取当前目录快照。 */
  getSnapshot(): CatalogSnapshot | undefined {
    return this.snapshot
  }

  /**
   * 刷新来源并在完整转换成功后发布。
   * @returns 成功快照；失败时保留旧快照并返回 undefined。
   */
  async refresh(): Promise<CatalogSnapshot | undefined> {
    if (this.refreshPromise !== undefined) return this.refreshPromise
    this.refreshPromise = this.refreshOnce().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  /** 释放刷新任务；路由注册由 Cordis 入口持有。 */
  dispose(): void {
    this.disposed = true
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  private async refreshOnce(): Promise<CatalogSnapshot | undefined> {
    const timeout = this.options.config.catalog.refreshTimeoutMs
    const controller = new AbortController()
    const timer = timeout === 0 ? undefined : setTimeout(() => controller.abort(), timeout)
    try {
      const source = await this.options.source.fetchProvider(controller.signal)
      const result = transformProvider(source)
      if (result.models.length === 0 && result.diagnostics.some(item => item.code !== 'DEPRECATED_MODEL')) {
        throw new Error('llm-opencode-go-live: source produced no valid models')
      }
      const snapshot: CatalogSnapshot = {
        version: 1,
        checkedAt: new Date().toISOString(),
        models: result.models,
        diagnostics: result.diagnostics,
      }
      await this.options.store.save(snapshot)
      this.snapshot = snapshot
      this.options.logger.info(`llm-opencode-go-live: refreshed ${result.models.length} models`)
      return snapshot
    } catch (error) {
      this.options.logger.warn(`llm-opencode-go-live: refresh failed; keeping the last successful snapshot (${String(error)})`)
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

}

/**
 * Cordis 插件入口。插件直接注册 Harness 原生 LLM 适配器。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(
  ctx: Context & { llm: { registerAdapter(providers: string[], adapter: unknown): () => void } },
  config: Config,
): void {
  const resolvedConfig = resolveConfig(config)
  const runtime = new OpenCodeGoLiveRuntime({
    config: resolvedConfig,
    source: createModelsSource(),
    store: new MemoryCatalogStore(),
    logger: ctx.logger,
  })
  ctx.llm.registerAdapter(
    [ROUTE_ID],
    createDynamicAdapter(
      () => runtime.getSnapshot(),
      async () => {
        const credentials = ctx.get('credentials' as never) as { resolve(ref: string): Promise<{ value?: string } | undefined> } | undefined
        const value = (await credentials?.resolve(resolvedConfig.apiKeyEnv))?.value ?? process.env[resolvedConfig.apiKeyEnv]
        if (value === undefined || value.trim().length === 0) {
          throw new Error(`llm-opencode-go-live: missing credential ${resolvedConfig.apiKeyEnv}`)
        }
        return value.trim()
      },
    ),
  )
  void runtime.start().catch(error => {
    ctx.logger.error(`llm-opencode-go-live: startup failed (${String(error)})`)
  })
  ctx.effect(() => () => runtime.dispose())
}
