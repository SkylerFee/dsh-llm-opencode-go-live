import type {} from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { setTimeout as delay } from 'node:timers/promises'
import { Config, resolveConfig } from './config.js'
import type { ResolvedConfig } from './config.js'
import { createUsageSource } from './balance.js'
import type { UsageEnvelope, UsageSource } from './balance.js'
import { createDynamicAdapter, ROUTE_ID } from './provider.js'
import { createModelsSource } from './source.js'
import type { ModelsSource } from './source.js'
import { JsonCatalogStore, MemoryCatalogStore } from './store.js'
import type { CatalogSnapshot, CatalogStore } from './store.js'
import { transformProvider } from './transform.js'

export { Config, resolveConfig } from './config.js'
export type { CatalogConfig, ResolvedConfig } from './config.js'
export { createUsageSource, OPENCODE_GO_USAGE_URL, parseUsageResponse } from './balance.js'
export type { UsageEnvelope, UsageErrorCode, UsageReport, UsageSource, UsageWindow } from './balance.js'
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

/** 浏览器可访问的余额路由；client.js 以平行常量引用同一路径。 */
export const BALANCE_ROUTE_PATH = '/api/opencode-go-live/balance'
const USAGE_TIMEOUT_MS = 10_000

/**
 * 宿主 Fetch 路由注册面。
 * 与 `@deepseek-ai/dsh-client-connection` 的 host 契约一致；按服务发现使用，
 * 使发布包不必新增该依赖（与既有 `ctx.get('fs')` 的反射式窄接口同一姿态）。
 */
interface HostFetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

interface HostConnectionFace {
  fetch: { register(route: HostFetchRoute): () => void }
}

/** 携带可选浏览器载体的上下文视图；`connection` 未挂载时为 undefined。 */
interface ContextWithConnection extends Context {
  connection?: HostConnectionFace
}

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
 * 解析当前路由的 API Key。
 * 模型适配器与余额路由共用同一条凭据路径，避免两处对引用名与校验的理解分叉。
 * @param ctx - Cordis 上下文。
 * @param apiKeyEnv - 凭据引用名。
 * @returns 可用的 API Key。
 */
async function resolveLiveApiKey(ctx: Context, apiKeyEnv: string): Promise<string> {
  const ref = credentialRef(apiKeyEnv)
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError('llm-opencode-go-live: credentials service is not mounted', 'MISSING_CREDENTIAL')
  }
  const value = (await credentials.resolve(ref))?.value
  if (value === undefined) {
    throw new LlmError(`llm-opencode-go-live: missing credential ${ref}`, 'MISSING_CREDENTIAL')
  }
  return assertUsableApiKey(value, 'llm-opencode-go-live', ref)
}

/**
 * 余额路由处理器：解析 API Key、查询上游用量并返回统一响应包。
 * 认证由 `/api` 桥在到达本处理器之前完成；本处理器始终返回 HTTP 200，
 * 客户端按 envelope 的 code 渲染本地化文案。
 * @param ctx - Cordis 上下文。
 * @param apiKeyEnv - 读取当前凭据引用的函数；与模型适配器一样按请求取值，volatile 变更立即生效。
 * @param source - 用量来源；测试与代理可覆盖端点。
 * @param request - 浏览器请求；其 signal 与超时共同约束上游访问。
 * @returns JSON 响应，不包含密钥或上游响应原文。
 */
async function balanceRoute(
  ctx: Context,
  apiKeyEnv: () => string,
  source: UsageSource,
  request: Request,
): Promise<Response> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(USAGE_TIMEOUT_MS)])
  let envelope: UsageEnvelope
  try {
    const apiKey = await resolveLiveApiKey(ctx, apiKeyEnv())
    envelope = await source.fetchUsage(apiKey, signal)
  } catch (error) {
    if (error instanceof LlmError) {
      envelope = { ok: false, code: 'MISSING_CREDENTIAL', message: error.message }
    } else {
      envelope = { ok: false, code: 'UNKNOWN', message: 'llm-opencode-go-live: balance route failed' }
      ctx.logger.warn(`llm-opencode-go-live: balance route failed (${String(error)})`)
    }
  }
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
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
  const resolvedConfig = resolveConfig({ apiKeyEnv: config.apiKeyEnv.get(), catalog: config.catalog, showBalanceOverlay: config.showBalanceOverlay?.get() })
  const usageSource = createUsageSource()
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
      () => resolveLiveApiKey(ctx, config.apiKeyEnv.get()),
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
  // 余额路由是可选能力：纯 CLI composition 不挂载 connection，此时不注册也不报错。
  ctx.inject(['connection'], (child) => {
    const connection = (child as ContextWithConnection).connection
    if (connection === undefined) return
    child.effect(() => connection.fetch.register({
      path: BALANCE_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => balanceRoute(child, () => config.apiKeyEnv.get(), usageSource, request),
    }))
  })
  void runtime.start().catch(error => {
    ctx.logger.error(`llm-opencode-go-live: startup failed (${String(error)})`)
  })
  ctx.effect(() => () => runtime.dispose())
}
