# 使用 OpenCode Go Live

本指南适用于已安装 DeepSeek Harness 的 Web profile。插件提供独立的 `opencode-go-live` 路由，安装后可在 DSH 的 Models 供应商页面配置 API Key，并在模型选择器中选择动态目录模型。

## 准备与安装

需要 Node.js 和 pnpm，且 DSH 的 Web profile 能正常启动。使用本地源码时，先在插件目录构建，再从 DSH 仓库根目录安装 bundle：

```sh
cd /absolute/path/to/dsh-llm-opencode-go-live
pnpm install
pnpm run check

cd /absolute/path/to/deepseek-harness
pnpm dsh plugin --profile web add /absolute/path/to/dsh-llm-opencode-go-live
```

已安装 `dsh` CLI 的环境，也可将最后一行改为 `dsh plugin --profile web add /absolute/path/to/dsh-llm-opencode-go-live`。安装会把包内 `cordis.patch.yml` 加入 Web profile 的 bundle 层，设置默认凭据引用 `OPENCODE_GO_API_KEY`，并将目录快照放在 Harness home 的 `cache/opencode-go-live.json`。安装不会更改默认模型。安装或更新 bundle 后重启 Web profile；从源码运行 DSH 时，主仓库需要已有构建产物。

## 配置密钥并使用模型

1. 启动 Web profile，打开 **Settings → Models**，找到由插件提供的 **OpenCode Go (Live)** 卡片。
2. 卡片默认只显示密钥状态和模型列表；点击“编辑”后在 **API Key** 输入框填写 OpenCode Go 密钥并应用，或点击“取消”放弃输入。密钥写入 DSH 凭据服务，页面不会回显已保存的值；状态提示表示已确认该引用有凭据。
3. 等待动态目录加载，展开卡片的模型列表，或在模型选择器查看 `opencode-go-live` 下的模型。选择其中一个模型发起对话；需要作为默认模型时，在 DSH 的默认模型设置中选择该路由和模型。

模型目录来自 Models.dev，获取目录不需要 API Key；真正请求 OpenCode Go API 时才会解析密钥。选择模型后若仍无法调用，请按下方[排查](#排查)先区分凭据错误与上游响应。

## 配置参考

bundle 自带的 `cordis.patch.yml` 已配置持久快照。手工挂载 Cordis 插件时，可在所属配置中使用以下字段；`apiKeyEnv` 填凭据引用名称，不填密钥值：

```yaml
llm-opencode-go-live:
  apiKeyEnv: OPENCODE_GO_API_KEY
  catalog:
    cachePath: /absolute/path/to/opencode-go-live.json
    refreshOnStart: true
    refreshIntervalMs: 21600000
    refreshTimeoutMs: 10000
```

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 每次模型调用时由 DSH 凭据服务解析的引用。 |
| `catalog.cachePath` | 未设置 | 绝对路径；设置后跨重启恢复目录，未设置时仅使用内存。 |
| `catalog.refreshOnStart` | `true` | 启动时从 Models.dev 刷新目录。 |
| `catalog.refreshIntervalMs` | `21600000` | 后续刷新间隔，单位毫秒；`0` 禁用定时刷新。 |
| `catalog.refreshTimeoutMs` | `10000` | 单次目录请求超时，单位毫秒；`0` 禁用超时。 |

目录字段由插件配置管理，插件的 Models 卡片仅编辑 API Key。刷新开始前会尝试恢复快照；刷新失败保留最近一次成功目录。API Key 不会写入目录快照。

## 排查

| 现象 | 检查与处理 |
| --- | --- |
| 看不到 OpenCode Go (Live) 供应商 | 检查插件是否安装在当前 `web` profile，重启该 profile，并查看启动日志中的插件加载错误。 |
| 供应商可见但没有 live 模型 | 检查 DSH 进程能否访问 Models.dev；首次加载没有快照时会保持空目录，启动刷新失败会写入警告。 |
| 返回 `MISSING_CREDENTIAL` | 在插件的 Models 卡片保存 API Key；确认运行中的 DSH 使用同一 profile 和凭据引用。 |
| 模型可选但 API 调用失败 | 目录加载与模型调用相互独立。查看 DSH 的调用错误和服务日志，按错误码区分认证、权限、限流和网络问题；不要在日志或工单中粘贴密钥。 |
| 刷新后仍显示旧模型 | 查看刷新警告；来源失败、全无效或快照保存失败时，插件保留上次成功目录。 |

`opencode-go-live` 不会自动回退到内置 `opencode-go`。需要回退时，在模型选择器或默认模型设置中显式选择内置路由。

## 开发验证

在插件目录运行 `pnpm run check` 执行 TypeScript 构建与离线测试；发布前运行 `pnpm pack --dry-run` 检查包内容。测试使用固定目录替身，不访问真实模型 API。目录与调用链路的实现说明见[架构文档](opencode-go-live-dynamic-catalog-design.md)。
