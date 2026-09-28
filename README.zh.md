# @skylerfee/dsh-llm-opencode-go-live

[English](README.md) | 中文

DeepSeek Harness 的 OpenCode Go 动态模型目录插件。它从 Models.dev 更新 `opencode-go` 模型列表，注册独立的 `opencode-go-live` 路由，并由插件自己的浏览器入口在 Models 页显示供应商、密钥和动态模型；复用 pi-ai 处理模型请求；内置 `opencode-go` 路由不受影响。

## 快速开始

需要 Node.js 22.19 及以上（pi-ai 声明的最低版本）和 pnpm。从 DSH 仓库根目录安装已发布 tag 的 bundle：

```sh
pnpm dsh plugin --profile web add github:SkylerFee/dsh-llm-opencode-go-live#v0.1.0-alpha.1
```

git 安装拉取的是源码，包会在安装时通过 `prepare` 脚本构建 `lib/`。pnpm 默认阻止该脚本，直到使用方明确允许：首次 `add` 会失败并打印确切的包名，把它写进 profile 的 `pnpm-workspace.yaml` 后重新执行命令。

```yaml
allowBuilds:
  '@skylerfee/dsh-llm-opencode-go-live': true
```

该授权意味着允许包的代码在安装时以你的用户权限执行，因此请锁定 tag 或 commit。本地 checkout（先跑 `pnpm install && pnpm run check`）或 `pnpm pack` 的 tarball 无需任何授权——详见[使用指南](docs/usage.zh.md#准备与安装)。

重启 Web profile 后，打开 **Settings → Models**，在插件提供的 **OpenCode Go (Live)** 卡片点击“编辑”，填写 API Key 并应用，再从模型选择器选择 `opencode-go-live` 下的模型。密钥由 DSH 凭据服务保存，默认引用名为 `OPENCODE_GO_LIVE_API_KEY`，该名称刻意区别于 Models 页为内置 `opencode-go` 派生的 `OPENCODE_GO_API_KEY`，两条路由不会共用同一条凭据记录；bundle 默认将模型目录快照保存在 Harness home 的 `cache/opencode-go-live.json`（默认即 `~/.dsh/cache/opencode-go-live.json`，设置 `$DSH_HOME` 时位于其下）。安装不会切换默认模型。

## 文档

- [使用指南](docs/usage.zh.md)：安装、密钥配置、配置字段与故障排查。
- [架构文档](docs/opencode-go-live-dynamic-catalog-design.zh.md)：组件职责、Mermaid 数据流与时序图、目录刷新和请求行为。

插件需要 DSH 的 `llm` 与 `credentials` 服务；Web 设置页还使用 `settings` 服务。刷新失败会保留上次成功目录，首次无目录时供应商可见但没有 live 模型；模型调用缺少凭据时返回 `MISSING_CREDENTIAL`。目录可见不代表 API 调用已获上游授权。
