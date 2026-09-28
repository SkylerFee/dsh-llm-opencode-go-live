# dsh-llm-opencode-go-live

## 任务入口

涉及模型来源、协议策略、缓存、刷新、路由或验收行为时，先阅读 [动态目录设计](docs/opencode-go-live-dynamic-catalog-design.md)（[中文版](docs/opencode-go-live-dynamic-catalog-design.zh.md)），并把它作为当前行为真源。设计文档与实现不一致时，先确认是设计变更还是实现缺陷，再修改对应一处。

## 项目边界

- 本目录是独立的 `@deepseek-ai/dsh-llm-opencode-go-live` 插件包；插件直接注册 `ctx.llm` 原生适配器，不要求主仓库修改 `llm-pi-ai`。
- `opencode-go-live` 是本插件唯一拥有的路由；不得覆盖或改写内置 `opencode-go`。
- 远端 `opencode-go` 目录决定模型成员；`src/policy.ts` 仅为已知特殊协议提供覆盖，未知模型使用通用 OpenAI Completions 策略。来源没有工具调用能力或限制时不得注册；来源能力不得扩大已知策略声明的范围。
- API Key 只允许通过 `apiKeyEnv` 引用由宿主凭据服务解析；缓存、日志、错误和测试 fixture 不得保存密钥、请求内容或响应内容。
- 缓存发布必须先完成整批校验和转换，再原子替换快照；刷新失败继续使用最近一次成功快照，并保留诊断。

## 修改流程

1. 先检查 `git status --short`，保留已有未提交改动；只修改本插件需要的文件。
2. 按 `src/config.ts`、`source.ts`、`policy.ts`、`transform.ts`、`store.ts`、`provider.ts` 的职责放置代码。跨模块抽象只有在已有调用者需要时才增加。
3. 非平凡转换、缓存或并发逻辑必须添加一个能失败的最小测试；来源网络使用固定替身，不在单元测试访问真实服务。
4. 修改配置、路由、缓存或模型字段后，更新 `README.md` 或设计文档中受影响的事实，保持中文说明和函数 JSDoc。英文是主语言：`README.md` 与 `README.zh.md`、`docs/*.md` 与 `docs/*.zh.md` 成对存在，改动一侧时同步另一侧。
5. 完成前运行 `pnpm run check`；涉及发布内容时再运行 `pnpm pack --dry-run`，确认产物不包含 `node_modules/`、测试文件或敏感数据。

## 完成标准

- TypeScript 构建和目标测试通过。
- 所有新模型都有明确策略，拒绝原因进入诊断而不是静默跳过。
- 缓存恢复、刷新失败保留旧目录、路由冲突和宿主服务缺失的行为有明确代码或测试证据。
- 未运行的主仓库集成、真实 OpenCode Go API 和 E2E 校验必须在交接中明确说明。
