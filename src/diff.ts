import type { Api, Model } from '@earendil-works/pi-ai'
import type { CatalogSnapshot } from './store.js'

/** 一次刷新相对上一份目录的模型变化；只暴露模型 id，便于诊断与提示。 */
export interface CatalogDiff {
  /** 新目录出现、旧目录没有的模型。 */
  added: string[]
  /** 旧目录有、新目录不再有的模型。 */
  removed: string[]
  /** 同 id 但调用资料发生变化的模型。 */
  updated: string[]
}

/**
 * 判断两个同 id 模型对外可见的资料是否一致。
 *
 * 只比较会影响调用或界面展示的字段：来源目录改一个名称、上下文/输出上限、
 * 输入模态或推理能力都算一次更新；`cost` 恒为零，不参与比较。
 * @param a - 旧模型。
 * @param b - 新模型。
 * @returns 资料一致时 true。
 */
function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.name === b.name
    && a.api === b.api
    && a.baseUrl === b.baseUrl
    && a.reasoning === b.reasoning
    && a.contextWindow === b.contextWindow
    && a.maxTokens === b.maxTokens
    && a.input.length === b.input.length
    && a.input.every((modality, index) => modality === b.input[index])
    && JSON.stringify(a.thinkingLevelMap) === JSON.stringify(b.thinkingLevelMap)
    && JSON.stringify(a.compat) === JSON.stringify(b.compat)
}

/**
 * 比较前后两份目录快照。
 *
 * 用于主动刷新后的用户提示：让用户直接看到"移除了几个、新增了几个、更新了几个"，
 * 而不是只看到一个总数。没有上一份快照（首次刷新或快照被判废）时，
 * 全部模型都算新增，因为对用户而言它们确实是第一次出现。
 * @param previous - 刷新前的快照，可能不存在。
 * @param next - 本次成功的快照。
 * @returns 三个方向的模型 id 列表。
 */
export function diffCatalogs(previous: CatalogSnapshot | undefined, next: CatalogSnapshot): CatalogDiff {
  const before = new Map<string, Model<Api>>()
  for (const model of previous?.models ?? []) before.set(model.id, model)
  const after = new Map<string, Model<Api>>()
  for (const model of next.models) after.set(model.id, model)

  const added: string[] = []
  const removed: string[] = []
  const updated: string[] = []
  for (const [id, model] of after) {
    const old = before.get(id)
    if (old === undefined) added.push(id)
    else if (!sameModel(old, model)) updated.push(id)
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id)
  }
  return { added, removed, updated }
}
