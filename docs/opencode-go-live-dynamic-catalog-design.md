# OpenCode Go 动态模型目录插件：需求与实施设计

状态：方案设计与插件初始化实现；持久化接入和真实 API 验证待完成。

## 概述

本设计为 DeepSeek Harness 增加一个可选的 OpenCode Go 动态模型目录插件。插件从 `@opencode-ai/models` 获取模型数据，将经过校验和补充后的结果构造成 pi-ai 动态 Provider，并通过 Harness 既有 LLM 调用链完成认证、消息转换、流式响应和重试。

内置 `opencode-go` 路由保持原样，继续使用 pi-ai 构建期目录。新插件使用独立路由 `opencode-go-live`，使动态目录成为可选择、可回退、可逐步启用的能力。

## 目录

* [背景与现状](#背景与现状)
* [目标与范围](#目标与范围)
* [总体设计](#总体设计)
* [配置设计](#配置设计)
* [模型数据转换](#模型数据转换)
* [刷新、缓存与失败处理](#刷新缓存与失败处理)
* [实现拆分](#实现拆分)
* [验证与验收](#验证与验收)
* [实施顺序](#实施顺序)

-----

## 背景与现状

Harness 的 LLM 运行时通过 `ctx.llm.registerAdapter()` 接受插件自有 Provider 路由。`@deepseek-ai/dsh-llm-pi-ai` 是一个可复用的 `LlmAdapter` 实现，但它的设置服务不应成为动态目录插件的宿主扩展点。[LLM 适配器接口](../../docs/cookbook/adding-an-llm-adapter.md)和[LLM 路由注册](../../packages/llm/llm/src/index.ts)是这一行为的当前事实来源。

当前锁定的 pi-ai `0.85.1` 已提供 OpenCode Go Provider 和动态 Provider 所需的类型与请求实现。因此本方案不以升级 pi-ai 为前提。

Harness 的 LLM 运行时允许 Cordis 插件注册独立路由；一个路由只能被一个适配器持有，重复注册会失败。插件直接注册自己的 `opencode-go-live` 适配器，动态目录只更新该适配器的 profile，不触碰 `llm-pi-ai` 的路由集合。

## 目标与范围

### 目标

* 使 `opencode-go-live` 的模型列表可从 `@opencode-ai/models` 更新，而不重新构建 Harness。
* 保持 pi-ai 作为请求协议、流式事件和消息转换的唯一执行层。
* 使用 Harness 凭据能力解析 `OPENCODE_GO_API_KEY`；模型缓存、诊断和配置中不得保存明文密钥。
* 在网络不可用时恢复最近一次验证成功的目录；首次启动没有可用快照时明确报告不可用原因。
* 允许用户在 `opencode-go-live` 和既有 `opencode-go` 间切换，回退不依赖隐式降级。
* 让模型选择器和 `resolveModel()` 使用同一份最近成功目录。

### 不在范围内

* 不修改 pi-ai 内置 `opencode-go` 的构建期 JSON，也不覆盖其路由 ID。
* 不在每次模型请求时访问网络目录。
* 不将 `@opencode-ai/models` 的原始字段直接透传为请求参数。
* 不把模型价格字段接入 Harness 的调用计费逻辑。
* 不把动态目录当作 OpenCode Go 可用性或单个模型工具调用能力的证明。

## 总体设计

### 架构决策

新增工作区插件 `@deepseek-ai/dsh-llm-opencode-go-live`，它直接通过 `ctx.llm.registerAdapter(['opencode-go-live'], adapter)` 注册原生适配器。适配器内部复用 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter` 和 pi-ai OpenCode Go Provider；远程或本地缓存得到的完整转换结果是该适配器的唯一服务目录。

插件不要求 `llm-pi-ai` 增加 Provider 贡献接口，也不复制 pi-ai 的消息转换和流式事件翻译。`llm-pi-ai` 只作为可复用的适配器实现依赖存在；Harness 路由占用、模型解析和请求生命周期仍由原生 `ctx.llm` 扩展点负责。

### 参考项目后的实现调整

[opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 的实践验证了三个运行时原则：路由应在目录暖机前立即出现，目录刷新应有启动重试和可释放的周期任务，健康状态应能说明当前目录是否可用。本插件沿用这三个原则，但不复用它的匿名 `public` 凭据、CLI 伪装请求头或自定义 `LlmAdapter`；本插件面向已认证的 OpenCode Go 路由，继续让 `llm-pi-ai` 持有请求转换和重试语义。

协议策略不再手写完整模型白名单。`@opencode-ai/models` 的 `opencode-go` 模型集合决定当前可用成员，`src/policy.ts` 只从锁定版本的 pi-ai `opencodeGoProvider()` 模型表补充已知特殊协议、端点和兼容字段。来源中出现而 pi-ai 没有对应记录的模型使用 OpenCode Go 通用 OpenAI Completions 策略，因此新模型不需要先升级 Harness 或 pi-ai 才能进入目录；只有缺少正数限制或工具调用能力的来源记录才会被拒绝。

```text
settings.yaml
    |
    v
dsh-llm-opencode-go-live
    |  读取设置、维护目录缓存、转换模型数据
    v
原生 LlmAdapter / ctx.llm
    |  注册 opencode-go-live，解析动态模型并复用 PiAiAdapter
    v
pi-ai OpenCode Go Provider
    |  认证、协议分派、流式事件、重试
    v
OpenCode Go API
```

### 组件职责

| 组件 | 职责 | 不负责的事项 |
| --- | --- | --- |
| `dsh-llm` | 管理原生适配器路由、模型解析、准备调用和流生命周期 | 获取 OpenCode 模型目录、解释第三方模型字段 |
| `dsh-llm-pi-ai` | 提供可复用的 pi-ai 消息转换、请求适配和流事件翻译 | 持有本插件的路由配置或动态目录 |
| `dsh-llm-opencode-go-live` | 读取插件设置、获取和缓存目录、校验与转换模型、提供 OpenCode Go 传输策略 | 修改内置 `opencode-go`、保存 API Key |
| `@opencode-ai/models` | 提供 OpenCode 生态模型数据客户端或快照 | pi-ai 模型类型、Harness 路由注册、请求流转换 |
| Harness 凭据服务 | 解析 `apiKeyEnv` 指向的凭据 | 写入模型缓存或公开密钥 |
| `CatalogStore` | 保存和恢复最近成功的动态模型快照 | 判断第三方字段是否可安全调用 |

### 原生适配器注册

插件在加载时直接调用 `ctx.llm.registerAdapter(['opencode-go-live'], adapter)`，并由 Cordis effect disposer 释放注册。适配器的 `listModels()`、`resolveModel()` 和 `prepareCall()` 读取最近成功快照；快照更新不会替换路由，也不会影响已经准备好的调用。

原生适配器内部使用 `PiAiAdapter`，所以 Harness 到 pi-ai 的消息转换、附件入口、重试错误分类和流事件翻译仍由已有实现负责。插件只提供动态 profile、OpenCode Go Provider 和凭据解析函数。

### 路由与回退

| 路由 | 目录来源 | 用途 |
| --- | --- | --- |
| `opencode-go` | pi-ai 内置静态目录 | 已有行为和人工回退 |
| `opencode-go-live` | 动态缓存加 `@opencode-ai/models` 刷新结果 | 本设计新增能力 |

发生目录刷新失败时，`opencode-go-live` 继续服务最后一个成功快照，不会自动改走 `opencode-go`。用户若需要回退，显式修改默认模型的 provider 或在调用中指定 `opencode-go`。

## 配置设计

以下是插件实现后的目标配置，不是当前可直接使用的字段。

```yaml
llm-opencode-go-live:
  apiKeyEnv: OPENCODE_GO_API_KEY
  catalog:
    refreshOnStart: true
    refreshIntervalMs: 21600000
    refreshTimeoutMs: 10000

agent-default-model:
  provider: opencode-go-live
  model: deepseek-v4-flash
```

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | 是 | 无 | Harness 凭据引用；不得写入实际 API Key |
| `catalog.refreshOnStart` | 否 | `true` | 插件加载后尝试网络刷新；始终先恢复本地快照 |
| `catalog.refreshIntervalMs` | 否 | `21,600,000` | 连续刷新间隔；设为 `0` 时只在启动和显式刷新时更新 |
| `catalog.refreshTimeoutMs` | 否 | `10,000` | 单次目录访问的超时上限 |

配置 schema 必须限制时间字段为非负安全整数，并在写入时拒绝无效值。`settings.yaml` 的热更新应更新下一个请求可见的目录策略；正在执行的请求继续持有开始时捕获的模型配置。

## 模型数据转换

### 转换原则

`@opencode-ai/models` 是目录来源，不是 pi-ai 请求模型的直接替代。每个模型进入动态目录前必须同时具备可调用的协议、端点、认证方式和 Harness 所需能力说明。

转换器以模型 ID 为键查找受版本控制的 OpenCode Go 特殊策略；找不到时使用通用 Completions 策略。特殊策略保存第三方目录无法完整表达的调用信息，例如原生 Anthropic 协议、端点、推理等级映射和模型专有兼容字段。来源目录是模型成员资格的唯一来源：来源新增模型会进入下一次成功快照，来源移除模型会从下一次成功快照消失。来源输入模态只能在特殊策略允许的范围内收窄；通用策略使用来源声明的文本和图片能力。

| 来源信息 | pi-ai 目标字段 | 规则 |
| --- | --- | --- |
| 模型 ID、显示名 | `id`、`name` | 保留来源标识；空 ID 或重复 ID 拒绝整个刷新结果 |
| 上下文与输出限制 | `contextWindow`、`maxTokens` | 仅接受正整数；远端缺失时模型不注册 |
| 输入模态 | `input` | 仅映射 Harness 已支持的文本和图片能力；未知模态不宣称支持 |
| `responses` 形态 | `openai-responses` | 使用 OpenCode Go 的 Responses 传输策略 |
| `completions` 形态 | `openai-completions` | 使用 OpenCode Go 的 Completions 传输策略 |
| 原生 Anthropic 模型 | `anthropic-messages` | 已知模型由特殊策略指定；未知模型使用通用 Completions |
| 推理能力 | `thinkingLevelMap` | 仅在策略表或来源明确给出时注册；无证据时不暴露推理等级 |
| 价格数据 | 不映射 | 当前 Harness 不使用 pi-ai 的成本元数据 |

转换器还必须确认模型支持 agent 所需的工具调用。来源标记为 `deprecated`、未提供可靠工具调用信息或缺少限制的模型不注册，并在目录诊断中说明原因。

### 协议与请求头

动态 Provider 必须按 `model.api` 使用 pi-ai 的混合 API 分派。OpenCode Go 的不同模型不能被强制归入单一 OpenAI 兼容协议。

OpenCode 特有的会话头、端点路径、推理序列化和历史回放字段必须由 Provider 传输策略统一注入。不得把来源目录中的任意 headers 或 body 字段原样转发到 API，以免外部目录数据改变认证或请求语义。

## 刷新、缓存与失败处理

### 生命周期

1. 插件加载时创建空基础目录的动态 Provider，并从 `CatalogStore` 恢复最近成功快照。
2. 若 `refreshOnStart` 为真，插件在原生适配器已注册后发起一次允许网络的刷新；失败时按短间隔有限重试，避免启动时网络尚未就绪导致长时间空目录。
3. 定时器仅在 `refreshIntervalMs` 大于零时运行；同一时刻最多存在一个刷新请求。
4. 刷新先获取来源数据，再完成字段校验和转换；存在有效模型时发布其完整转换结果，来源有效但模型为空时发布空目录以移除全部模型。来源无效或所有条目无效时保留旧快照。
5. 新请求读取发布后的目录。已开始的请求不受随后刷新影响。

### 缓存规则

缓存保存转换后的 pi-ai 模型列表、来源校验信息和检查时间，不保存 API Key、请求内容或响应内容。缓存写入必须采用原子替换，损坏缓存视为不存在并记录诊断。

首次启动没有缓存且来源不可访问时，路由仍可被诊断和配置，但任何模型调用以明确的目录不可用错误结束。已有缓存时网络失败保留旧列表，并将错误暴露给模型目录和设置页面。

### 错误矩阵

| 场景 | 调用行为 | 恢复方式 |
| --- | --- | --- |
| API Key 缺失 | `MISSING_CREDENTIAL`，不访问模型 API | 配置有效的 `apiKeyEnv` |
| 目录请求超时或失败且有缓存 | 继续使用缓存并报告目录过期诊断 | 等待下一次刷新或显式刷新 |
| 目录请求失败且无缓存 | 拒绝未知模型调用，显示目录不可用原因 | 恢复网络后刷新，或改用 `opencode-go` |
| 来源字段无效、限制缺失或工具能力未知 | 该模型不注册，其他有效模型仍可发布 | 等待来源补齐字段 |
| 新模型未声明工具调用能力 | 不注册该模型，保留诊断 | 补充来源能力或策略表后刷新 |
| 路由冲突 | 插件加载失败，已有适配器继续服务 | 使用 `opencode-go-live`，不得覆盖内置 ID |

## 实现拆分

### A. 复用 Harness 原生 LLM 扩展点

* 使用 `ctx.llm.registerAdapter()` 注册独立的 `opencode-go-live` 路由。
* 使用 `PiAiAdapter` 作为插件内部实现，不改变 `llm-pi-ai` 的服务和设置行为。
* 将动态快照绑定到 `listModels()`、`resolveModel()` 和 `prepareCall()` 的同一代 profile。

### B. 新增 `dsh-llm-opencode-go-live`

建议目录为 `packages/llm/llm-opencode-go-live/`，包名为 `@deepseek-ai/dsh-llm-opencode-go-live`。

| 文件 | 责任 |
| --- | --- |
| `src/config.ts` | 定义并校验插件设置及热更新行为 |
| `src/source.ts` | 访问 `@opencode-ai/models`，归一化来源错误与超时 |
| `src/policy.ts` | 保存已知特殊模型的协议覆盖和通用动态策略 |
| `src/transform.ts` | 校验来源记录，生成 pi-ai `Model<Api>` 列表和诊断 |
| `src/provider.ts` | 构造混合协议动态 Provider 和原生 `PiAiAdapter` |
| `src/store.ts` | 定义目录快照存储；当前提供内存和 JSON 实现 |
| `src/index.ts` | 注册 Cordis 插件和路由，启动和释放刷新任务 |

插件应直接依赖当前 `@earendil-works/pi-ai` 和 `@opencode-ai/models`，不要复制 pi-ai 的协议实现或内置模型 JSON。

### C. 组合与用户设置

将新插件作为可选 Cordis 插件挂载，并注入 `llm`。基础 profile 不需要修改 `dsh-llm-pi-ai`，也不自动把默认模型改为 `opencode-go-live`。用户在确认刷新诊断和模型列表后，才通过 `settings.yaml` 修改 `agent-default-model`。

插件加载失败、配置缺失或目录首次不可用时，现有 `opencode-go` 的配置和调用不应改变。

### D. 文档与用户体验

实现完成后，更新动态插件 README、配置目录和提供方用户指南。用户界面需要显示目录来源、最近成功刷新时间、缓存状态和最近错误，但不显示凭据值。

## 验证与验收

### 单元测试

* 来源记录到 pi-ai 模型的正常转换、动态新增和移除、缺失限制、过期标记和未知工具调用能力。
* 已知 OpenCode Go 模型的三种协议分派、端点与会话头注入。
* 动态刷新首次成功、缓存恢复、网络失败保留旧目录、无缓存失败和并发刷新去重。
* 设置热更新、路由冲突、插件 disposer 和定时器释放。
* 凭据缺失、未知模型、错误目录诊断与显式静态路由回退。

### 集成与快照测试

* 使用固定的 `@opencode-ai/models` 响应 fixture 验证原生适配器注册后 `opencode-go-live` 可被模型解析，并验证来源新增和移除模型会更新目录。
* 验证同一 session 在目录刷新前后保持已选择模型的请求语义。
* 为模型选择和错误诊断新增 keyless 录制会话快照；不在普通单元测试中访问真实目录服务。
* 真实 OpenCode Go API 验证作为具备专用密钥时才运行的 e2e，不以其替代 fixture 测试。

### 验收标准

| 编号 | 验收条件 |
| --- | --- |
| AC-1 | 不升级当前 pi-ai 依赖版本即可构建并加载动态插件 |
| AC-2 | `opencode-go-live` 在有缓存时可离线恢复模型目录 |
| AC-3 | 有效刷新原子更新后续请求可见的模型列表，不影响进行中的请求 |
| AC-4 | 三种已支持协议均通过 pi-ai 分派，OpenCode 专有请求信息未丢失 |
| AC-5 | 缺少工具调用能力或限制的模型不会被静默注册；可用新模型不依赖 pi-ai 静态目录 |
| AC-6 | 密钥不进入设置持久化、模型缓存、日志或错误详情 |
| AC-7 | 删除或禁用插件后，内置 `opencode-go` 仍保持原有可用性 |

## 实施顺序

1. 直接用 `ctx.llm.registerAdapter()` 挂载空目录原生适配器；确认路由可启动并可释放。
2. 以锁定 pi-ai 的 OpenCode Go provider 模型表作为特殊策略覆盖，补充通用动态策略，以固定 fixture 和内存快照完成模型转换与 mixed-API 适配器测试。
3. 接入 Harness 持久化缓存、设置热更新和定时刷新，并验证 disposer。
4. 接入 `@opencode-ai/models` 客户端，增加超时、来源诊断和离线恢复测试。
5. 添加用户配置、模型目录状态和 keyless 录制会话快照。
6. 在具备专用密钥的环境执行 OpenCode Go e2e；通过后再将 `opencode-go-live` 提供给日常配置选择。

## 结论

本方案以插件方式将动态模型目录注入 Harness，同时保留 pi-ai 的成熟协议执行能力。插件直接注册原生 `LlmAdapter`，不修改 `llm-pi-ai`，并通过独立路由、显式缓存和严格字段策略避免覆盖内置目录、每请求拉取网络数据和猜测协议。
