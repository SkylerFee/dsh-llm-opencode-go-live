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

/** 将策略协议转换为 pi-ai 的 API 类型。 */
export function apiOf(policy: OpenCodeGoPolicy): Api {
  return policy.api
}
