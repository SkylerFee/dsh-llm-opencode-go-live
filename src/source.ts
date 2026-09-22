/** Models.dev 提供方目录的最小结构。 */
export interface SourceProvider {
  models?: Record<string, SourceModel>
}

/** Models.dev 模型字段；其余外部字段不会进入请求。 */
export interface SourceModel {
  name?: string
  status?: 'alpha' | 'beta' | 'deprecated'
  tool_call?: boolean
  reasoning?: boolean
  limit?: {
    context?: number
    output?: number
  }
  modalities?: {
    input?: string[]
  }
}

/** 来源客户端的可测试窄接口。 */
export interface ModelsSource {
  fetchProvider(signal: AbortSignal): Promise<SourceProvider>
}

/** 来源客户端的端点和 Fetch 覆盖。 */
export interface ModelsSourceOptions {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

const DEFAULT_BASE_URL = 'https://models.dev'

interface ModelsClient {
  providers(): Promise<unknown>
}

interface ModelsModule {
  Models: {
    make(options?: { baseUrl?: string; fetch?: typeof globalThis.fetch }): ModelsClient
  }
}

/**
 * 创建 Models.dev 来源适配器。
 * @param options - 端点和 Fetch 覆盖，用于代理和测试替身。
 * @returns 可注入到刷新器的来源客户端。
 */
export function createModelsSource(options: ModelsSourceOptions = {}): ModelsSource {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async fetchProvider(signal: AbortSignal): Promise<SourceProvider> {
      const module = await import('@opencode-ai/models') as unknown as ModelsModule
      const client = module.Models.make({
        baseUrl,
        fetch: (input, init) => fetcher(input, { ...init, signal }),
      })
      const providers = await client.providers()
      if (!isRecord(providers)) throw new TypeError('llm-opencode-go-live: source returned a non-object catalog')
      const provider = providers['opencode-go']
      if (!isRecord(provider)) throw new Error('llm-opencode-go-live: source has no opencode-go provider')
      return provider as SourceProvider
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
