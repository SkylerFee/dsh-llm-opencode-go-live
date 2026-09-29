import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Live from '../src/index.js'
import { JsonCatalogStore } from '../src/store.js'
import type { CatalogSnapshot } from '../src/store.js'
import { transformProvider } from '../src/transform.js'

/** 图片引用替身；附件标识只是不透明字符串。 */
const imageRef = {
  attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
  mediaType: 'image/png',
  bytes: 8,
  width: 2,
  height: 2,
}

const imageMessage = {
  id: 'msg-image',
  role: 'user',
  content: [{ type: 'image', attachment: imageRef }],
  source: { kind: 'user' },
}

const fileMessage = {
  id: 'msg-file',
  role: 'user',
  content: [{ type: 'file', attachment: { attachmentId: imageRef.attachmentId, name: 'notes.txt', bytes: 5 } }],
  source: { kind: 'user' },
}

/** 请求结束块的松散视图，便于断言失败原因。 */
interface FinishView {
  type: string
  reason: { kind: string; failure: { code: string; message: string } }
}

function snapshotWith(input: ('text' | 'image')[]): CatalogSnapshot {
  const models = transformProvider({ models: {
    'vision-model': {
      tool_call: true,
      limit: { context: 128_000, output: 8_192 },
      modalities: { input },
    },
  } }).models
  return { version: 1, checkedAt: new Date(0).toISOString(), models, diagnostics: [] }
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<FinishView[]> {
  const chunks: FinishView[] = []
  for await (const chunk of stream) chunks.push(chunk as FinishView)
  return chunks
}

/** 轮询目录快照恢复完成，与 integration.spec.ts 的等待方式一致。 */
async function waitForModels(ctx: Context): Promise<void> {
  let listed = await ctx.llm.listModels(Live.ROUTE_ID)
  for (let attempt = 0; listed.length === 0 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    listed = await ctx.llm.listModels(Live.ROUTE_ID)
  }
  assert.equal(listed.length, 1)
}

interface MountOptions {
  input?: ('text' | 'image')[]
  /** 凭据服务替身；缺省返回未配置，请求以 MISSING_CREDENTIAL 结束。 */
  credentials?: unknown
  /** 宿主附件服务替身；缺省不挂载。 */
  attachments?: unknown
}

/** 挂载 LlmRuntime 与 Live 插件的最小 Harness，与真实会话共用同一条请求链路。 */
async function mountLive(options: MountOptions): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  const cachePath = join(directory, 'catalog.json')
  await new JsonCatalogStore(cachePath).save(snapshotWith(options.input ?? ['text', 'image']))
  const ctx = new Context()
  ctx.provide('credentials', (options.credentials ?? { resolve: async () => undefined }) as never)
  if (options.attachments !== undefined) ctx.provide('attachments', options.attachments as never)
  await ctx.plugin(LlmRuntime)
  const fiber = await ctx.plugin(Live, {
    apiKeyEnv: 'OPENCODE_GO_LIVE_API_KEY',
    catalog: { cachePath, refreshOnStart: false, refreshIntervalMs: 0 },
  })
  await waitForModels(ctx)
  return {
    ctx,
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true })
    },
  }
}

/** 走 ctx.llm 请求流水线发送一条用户消息并返回结束块。 */
async function runRequest(ctx: Context, messages: unknown[]): Promise<FinishView> {
  const prepared = await ctx.llm.prepareCall({ provider: Live.ROUTE_ID, model: 'vision-model' })
  const chunks = await collect(prepared.stream({
    ...prepared.config,
    messages: messages as never,
  }) as AsyncIterable<{ type: string }>)
  return chunks.at(-1)!
}

const withCredential = { resolve: async () => ({ value: 'test-key' }) }

test('附件服务挂载后图片请求进入附件解析而不是 UNSUPPORTED_CONTENT', async () => {
  let readCalls = 0
  const store = {
    readImageRequest: async () => {
      readCalls += 1
      throw new Error('ATTACHMENT_RESOLUTION_REACHED')
    },
    imageHostPath: () => undefined,
    fileHostPath: () => undefined,
  }
  const { ctx, dispose } = await mountLive({ credentials: withCredential, attachments: store })
  try {
    const finish = await runRequest(ctx, [imageMessage])
    // 附件解析替身的哨兵错误出现在失败信息里，说明请求已通过图片能力检查并进入宿主附件服务；
    // 修复前这条链路永远停在 "pi-ai image input requires the durable attachment service"。
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /ATTACHMENT_RESOLUTION_REACHED/)
    assert.equal(readCalls, 1)
  } finally {
    await dispose()
  }
})

test('附件服务未挂载时图片请求被明确拒绝而不是静默丢弃', async () => {
  const { ctx, dispose } = await mountLive({ credentials: withCredential })
  try {
    const finish = await runRequest(ctx, [imageMessage])
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'UNSUPPORTED_CONTENT')
    assert.match(finish.reason.failure.message, /durable attachment service/)
  } finally {
    await dispose()
  }
})

test('附件解析后图片执行世界桥接被调用', async () => {
  let hostPathCalls = 0
  const store = {
    readImageRequest: async () => ({
      variantId: 'variant-1',
      attachment: imageRef,
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png',
      bytes: 4,
      width: 2,
      height: 2,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }),
    imageHostPath: () => {
      hostPathCalls += 1
      throw new Error('IMAGE_ACCESS_REACHED')
    },
    fileHostPath: () => undefined,
  }
  const { ctx, dispose } = await mountLive({ credentials: withCredential, attachments: store })
  try {
    const finish = await runRequest(ctx, [imageMessage])
    // 句柄文本阶段通过宿主 fs 映射桥接附件；哨兵证明 resolveImageAccess 钩子已接入。
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /IMAGE_ACCESS_REACHED/)
    assert.equal(hostPathCalls, 1)
  } finally {
    await dispose()
  }
})

test('file 块输入在 live 路由下穿过请求组装而不被拒绝', async () => {
  const { ctx, dispose } = await mountLive({})
  try {
    const finish = await runRequest(ctx, [fileMessage])
    // 文件块在请求组装层投影为句柄文本后到达凭据阶段，全程没有 UNSUPPORTED_CONTENT。
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL')
  } finally {
    await dispose()
  }
})

test('未声明图片输入的模型收到图片时由请求组装降级为文本', async () => {
  const { ctx, dispose } = await mountLive({ input: ['text'] })
  try {
    const finish = await runRequest(ctx, [imageMessage])
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL')
  } finally {
    await dispose()
  }
})
