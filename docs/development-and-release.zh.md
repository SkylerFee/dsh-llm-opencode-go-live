# 开发与发布流程

[English](development-and-release.md) | 中文

本仓库目前通过 GitHub 的 `v*` 标签和预发布版本交付插件，尚未发布到 registry。新功能和 Bug 修复都从最新 `main` 创建短期分支，经 Pull Request 合并；当前没有维护旧版本的长期发布分支。

## 开发与合并

1. 新功能或文档完善从最新 `main` 创建 `feat/short-name` 分支，Bug 修复创建 `fix/short-name` 分支；不直接向 `main` 推送。Bug 修复先确认根因，并添加能复现原问题的回归测试；新功能为非平凡行为添加测试。修改配置、路由、缓存或模型字段时，同步更新受影响的中英文文档。
2. 在插件仓库运行 `pnpm run check`。涉及安装或打包内容时再运行 `pnpm pack --dry-run`，检查产物不含 `node_modules/`、测试文件或敏感数据。涉及用户可见的模型或设置行为时，在 DSH Web profile 验证受影响的实际路径，并在 PR 中说明未运行的真实 API 或运行时检查。
3. 向 `main` 发起 PR，写明行为变化、验证结果和已知限制。当前[仓库规则](https://github.com/SkylerFee/dsh-llm-opencode-go-live/rules)要求经过 PR，且 GitHub Actions 的 `check` 必须通过；批准人数为 0。CI 在 Node.js 22 上构建并运行离线测试，不访问 Models.dev 或真实 OpenCode Go API。
4. `check` 通过后合并 PR。当前规则不要求 PR 分支始终与 `main` 同步；如果等待期间 `main` 已前进，先更新分支并确认检查重新通过。合并后还要等待 `main` 的推送 CI 通过，再以该分支的最终提交准备发布。

## 准备并发布新版本

1. 确定本次要发布的已合并改动，递增 `package.json` 的预发布版本。下一个版本可用 `0.1.0-alpha.4`。同步更新中英文 README 的版本徽章与安装命令、使用指南中的标签与 tarball 示例，并准备发布说明。单个改动可以在其 PR 中完成版本更新；多个改动一起发布时，用单独的发版 PR 完成。
2. 发版 PR 同样需要通过 `check`。在打标签前运行 `pnpm pack --dry-run`，并按改动范围从本地 checkout 或 tarball 安装到 DSH Web profile，验证插件加载、目录刷新、设置页及模型调用。离线 CI 不替代这些运行时检查；无法运行的项目应在发布说明中明确列出。
3. 发版 PR 合并且 `main` 的 CI 通过后，确认本地 `main` 已更新到该提交，再创建并推送与 `package.json` 一致的新标签：

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.1.0-alpha.4 -m "v0.1.0-alpha.4"
   git push origin v0.1.0-alpha.4
   ```

4. 在 [GitHub Releases](https://github.com/SkylerFee/dsh-llm-opencode-go-live/releases) 中选择这个已有标签，创建 Pre-release，写明新增内容、修复内容和验证范围。当前没有自动发布工作流，也没有 registry 包；GitHub Release 的源码归档不是 `pnpm pack` 产物。
5. 从新标签按[使用指南](usage.zh.md#从-github-安装)安装到 DSH Web profile，重启后确认 `lib/index.js` 存在、供应商与模型可见，并按改动范围做一次真实调用。记录该标签的验证结果。

## 修复已发布版本

紧急 Bug 修复仍从最新 `main` 建 `fix/` 分支，按相同的 PR、CI 和发版流程发布新的标签。现有 `v*` 标签受规则保护，不能改写或删除；需要回退时重新安装上一个可用标签，再通过新版本交付修复。只有确实需要并行维护旧版本时，才另建维护分支。
