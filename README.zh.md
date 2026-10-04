# @skylerfee/dsh-llm-opencode-go-live

[English](README.md) | 中文

[![CI](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: >=22.19](https://img.shields.io/badge/Node-%3E%3D22.19-brightgreen.svg)](https://nodejs.org) [![Release: v0.1.0-alpha.5](https://img.shields.io/badge/release-v0.1.0--alpha.5-orange.svg)](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases)

DeepSeek Harness 的 OpenCode Go 动态模型目录插件。它从 Models.dev 更新 `opencode-go` 模型列表，注册独立的 `opencode-go-live` 路由，并由插件自己的浏览器入口在 Models 页显示供应商、密钥和动态模型；复用 pi-ai 处理模型请求；内置 `opencode-go` 路由不受影响。供应商卡片内的开关可以在帧级悬浮层显示 OpenCode Go 订阅用量。

## 快速开始

需要 Node.js 22.19 及以上（pi-ai 声明的最低版本）、pnpm，以及 DeepSeek Harness 0.1.7-rc.1 及以上。插件的 peer 依赖是 `@deepseek-ai/cordis` `~4.0.4`，以及 `@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-settings` 的 `>=0.1.7-rc.1`——插件接入的图片输入钩子由这些版本提供。宿主还需提供 `@earendil-works/pi-ai` `^0.87.1`：DSH 在运行时将该 peer 解析到宿主的 pi-ai，链接源码目录安装时也适用；插件保留 pi-ai `0.87.1` 开发依赖，用于自身构建和测试。

推荐从 npm 安装，使用已安装的 `dsh` CLI 将插件加入 Web profile：

```sh
dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live
```

该命令安装 npm 的 `latest` 标签。跟进预发布时，在包名后加 `@alpha`；固定本次发布版本时，加 `@0.1.0-alpha.5`。从源码运行 DSH 时，可在 DSH 仓库根目录执行 `pnpm dsh plugin --profile web add @skylerfee/dsh-llm-opencode-go-live`。[使用指南](docs/usage.zh.md#从-npm-安装)提供 npm 安装说明，以及开发时的源码目录和 tarball 安装方式。

在 Web 客户端的插件页安装并启用插件：

![在 Web 客户端的插件页安装并启用插件](docs/img/install-plugin.gif)

重启 Web profile 后，打开 **Settings → Models**，在插件提供的 **OpenCode Go (Live)** 卡片点击“编辑”，填写 API Key 并应用，再从模型选择器选择 `opencode-go-live` 下的模型。密钥由 DSH 凭据服务保存，默认引用名为 `OPENCODE_GO_LIVE_API_KEY`，该名称刻意区别于 Models 页为内置 `opencode-go` 派生的 `OPENCODE_GO_API_KEY`，两条路由不会共用同一条凭据记录；bundle 默认将模型目录快照保存在 Harness home 的 `cache/opencode-go-live.json`（默认即 `~/.dsh/cache/opencode-go-live.json`，设置 `$DSH_HOME` 时位于其下）。安装不会切换默认模型。

卡片内的**显示用量悬浮窗**开关控制右下角的用量面板（未配置时默认开启）：面板按 5 小时滚动、周、月三个窗口显示 OpenCode Go 订阅的用量百分比与重置时间，默认显示右下角徽章（5 小时进度条与用量百分比），鼠标移入展开完整面板、移出自动收起；徽章未固定时可拖动，图钉按钮切换固定（实心=已固定，空心=未固定，默认不固定）；点面板的 × 会把该开关同步关闭。数据由宿主用同一凭据向 `https://opencode.ai/zen/go/v1/usage` 查询。该端点不出现在 OpenCode 公开文档中，属上游实现约定；密钥只在宿主解析，不会进入浏览器。用量悬浮窗的字段说明与故障排查见[使用指南](docs/usage.zh.md#用量悬浮窗)。

浏览器里的用量悬浮窗——鼠标移入徽章展开完整面板，移出自动收起：

![用量悬浮窗徽章展开为完整面板](docs/img/usage-view.gif)

插件在 **Settings → Models** 中的卡片——在编辑态填写密钥、目录解析后的动态模型列表，以及会话里模型选择器中自成一组的 live 模型（旁边可选推理等级）：

![在 OpenCode Go (Live) 卡片中保存密钥并在模型选择器中选择 live 模型](docs/img/add-key.gif)

## 文档

- [使用指南](docs/usage.zh.md)：安装、密钥配置、配置字段与故障排查。
- [架构文档](docs/opencode-go-live-dynamic-catalog-design.zh.md)：组件职责、Mermaid 数据流与时序图、目录刷新和请求行为。
- [用量悬浮窗设计](docs/opencode-go-live-balance-overlay-design.zh.md)：数据源契约、宿主余额路由、展示开关与测试计划。
- [开发与发布流程](docs/development-and-release.zh.md)：新功能与 Bug 修复的 PR、验证、版本标签和 GitHub 预发布。

插件需要 DSH 的 `llm` 与 `credentials` 服务；Web 设置页还使用 `settings` 服务，用量悬浮窗另需浏览器载体 `connection`（缺失时插件照常运行，仅不注册余额路由）。刷新失败会保留上次成功目录，首次无目录时供应商可见但没有 live 模型；模型调用缺少凭据时返回 `MISSING_CREDENTIAL`。目录可见不代表 API 调用已获上游授权。

图片输入（`read_image` 工具结果或粘贴的截图）通过宿主的 durable 附件服务解析，与内置路由行为一致；未挂载附件服务时，携带图片的请求以 `UNSUPPORTED_CONTENT` 失败而不是静默丢弃。文件附件从不以原始字节发给任何 provider：请求组装层在所有路由上把文件块投影为确定性句柄文本。声明的输入模态跟随远端目录的 `modalities.input`（text 与 image），未声明图片输入的模型收到纯文本图片占位。

## 验证环境

**仅在 macOS 上验证过。** 插件安装、对 Models.dev 线上目录的刷新、Models 设置卡片以及模型调用都在同一台 macOS 机器上跑通过；Linux 与 Windows 从未实际运行。

CI 在 `ubuntu-latest` 上执行构建与离线测试套件。这只是构建信号，不是运行时验证：测试使用固定目录替身，没有任何自动化运行会访问真实的 OpenCode Go API。

## 许可证

MIT © 2026 SkylerFee，详见 [LICENSE](LICENSE)。
