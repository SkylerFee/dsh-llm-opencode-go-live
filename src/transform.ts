import type { Api, Model } from '@earendil-works/pi-ai'
import { apiOf, policyFor } from './policy.js'
import type { SourceModel, SourceProvider } from './source.js'

/** 单条目录诊断。 */
export interface CatalogDiagnostic {
  modelId?: string
  code: 'INVALID_SOURCE' | 'DEPRECATED_MODEL' | 'INVALID_LIMIT' | 'UNSUPPORTED_INPUT' | 'MISSING_TOOL_CALL'
  message: string
}

/** 转换后的模型及其诊断。 */
export interface TransformResult {
  models: readonly Model<Api>[]
  diagnostics: readonly CatalogDiagnostic[]
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
    return { models, diagnostics: [{ code: 'INVALID_SOURCE', message: 'source provider has no models object' }] }
  }
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
  return { models, diagnostics }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
