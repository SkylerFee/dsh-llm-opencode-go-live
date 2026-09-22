# @deepseek-ai/dsh-llm-opencode-go-live

OpenCode Go 动态模型目录插件。

当前包已经提供：

- `apiKeyEnv`、刷新间隔和超时的配置校验；
- `@opencode-ai/models` 的 `opencode-go` 来源适配；
- 以远端 `opencode-go` 模型目录决定可用成员，并用 pi-ai 表补充已知特殊协议的转换策略；
- 内存缓存与原子替换 JSON 缓存；
- `opencode-go-live` 原生 `LlmAdapter`、复用 pi-ai mixed-API 传输、刷新去重、启动重试和离线快照恢复运行时。

插件直接注册 Harness 的 `ctx.llm` 原生适配器，不修改或覆盖内置 `opencode-go` 路由。适配器实现复用 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter` 和 pi-ai 内置 OpenCode Go provider，但不依赖 `llm-pi-ai` 的宿主配置或 Provider 贡献服务。

当前 Cordis 入口使用内存存储作为宿主持久化服务接入前的占位；`JsonCatalogStore` 已提供原子快照实现，接入 Harness 持久化服务后再启用跨重启离线恢复。

## 开发

```sh
pnpm install
pnpm run check
```

真实目录访问不属于单元测试；测试使用固定对象作为来源替身，不读取 API Key，也不调用 OpenCode Go API。
