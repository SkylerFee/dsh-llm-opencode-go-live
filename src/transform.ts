import type { Api, Model } from '@earendil-works/pi-ai'
import { apiOf, isPolicyConsistent, policyFor } from './policy.js'
import { vendorOf } from './vendor.js'
import type { OpenCodeGoApi } from './policy.js'
import type { SourceModel, SourceProvider } from './source.js'

/** 单条目录诊断。 */
export interface CatalogDiagnostic {
  modelId?: string
  code: 'INVALID_SOURCE' | 'DEPRECATED_MODEL' | 'INVALID_LIMIT' | 'UNSUPPORTED_INPUT' | 'MISSING_TOOL_CALL'
    | 'POLICY_GROUP_MISMATCH'
  message: string
}

/** 转换后的模型及其诊断。 */
export interface TransformResult {
  models: readonly Model<Api>[]
  diagnostics: readonly CatalogDiagnostic[]
  /** 模型 id 到厂商标识的映射；仅用于界面分组，缺归属的模型不出现。 */
  vendors: Readonly<Record<string, string>>
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function sourceInputs(model: SourceModel): ('text' | 'image')[] | undefined {
  if (model.modalities?.input === undefined) return undefined
  const inputs = model.modalities.input.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image')
  return inputs.length > 0 ? [...new Set(inputs)] : undefined
}

/**
 * 将 Models.dev 的提供方记录转换为 pi-ai 模型。
 * @param provider - `opencode-go` 来源记录。
 * @returns 完整模型列表和被拒绝的模型诊断。
 */
export function transformProvider(provider: SourceProvider): TransformResult {
  const models: Model<Api>[] = []
  const diagnostics: CatalogDiagnostic[] = []
  if (provider.models === undefined || typeof provider.models !== 'object') {
    return {
      models,
      diagnostics: [{ code: 'INVALID_SOURCE', message: 'source provider has no models object' }],
      vendors: {},
    }
  }
  const vendors: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [modelId, source] of Object.entries(provider.models)) {
    if (!isRecord(source)) {
      diagnostics.push({ modelId, code: 'INVALID_SOURCE', message: 'model entry must be an object' })
      continue
    }
    const model = source as unknown as SourceModel
    if (model.status === 'deprecated') {
      diagnostics.push({ modelId, code: 'DEPRECATED_MODEL', message: 'model is marked deprecated by the source' })
      continue
    }
    if (seen.has(modelId)) {
      diagnostics.push({ modelId, code: 'INVALID_SOURCE', message: 'duplicate model id' })
      continue
    }
    seen.add(modelId)
    const policy = policyFor(modelId)
    const contextWindow = model.limit?.context ?? policy.contextWindow
    const maxTokens = model.limit?.output ?? policy.maxTokens
    if (!positiveInteger(contextWindow) || !positiveInteger(maxTokens)) {
      diagnostics.push({ modelId, code: 'INVALID_LIMIT', message: 'context and output limits must be positive integers' })
      continue
    }
    const declaredInput = sourceInputs(model)
    const input = policy.input === undefined
      ? declaredInput ?? ['text']
      : declaredInput === undefined
        ? policy.input
        : policy.input.filter((modality) => declaredInput.includes(modality))
    if (!input.includes('text')) {
      diagnostics.push({ modelId, code: 'UNSUPPORTED_INPUT', message: 'model does not declare text input' })
      continue
    }
    if (model.tool_call !== true && !policy.supportsTools) {
      diagnostics.push({ modelId, code: 'MISSING_TOOL_CALL', message: 'tool calling is not explicitly supported' })
      continue
    }
    const vendor = vendorOf(model.canonical_model_id)
    if (vendor !== undefined) vendors[modelId] = vendor
    models.push({
      id: modelId,
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : modelId,
      api: apiOf(policy),
      provider: 'opencode-go-live',
      baseUrl: policy.baseUrl,
      reasoning: model.reasoning ?? policy.reasoning ?? false,
      ...(policy.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: policy.thinkingLevelMap }),
      ...(policy.compat === undefined ? {} : { compat: policy.compat }),
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    })
  }
  diagnostics.push(...policyGroupDiagnostics(models))
  return { models, diagnostics, vendors }
}

/**
 * 校验已接受模型的「协议 + 端点」组合是否自洽。
 *
 * 借鉴官方 Console 集成按 provider 分组处理的做法：同一个 provider 下，一个协议
 * 应只对应一个端点；出现分叉时说明 pi-ai 静态策略表与来源目录已经错位，同一组模型
 * 会被发往不同端点。这里产出诊断而不是丢模型——目录成员资格由来源决定，策略表
 * 抖动不应该让用户突然失去模型，但需要在诊断里看见它。
 * @param models - 本次通过校验的模型。
 * @returns 分组歧义诊断；组合一致时为空数组。
 */
function policyGroupDiagnostics(models: readonly Model<Api>[]): CatalogDiagnostic[] {
  const endpoints = new Map<OpenCodeGoApi, Set<string>>()
  for (const model of models) {
    const api = model.api as OpenCodeGoApi
    const set = endpoints.get(api) ?? new Set<string>()
    set.add(model.baseUrl)
    endpoints.set(api, set)
  }
  const diagnostics: CatalogDiagnostic[] = []
  for (const [api, urls] of endpoints) {
    // 单个协议出现多个端点：同组模型会在不同端点间分裂。
    if (urls.size > 1) {
      diagnostics.push({
        code: 'POLICY_GROUP_MISMATCH',
        message: `protocol ${api} maps to ${urls.size} endpoints: ${[...urls].join(', ')}`,
      })
      continue
    }
    const [baseUrl] = urls
    if (baseUrl !== undefined && !isPolicyConsistent(api, baseUrl)) {
      diagnostics.push({
        code: 'POLICY_GROUP_MISMATCH',
        message: `protocol ${api} points at ${baseUrl}, which the pinned pi-ai policy table does not use for it`,
      })
    }
  }
  return diagnostics
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
