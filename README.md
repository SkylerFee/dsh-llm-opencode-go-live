# @deepseek-ai/dsh-llm-opencode-go-live

OpenCode Go 动态模型目录插件。

当前包已经提供：

- `apiKeyEnv`、刷新间隔和超时的配置校验；
- `@opencode-ai/models` 的 `opencode-go` 来源适配；
- 以远端 `opencode-go` 模型目录决定可用成员，并用 pi-ai 表补充已知特殊协议的转换策略；
- 内存缓存与原子替换 JSON 缓存；
- `opencode-go-live` 原生 `LlmAdapter`、复用 pi-ai mixed-API 传输、刷新去重、启动重试和离线快照恢复运行时。

插件直接注册 Harness 的 `ctx.llm` 原生适配器，不修改或覆盖内置 `opencode-go` 路由。适配器实现复用 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter` 和 pi-ai 内置 OpenCode Go provider，但不依赖 `llm-pi-ai` 的宿主配置或 Provider 贡献服务。

## 安装与配置

本地构建后，通过 `dsh plugin --profile web add /absolute/path/to/dsh-llm-opencode-go-live` 安装。包内的 `cordis.patch.yml` 自动注册 `opencode-go-live`，从宿主凭据服务读取 `OPENCODE_GO_API_KEY`，并将目录快照写入 Harness home 的 `cache/opencode-go-live.json`。安装不会改动默认模型；在模型目录可用后再按需选择该路由。

路由加载后会显示在 DSH 的 Models 供应商页。首次配置时可直接填写 API Key，之后可点击「编辑」更新；页面将密钥交给宿主凭据服务，默认使用 `OPENCODE_GO_API_KEY` 引用，插件配置只保存凭据引用。页面也显示当前动态模型列表；启动恢复缓存及后续成功刷新会通知模型选择器重新读取目录，刷新失败仍保留上次成功的列表。

插件配置 `catalog.cachePath` 后，使用原子替换的 JSON 快照跨重启恢复目录；未配置时使用内存缓存。缓存文件仅保存模型目录，不保存密钥。直接通过 Cordis 挂载时可使用以下配置：

```yaml
llm-opencode-go-live:
  apiKeyEnv: OPENCODE_GO_API_KEY
  catalog:
    cachePath: /absolute/path/to/opencode-go-live-catalog.json
    refreshOnStart: true
    refreshIntervalMs: 21600000
    refreshTimeoutMs: 10000
```

`cachePath` 必须是绝对路径。启动时先恢复快照；离线刷新失败时继续使用最近一次成功目录。
插件卸载时会中止并等待进行中的目录刷新。
插件要求宿主挂载 `llm` 和 `credentials` 服务；凭据缺失时请求返回 `MISSING_CREDENTIAL`，不会回退读取进程环境变量。标准 Harness 凭据服务本身会解析启动环境、凭据文件和 `.env`。
模型请求使用 Harness 会话 ID 设置 `x-opencode-session`，供 OpenCode Go 按对话路由请求。

## 开发

```sh
pnpm install
pnpm run check
```

真实目录访问不属于单元测试；测试使用固定对象作为来源替身，不读取 API Key，也不调用 OpenCode Go API。
