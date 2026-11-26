/**
 * 模型厂商归属。
 *
 * 数据来源是 models.dev 每个模型的 `canonical_model_id`（形如 `moonshotai/kimi-k3`），
 * 前缀即厂商标识。这些标识是内部代号，直接展示不友好，因此这里维护一张
 * 代号到显示名的映射；未收录的代号按原样展示首字母大写，缺少归属的归入「其他」。
 *
 * 厂商只用于界面分组，不参与任何请求路由或计费判断。
 */

/** 无厂商归属时的分组键。 */
export const OTHER_VENDOR = 'other'

/** 厂商代号到显示名的映射。 */
const VENDOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  alibaba: 'Alibaba',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  meituan: 'Meituan',
  meta: 'Meta',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot',
  openai: 'OpenAI',
  reflection: 'Reflection',
  stepfun: 'StepFun',
  tencent: 'Tencent',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  zhipuai: 'Z.ai',
})

/**
 * 从 `canonical_model_id` 提取厂商标识。
 *
 * 只接受 `vendor/model` 形式；缺少斜杠或前缀为空时返回 undefined，
 * 由调用方归入「其他」而不是编造一个厂商。
 * @param canonicalId - models.dev 的 `canonical_model_id`。
 * @returns 小写厂商标识，或 undefined。
 */
export function vendorOf(canonicalId: unknown): string | undefined {
  if (typeof canonicalId !== 'string') return undefined
  const slash = canonicalId.indexOf('/')
  if (slash <= 0) return undefined
  const vendor = canonicalId.slice(0, slash).trim().toLowerCase()
  return vendor.length === 0 ? undefined : vendor
}

/**
 * 把厂商标识转换成可展示的分组标题。
 * @param vendor - 厂商标识，或 undefined 表示无归属。
 * @returns 显示名；未收录的代号按原样展示。
 */
export function vendorLabel(vendor: string | undefined): string {
  if (vendor === undefined) return 'Other'
  const known = VENDOR_LABELS[vendor]
  if (known !== undefined) return known
  // 未收录代号：首字母大写，其余保持原样，避免展示成生硬的全小写。
  return vendor.charAt(0).toUpperCase() + vendor.slice(1)
}

/**
 * 统计每个厂商下的模型数，用于分组的稳定排序依据。
 * @param vendors - 模型 id 到厂商的映射。
 * @returns 厂商到模型数的映射。
 */
export function vendorCounts(vendors: Readonly<Record<string, string | undefined>>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const vendor of Object.values(vendors)) {
    const key = vendor ?? OTHER_VENDOR
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
