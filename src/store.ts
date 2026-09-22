import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { CatalogDiagnostic } from './transform.js'

/** 可恢复的目录快照；不包含凭据、请求或响应内容。 */
export interface CatalogSnapshot {
  version: 1
  checkedAt: string
  models: readonly Model<Api>[]
  diagnostics: readonly CatalogDiagnostic[]
}

/** 目录快照存储抽象。 */
export interface CatalogStore {
  load(): Promise<CatalogSnapshot | undefined>
  save(snapshot: CatalogSnapshot): Promise<void>
}

/** 测试和嵌入式运行时使用的内存存储。 */
export class MemoryCatalogStore implements CatalogStore {
  private snapshot: CatalogSnapshot | undefined

  /** 读取当前快照。 */
  load(): Promise<CatalogSnapshot | undefined> {
    return Promise.resolve(this.snapshot)
  }

  /** 替换当前快照。 */
  save(snapshot: CatalogSnapshot): Promise<void> {
    this.snapshot = snapshot
    return Promise.resolve()
  }
}

/** 使用临时文件加 rename 保存的本地目录存储。 */
export class JsonCatalogStore implements CatalogStore {
  public constructor(private readonly path: string) {}

  /** 读取并校验快照；损坏文件按不存在处理。 */
  async load(): Promise<CatalogSnapshot | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!isSnapshot(value)) return undefined
      return value
    } catch {
      return undefined
    }
  }

  /** 原子替换快照文件。 */
  async save(snapshot: CatalogSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CatalogSnapshot>
  return candidate.version === 1
    && typeof candidate.checkedAt === 'string'
    && Array.isArray(candidate.models)
    && candidate.models.every(isModel)
    && Array.isArray(candidate.diagnostics)
}

function isModel(value: unknown): value is Model<Api> {
  if (typeof value !== 'object' || value === null) return false
  const model = value as Partial<Model<Api>>
  return typeof model.id === 'string'
    && typeof model.name === 'string'
    && typeof model.api === 'string'
    && typeof model.provider === 'string'
    && typeof model.baseUrl === 'string'
    && Array.isArray(model.input)
    && model.input.length > 0
    && typeof model.contextWindow === 'number'
    && Number.isSafeInteger(model.contextWindow)
    && model.contextWindow > 0
    && typeof model.maxTokens === 'number'
    && Number.isSafeInteger(model.maxTokens)
    && model.maxTokens > 0
}
