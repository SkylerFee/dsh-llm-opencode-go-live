import type {} from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { setTimeout as delay } from 'node:timers/promises'
import { Config, resolveConfig } from './config.js'
import type { ResolvedConfig } from './config.js'
import { createDynamicAdapter, ROUTE_ID } from './provider.js'
import { createModelsSource } from './source.js'
import type { ModelsSource } from './source.js'
import { JsonCatalogStore, MemoryCatalogStore } from './store.js'
import type { CatalogSnapshot, CatalogStore } from './store.js'
import { transformProvider } from './transform.js'

export { Config, resolveConfig } from './config.js'
export type { CatalogConfig, ResolvedConfig } from './config.js'
export { OPEN_CODE_GO_POLICIES, policyFor } from './policy.js'
export type { OpenCodeGoApi, OpenCodeGoPolicy } from './policy.js'
export { createModelsSource } from './source.js'
export type { ModelsSource, ModelsSourceOptions, SourceModel, SourceProvider } from './source.js'
export { JsonCatalogStore, MemoryCatalogStore } from './store.js'
export type { CatalogSnapshot, CatalogStore } from './store.js'
export { transformProvider } from './transform.js'
export type { CatalogDiagnostic, TransformResult } from './transform.js'
export { createDynamicAdapter, createDynamicProvider, DISPLAY_NAME, ROUTE_ID } from './provider.js'
export type { MediaResolution } from './provider.js'

export const name = 'llm-opencode-go-live'
export const inject = ['llm', 'credentials']
const STARTUP_RETRY_MS = 15_000
const MAX_STARTUP_RETRIES = 4

interface RuntimeOptions {
  config: ResolvedConfig
  source: ModelsSource
  store: CatalogStore
  logger: Pick<Context['logger'], 'info' | 'warn' | 'error'>
  onCatalogUpdated?: () => void
}

/** 目录运行时，负责快照恢复和原子刷新。 */
export class OpenCodeGoLiveRuntime {
  private snapshot: CatalogSnapshot | undefined
  private refreshPromise: Promise<CatalogSnapshot | undefined> | undefined
  private startupPromise: Promise<void> | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  private activeRefresh: AbortController | undefined
  private readonly lifetime = new AbortController()
  private disposed = false

  public constructor(private readonly options: RuntimeOptions) {}

  /** 恢复快照并按配置执行启动刷新。 */
  start(): Promise<void> {
    this.startupPromise ??= this.startOnce()
    return this.startupPromise
  }

  private async startOnce(): Promise<void> {
    const snapshot = await this.options.store.load()
    if (this.disposed) return
    this.snapshot = snapshot
    if (snapshot !== undefined) this.options.onCatalogUpdated?.()
    if (this.options.config.catalog.refreshOnStart) {
      for (let attempt = 0; attempt <= MAX_STARTUP_RETRIES && !this.disposed; attempt += 1) {
        if (await this.refresh() !== undefined) break
        if (attempt < MAX_STARTUP_RETRIES && !this.disposed) {
          try {
            await delay(STARTUP_RETRY_MS, undefined, { signal: this.lifetime.signal })
          } catch (error) {
            if (!this.disposed) throw error
          }
        }
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
    if (this.disposed) return undefined
    if (this.refreshPromise !== undefined) return this.refreshPromise
    this.refreshPromise = this.refreshOnce().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  /** 中止并等待刷新任务结束；路由注册由 Cordis 入口持有。 */
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort()
    this.activeRefresh?.abort()
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
    await this.startupPromise?.catch(() => undefined)
    await this.refreshPromise
  }

  private async refreshOnce(): Promise<CatalogSnapshot | undefined> {
    const timeout = this.options.config.catalog.refreshTimeoutMs
    const controller = new AbortController()
    this.activeRefresh = controller
    const timer = timeout === 0 ? undefined : setTimeout(() => controller.abort(), timeout)
    try {
      const source = await this.options.source.fetchProvider(controller.signal)
      if (this.disposed) return undefined
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
      if (this.disposed) return undefined
      this.snapshot = snapshot
      this.options.onCatalogUpdated?.()
      this.options.logger.info(`llm-opencode-go-live: refreshed ${result.models.length} models`)
      return snapshot
    } catch (error) {
      if (!this.disposed) {
        this.options.logger.warn(`llm-opencode-go-live: refresh failed; keeping the last successful snapshot (${String(error)})`)
      }
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.activeRefresh = undefined
    }
  }

}

/**
 * Cordis 插件入口。插件直接注册 Harness 原生 LLM 适配器。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(
  ctx: Context,
  config: Config,
): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const resolvedConfig = resolveConfig({ apiKeyEnv: config.apiKeyEnv.get(), catalog: config.catalog })
  const runtime = new OpenCodeGoLiveRuntime({
    config: resolvedConfig,
    source: createModelsSource(),
    store: resolvedConfig.catalog.cachePath === undefined
      ? new MemoryCatalogStore()
      : new JsonCatalogStore(resolvedConfig.catalog.cachePath),
    logger: ctx.logger,
    onCatalogUpdated: () => registration.replace([ROUTE_ID]),
  })
  const registration = ctx.llm.registerAdapter(
    [ROUTE_ID],
    createDynamicAdapter(
      () => runtime.getSnapshot(),
      async () => {
        const ref = credentialRef(config.apiKeyEnv.get())
        const credentials = ctx.get('credentials')
        if (credentials === undefined) {
          throw new LlmError('llm-opencode-go-live: credentials service is not mounted', 'MISSING_CREDENTIAL')
        }
        const value = (await credentials.resolve(ref))?.value
        if (value === undefined) {
          throw new LlmError(`llm-opencode-go-live: missing credential ${ref}`, 'MISSING_CREDENTIAL')
        }
        return assertUsableApiKey(value, 'llm-opencode-go-live', ref)
      },
      {
        // 宿主附件服务与文件系统映射按请求解析，与内置适配器的接线一致；
        // 挂载缺失时请求中的图片被明确拒绝，而不是静默丢弃。
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
          attachments,
          hostPath => (ctx.get('fs') as { processPathFromHostPath(hostPath: string): string | undefined } | undefined)
            ?.processPathFromHostPath(hostPath),
          ref,
        ),
      },
    ),
  )
  void runtime.start().catch(error => {
    ctx.logger.error(`llm-opencode-go-live: startup failed (${String(error)})`)
  })
  ctx.effect(() => () => runtime.dispose())
}
