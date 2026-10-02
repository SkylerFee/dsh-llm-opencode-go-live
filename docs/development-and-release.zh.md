# 开发与发布流程

[English](development-and-release.md) | 中文

本仓库通过 GitHub 的 `v*` 标签和 Release 交付插件；完成 npm 首次初始化后，`.github/workflows/publish.yml` 会在发布 GitHub Release 时将对应版本发布到 npm。新功能和 Bug 修复都从最新 `main` 创建短期分支，经 Pull Request 合并；当前没有维护旧版本的长期发布分支。

## 开发与合并

1. 新功能或文档完善从最新 `main` 创建 `feat/short-name` 分支，Bug 修复创建 `fix/short-name` 分支；不直接向 `main` 推送。Bug 修复先确认根因，并添加能复现原问题的回归测试；新功能为非平凡行为添加测试。修改配置、路由、缓存或模型字段时，同步更新受影响的中英文文档。
2. 在插件仓库运行 `pnpm run check`。涉及安装或打包内容时再运行 `pnpm pack --dry-run`，检查产物不含 `node_modules/`、测试文件或敏感数据。涉及用户可见的模型或设置行为时，在 DSH Web profile 验证受影响的实际路径，并在 PR 中说明未运行的真实 API 或运行时检查。
3. 向 `main` 发起 PR，写明行为变化、验证结果和已知限制。当前[仓库规则](https://github.com/SkylerFee/dsh-llm-opencode-go-live/rules)要求经过 PR，且 GitHub Actions 的 `check` 必须通过；批准人数为 0。CI 在 Node.js 22 上构建并运行离线测试，不访问 Models.dev 或真实 OpenCode Go API。
4. `check` 通过后合并 PR。当前规则不要求 PR 分支始终与 `main` 同步；如果等待期间 `main` 已前进，先更新分支并确认检查重新通过。合并后还要等待 `main` 的推送 CI 通过，再以该分支的最终提交准备发布。

## npm 首次初始化

包名为 `@skylerfee/dsh-llm-opencode-go-live`。发布者需要 npm 账号、账号级双因素认证，以及 `@skylerfee` 个人或组织 scope 的发布权限；GitHub 用户名不决定 npm scope 的归属。

Trusted Publisher 只能绑定 registry 中已有的包。包还不存在时，在已通过 `main` CI 的发布标签目录中登录并首次发布；以下命令适用于当前的 alpha 版本，不能从包含未提交改动的开发目录发布：

```sh
npm login --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile
pnpm run check
pnpm pack --dry-run
npm publish --access public --tag alpha
```

随后打开 npm 包的 **Settings → Trusted Publisher**，选择 **GitHub Actions**，填写以下内容并允许直接执行 `npm publish`：

| 字段 | 值 |
| --- | --- |
| Organization or user | `SkylerFee` |
| Repository | `dsh-llm-opencode-go-live` |
| Workflow filename | `publish.yml`，只填文件名 |
| Environment name | 留空 |
| Allowed actions | 启用 `npm publish` |

工作流使用 GitHub 托管的 runner 和 OIDC，不需要配置 `NPM_TOKEN`。首次本地发布后，从下一个未发布的新版本开始使用自动发布；已经发布的包名和版本组合不能再次发布。详见 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 和 [npm trust 前置条件](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。

## 准备并发布新版本

1. 确定本次要发布的已合并改动，递增 `package.json` 的预发布版本。下一个版本可用 `0.1.0-alpha.6`。同步更新中英文 README 的版本徽章、使用指南中的 tarball 示例，并准备发布说明。单个改动可以在其 PR 中完成版本更新；多个改动一起发布时，用单独的发版 PR 完成。
2. 发版 PR 同样需要通过 `check`。在打标签前运行 `pnpm pack --dry-run`，并按改动范围从本地 checkout 或 tarball 安装到 DSH Web profile，验证插件加载、目录刷新、设置页及模型调用。离线 CI 不替代这些运行时检查；无法运行的项目应在发布说明中明确列出。
3. 发版 PR 合并且 `main` 的 CI 通过后，确认本地 `main` 已更新到该提交，再创建并推送与 `package.json` 一致的新标签：

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.1.0-alpha.6 -m "v0.1.0-alpha.6"
   git push origin v0.1.0-alpha.6
   ```

4. 在 [GitHub Releases](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases) 中选择这个已有标签，创建 Pre-release；正式版本创建普通 Release。发布说明必须同时提供中文和英文，两种语言都要覆盖相同的新增内容、修复内容、验证范围和未运行的检查。发布 Release 会触发 `发布 npm 包` 工作流：它校验标签提交属于 `main`、标签等于 `v` 加包版本、Release 预发布状态与版本一致，再安装冻结依赖、构建测试、预检包内容并通过 OIDC 发布。预发布版本使用版本中的首个预发布标识作为 npm 标签（例如 `0.1.0-alpha.6` 使用 `alpha`），正式版本使用 `latest`。GitHub Release 的源码归档不是 npm 包。
5. 在 [Actions](https://github.com/SkylerFee/dsh-llm-opencode-go-live/actions) 确认 `发布 npm 包` 成功，并查询新版本：`npm view @skylerfee/dsh-llm-opencode-go-live@0.1.0-alpha.6 version --registry=https://registry.npmjs.org`。按[使用指南](usage.zh.md#从-npm-安装)将已发布包安装到 DSH Web profile，重启后确认 `lib/index.js` 存在、供应商与模型可见，并按改动范围做一次真实调用。记录该版本的验证结果。首次本地发布的版本无需再次触发工作流；自动化从后续新版本开始。

## 修复已发布版本

紧急 Bug 修复仍从最新 `main` 建 `fix/` 分支，按相同的 PR、CI 和发版流程发布新的标签。现有 `v*` 标签受规则保护，不能改写或删除；需要回退时重新安装上一个可用标签，再通过新版本交付修复。只有确实需要并行维护旧版本时，才另建维护分支。
