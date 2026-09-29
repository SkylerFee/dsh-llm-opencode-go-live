import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Api, CredentialStore, Model, Provider, StreamOptions } from '@earendil-works/pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import type { CatalogSnapshot } from './store.js'

/** 动态路由固定身份。 */
export const ROUTE_ID = 'opencode-go-live'
export const DISPLAY_NAME = 'OpenCode Go (Live)'
type SupportedModel = Model<'openai-responses' | 'openai-completions' | 'anthropic-messages'>

/** 直接注册到 Harness `ctx.llm` 的适配器所需的密钥解析器。 */
export type ApiKeyResolver = () => Promise<string>

/**
 * 将 Harness 会话标识传给 OpenCode Go 的所有请求协议。
 * @param options - pi-ai 请求参数。
 * @returns 保留原参数并附加会话请求头的参数。
 */
function withSessionHeader<T extends StreamOptions>(options: T | undefined): T | undefined {
  if (options?.sessionId === undefined) return options
  return { ...options, headers: { ...options.headers, 'x-opencode-session': options.sessionId } }
}

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
    stream: (model, context, options) => base.stream(requestModel(model), context, withSessionHeader(options) as never),
    streamSimple: (model, context, options) => base.streamSimple(requestModel(model), context, withSessionHeader(options)),
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
 * 宿主媒体解析依赖：durable 附件存储与图片执行世界路径桥接。
 * 两个钩子来自宿主 `attachments`/`fs` 服务；缺失时请求中的图片引用会被拒绝，
 * 文件块不受影响（请求组装层已把文件投影为句柄文本）。
 */
export type MediaResolution = Pick<PiAiAdapterOptions, 'resolveAttachments' | 'resolveImageAccess'>

/**
 * 创建直接挂载到 Harness `ctx.llm` 的原生适配器。
 * @param snapshot - 返回最近一次成功目录快照的函数。
 * @param resolveApiKey - 每次请求解析 OpenCode Go 凭据的函数。
 * @param media - 可选的宿主附件解析钩子；注入后请求历史中的图片引用会解析为实际图片内容，
 *   与宿主内置适配器的图片/文件输入行为一致。
 * @returns 可传给 `ctx.llm.registerAdapter()` 的 LLM 适配器。
 */
export function createDynamicAdapter(
  snapshot: () => CatalogSnapshot | undefined,
  resolveApiKey: ApiKeyResolver,
  media: MediaResolution = {},
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
    ...media,
  }
  return new PiAiAdapter(options)
}
