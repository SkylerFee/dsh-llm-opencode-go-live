import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'

/** OpenCode Go 支持的 pi-ai 传输协议。 */
export type OpenCodeGoApi = 'openai-responses' | 'openai-completions' | 'anthropic-messages'

/** 一个模型的受版本控制调用策略。 */
export interface OpenCodeGoPolicy {
  api: OpenCodeGoApi
  baseUrl: string
  /** 能力未知时保持 false，要求来源明确声明工具调用。 */
  supportsTools: boolean
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>
  compat?: Model<Api>['compat']
}

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

const DEFAULT_POLICY: OpenCodeGoPolicy = Object.freeze({
  api: 'openai-completions',
  baseUrl: DEFAULT_BASE_URL,
  supportsTools: false,
})

const SUPPORTED_APIS: readonly OpenCodeGoApi[] = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
]

function isSupportedApi(api: string): api is OpenCodeGoApi {
  return SUPPORTED_APIS.includes(api as OpenCodeGoApi)
}

function policyFromModel(model: Model<Api>): OpenCodeGoPolicy | undefined {
  if (!isSupportedApi(model.api)) return undefined
  return {
    api: model.api,
    baseUrl: model.baseUrl,
    supportsTools: false,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    ...(model.compat === undefined ? {} : { compat: model.compat }),
  }
}

/**
 * 以当前使用的 pi-ai OpenCode Go 模型补充已知特殊协议策略。
 * 来源目录决定成员资格；没有特殊策略的新模型使用通用 Completions 策略。
 */
export const OPEN_CODE_GO_POLICIES: Readonly<Record<string, OpenCodeGoPolicy>> = Object.freeze(
  Object.fromEntries(
    opencodeGoProvider()
      .getModels()
      .flatMap((model) => {
        const policy = policyFromModel(model)
        return policy === undefined ? [] : [[model.id, Object.freeze(policy)] as const]
      }),
  ),
)

/**
 * 查找模型的调用策略。
 *
 * 远端目录决定模型是否存在；pi-ai 表只为已知模型提供特殊协议和兼容字段。
 * 新模型默认使用 OpenCode Go 的通用 Completions 端点，避免静态表阻止目录扩容。
 * @param modelId - 来源目录模型 ID。
 * @returns 已知模型的策略或通用动态策略。
 */
export function policyFor(modelId: string): OpenCodeGoPolicy {
  return OPEN_CODE_GO_POLICIES[modelId] ?? DEFAULT_POLICY
}

/**
 * 统计每个协议下有多少已知模型使用同一个端点。
 *
 * 上游把同一系列模型放在一起时，同一协议通常只对应一个端点；端点分散说明
 * pi-ai 的静态表与来源目录已经错位（例如协议升级后新旧模型混在了同一组里）。
 * 深度小于 2 的值不出现在结果中——只有一个模型时谈不上"不一致"。
 */
const API_BASE_URL_VARIANTS: Readonly<Record<OpenCodeGoApi, number>> = (() => {
  const seen = new Map<OpenCodeGoApi, Set<string>>()
  for (const policy of Object.values(OPEN_CODE_GO_POLICIES)) {
    const set = seen.get(policy.api) ?? new Set<string>()
    set.add(policy.baseUrl)
    seen.set(policy.api, set)
  }
  return Object.fromEntries([...seen].map(([api, urls]) => [api, urls.size])) as Record<OpenCodeGoApi, number>
})()

/**
 * 判断已知策略在协议与端点的组合上是否自洽。
 *
 * 借鉴官方 Console 集成按 provider 分组校验的做法：同一 provider 下允许的协议由
 * 该组模型共同声明的端点决定，做不到一致时整体降级到最保守的协议，而不是让
 * 每个模型各说各话。这里只做诊断——目录成员仍由来源决定，不因策略表抖动而丢模型。
 * @param api - 待校验的 pi-ai 传输协议。
 * @param baseUrl - 该协议对应的上游端点。
 * @returns 该组合是否有一致的已知模型支撑。
 */
export function isPolicyConsistent(api: OpenCodeGoApi, baseUrl: string): boolean {
  // 通用 Completions 是默认降级目标：来源里的新模型本来就没有已知策略。
  if (api === 'openai-completions' && baseUrl === DEFAULT_BASE_URL) return true
  for (const policy of Object.values(OPEN_CODE_GO_POLICIES)) {
    if (policy.api === api) return policy.baseUrl === baseUrl
  }
  return false
}

/**
 * 统计每个协议下的端点数量，供调用方判断策略表是否出现分组歧义。
 * @returns 每个协议对应的不同端点个数；未出现的协议不在结果中。
 */
export function policyBaseUrlVariants(): Readonly<Partial<Record<OpenCodeGoApi, number>>> {
  return API_BASE_URL_VARIANTS
}

/** 将策略协议转换为 pi-ai 的 API 类型。 */
export function apiOf(policy: OpenCodeGoPolicy): Api {
  return policy.api
}
