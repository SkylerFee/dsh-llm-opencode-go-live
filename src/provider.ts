import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import type { CatalogSnapshot } from './store.js'

/** 动态路由固定身份。 */
export const ROUTE_ID = 'opencode-go-live'
export const DISPLAY_NAME = 'OpenCode Go (Live)'
type SupportedModel = Model<'openai-responses' | 'openai-completions' | 'anthropic-messages'>

/** 直接注册到 Harness `ctx.llm` 的适配器所需的密钥解析器。 */
export type ApiKeyResolver = () => Promise<string>

/**
 * 复用 pi-ai 内置 OpenCode Go 的请求实现，只替换路由身份和动态模型快照。
 * @param models - 已完成来源校验的动态模型。
 * @returns 使用内置 mixed-API 传输实现的动态 Provider。
 */
export function createDynamicProvider(models: readonly Model<Api>[]): Provider {
  const base = opencodeGoProvider()
  const requestModel = (model: Model<Api>): SupportedModel => ({
    ...model,
    // 保留 live 路由给 Harness 解析；pi-ai 请求层需要 OpenCode Go 身份来启用兼容处理。
    provider: 'opencode-go',
  } as SupportedModel)
  return {
    id: ROUTE_ID,
    name: DISPLAY_NAME,
    ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
    ...(base.headers === undefined ? {} : { headers: base.headers }),
    auth: base.auth,
    getModels: () => models,
    stream: (model, context, options) => base.stream(requestModel(model), context, options as never),
    streamSimple: (model, context, options) => base.streamSimple(requestModel(model), context, options as never),
  }
}

const EMPTY_CREDENTIALS: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_provider, mutate) => mutate(undefined),
  delete: async () => undefined,
}

const DEFAULT_RETRY_POLICY: ResolvedPiAiProviderProfile['retryPolicy'] = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

function profileFor(models: readonly Model<Api>[]): ResolvedPiAiProviderProfile {
  return {
    provider: ROUTE_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: DEFAULT_RETRY_POLICY,
    piProvider: createDynamicProvider(models),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
  }
}

/**
 * 创建直接挂载到 Harness `ctx.llm` 的原生适配器。
 * @param snapshot - 返回最近一次成功目录快照的函数。
 * @param resolveApiKey - 每次请求解析 OpenCode Go 凭据的函数。
 * @returns 可传给 `ctx.llm.registerAdapter()` 的 LLM 适配器。
 */
export function createDynamicAdapter(
  snapshot: () => CatalogSnapshot | undefined,
  resolveApiKey: ApiKeyResolver,
): PiAiAdapter {
  let observed: CatalogSnapshot | undefined
  let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[ROUTE_ID, profileFor([])]])
  const options: PiAiAdapterOptions = {
    profiles: () => {
      const next = snapshot()
      if (next === observed) return profiles
      observed = next
      profiles = new Map([[ROUTE_ID, profileFor(next?.models ?? [])]])
      return profiles
    },
    resolveApiKey: async () => resolveApiKey(),
    auth: {
      credentials: EMPTY_CREDENTIALS,
      authContext: {
        env: async name => process.env[name],
        fileExists: async () => false,
      },
    },
  }
  return new PiAiAdapter(options)
}
