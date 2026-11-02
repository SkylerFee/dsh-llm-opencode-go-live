import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import semver from 'semver'

/**
 * 已发布的 DeepSeek Harness 官方包版本，以及该版本声明的 `@deepseek-ai/cordis`
 * peer 所接受的 cordis 版本。
 *
 * 证据（npm registry 实测，2026-10-19）：
 * - `npm view @deepseek-ai/dsh-llm versions` 的 published 列表止于 `0.2.1-rc.2`；
 * - `npm view @deepseek-ai/dsh-llm dist-tags` 为 next=`0.2.1-rc.2`、
 *   alpha=`0.2.1-alpha.5`、latest=`0.0.1-rc.1`——所以下面的条目只按"版本 + 该版本
 *   声明的 cordis peer"叙述，不按通道名，避免 dist-tag 前移后注释再次失真；
 * - `npm view @deepseek-ai/dsh-llm@<version> peerDependencies.@deepseek-ai/cordis`
 *   实测：`0.1.7-rc.1` / `0.2.0-rc.1` / `0.2.0-rc.2` 声明 `~4.0.4`，
 *   `0.2.1-alpha.1` 声明 `~4.0.5-alpha.1`，`0.2.1-rc.2` 声明 `~4.0.5`；
 * - 宿主应用包 DSH `0.2.1-rc.2` 自带 `@deepseek-ai/cordis@4.0.5`（真实运行组合）。
 *
 * 这些版本都必须落在插件声明的 peer 范围内。回归的根因：`>=0.1.7-rc.1`
 * 这类不带预发布分支的范围匹配不到 `0.2.x` 的预发布构建——node-semver 只对
 * 范围里存在同 `major.minor.patch` 元组、且自身带预发布标签的比较符放行。
 */
const HOST_LINES = [
  { harness: '0.1.7-rc.1', cordis: '4.0.4', official: '0.1.7-rc.1' },
  { harness: '0.2.0-rc.1', cordis: '4.0.4', official: '0.2.0-rc.1' },
  { harness: '0.2.0-rc.2', cordis: '4.0.4', official: '0.2.0-rc.2' },
  { harness: '0.2.1-alpha.1', cordis: '4.0.5-alpha.1', official: '0.2.1-alpha.1' },
  { harness: '0.2.1-rc.2', cordis: '4.0.5', official: '0.2.1-rc.2' },
] as const

/**
 * 前瞻守护：这些版本**尚未发布**（packument 实测止于 `0.2.1-rc.2`）。
 *
 * 断言故意提前存在，用于在宿主开出下一条 patch 线时立即暴露 peer 范围失配——
 * 覆盖它的是 `>=0.2.2-0 <0.3.0-0` 这一前瞻分支。未来通道自带哪个 cordis 版本
 * 不可知，属猜测，因此这里只断言官方包版本，不断言 cordis。
 */
const PROSPECTIVE_OFFICIAL_VERSIONS = ['0.2.2-rc.1'] as const

/** 插件要求宿主提供的官方包。 */
const OFFICIAL_PEERS = [
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
] as const

/** `@earendil-works/pi-ai` 的 peer 名称。 */
const PI_AI = '@earendil-works/pi-ai'

/**
 * 明确禁止的写法：用 `major.minor.patch` 为 `0.2.0` 的元组去"通配"整条
 * `0.2.x` 线。node-semver 的预发布规则不允许跨元组匹配，所以它对当前宿主
 * `0.2.1-rc.2` 反而判 false（见下方反-陷阱用例）。
 */
const PRERELEASE_TRAP_RANGE = '>=0.2.0-0 <0.3.0-0'

/** 读取 `package.json` 的 peerDependencies、devDependencies 与 dependencies。 */
async function readManifest(): Promise<{
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  dependencies: Record<string, string>
}> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  return JSON.parse(raw) as {
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
    dependencies: Record<string, string>
  }
}

/** 读取 `package.json` 声明的 peer 范围。 */
async function readPeers(): Promise<Record<string, string>> {
  return (await readManifest()).peerDependencies
}

test('官方 peer 范围放行所有已发布 harness 版本的预发布构建', async () => {
  const peers = await readPeers()
  for (const host of HOST_LINES) {
    for (const name of OFFICIAL_PEERS) {
      const range = peers[name]
      assert.ok(
        semver.satisfies(host.official, range),
        `${name} ${host.official}（harness ${host.harness}）不满足 peer 范围 ${range}`,
      )
    }
    const cordisRange = peers['@deepseek-ai/cordis']
    assert.ok(
      semver.satisfies(host.cordis, cordisRange),
      `@deepseek-ai/cordis ${host.cordis}（harness ${host.harness}）不满足 peer 范围 ${cordisRange}`,
    )
  }
})

test('前瞻守护：尚未发布的下一条 patch 线预发布仍在范围内', async () => {
  const peers = await readPeers()
  // 0.2.2-rc.1 尚未发布（见 PROSPECTIVE_OFFICIAL_VERSIONS 注释）；这条断言的意义是：
  // 宿主真的开出这条线时，peer 范围若缺少 `>=0.2.2-0` 分支会立刻失败，而不是静默失配。
  for (const name of OFFICIAL_PEERS) {
    for (const version of PROSPECTIVE_OFFICIAL_VERSIONS) {
      assert.ok(
        semver.satisfies(version, peers[name]),
        `${name} 应放行前瞻版本 ${version}（尚未发布），当前范围 ${peers[name]}；` +
          '失配说明 `>=0.2.2-0 <0.3.0-0` 分支缺失或退化成了单个 0.2.0 元组',
      )
    }
  }
})

test('peer 范围保留下一条线的上界', async () => {
  const peers = await readPeers()
  for (const name of OFFICIAL_PEERS) {
    assert.ok(!semver.satisfies('0.3.0', peers[name]), `${name} 的范围不应放行 0.3.0`)
    assert.ok(!semver.satisfies('1.0.0', peers[name]), `${name} 的范围不应放行 1.0.0`)
  }
  const cordisRange = peers['@deepseek-ai/cordis']
  assert.ok(!semver.satisfies('4.1.0', cordisRange), `@deepseek-ai/cordis 的范围不应放行 4.1.0：${cordisRange}`)
})

test('显式边界：当前宿主与下一条 patch 线的预发布必须放行', async () => {
  const peers = await readPeers()
  // 0.2.1-rc.2 是当前真实宿主；0.2.2-rc.1 是尚未发布的前瞻版本（见
  // PROSPECTIVE_OFFICIAL_VERSIONS），由 `>=0.2.2-0` 分支覆盖；
  // 0.2.2 / 0.2.9 是稳定版，验证分支上界仍是 <0.3.0-0。
  const allowed = ['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2', '0.2.9'] as const
  for (const name of OFFICIAL_PEERS) {
    for (const version of allowed) {
      assert.ok(
        semver.satisfies(version, peers[name]),
        `${name} 应放行 ${version}，当前范围 ${peers[name]}（宿主开新 patch 线时需补一条分支）`,
      )
    }
  }
})

test('显式边界：越过下一条线的版本必须拒绝', async () => {
  const peers = await readPeers()
  const rejected = ['0.3.0-rc.1', '0.3.0', '1.0.0'] as const
  for (const name of OFFICIAL_PEERS) {
    for (const version of rejected) {
      assert.ok(!semver.satisfies(version, peers[name]), `${name} 的范围不应放行 ${version}：${peers[name]}`)
    }
  }
})

test('已知未覆盖的预发布元组：宿主开新 patch 线时会在 CI 立即报错', async () => {
  const peers = await readPeers()
  // node-semver 只对"同 major.minor.patch 元组、且自身带预发布标签"的比较符放行预发布，
  // 因此 0.2.3 / 0.2.9 / 0.2.10 的预发布不会被现有 0.2.1 / 0.2.2 分支覆盖。这是规则的
  // 固有结果，不是笔误：宿主每开一条新的 patch 线，都需要同时在这里和 package.json 的
  // dsh* peer 范围里补一条 `>=<新元组>-0 <0.3.0-0` 分支，让守护用例把它固化为显式断言。
  const uncovered = ['0.2.3-rc.1', '0.2.9-rc.1', '0.2.10-rc.1'] as const
  for (const name of OFFICIAL_PEERS) {
    for (const version of uncovered) {
      assert.ok(
        !semver.satisfies(version, peers[name]),
        `${name} 目前不应放行 ${version}；若宿主已开这条 patch 线，请在 package.json 与本用例同步补分支`,
      )
    }
  }
})

test('反-陷阱守护：禁止用单个 0.2.0 元组通配整条 0.2.x 线', async () => {
  const peers = await readPeers()
  // 把"陷阱写法确实会失配"固定下来；它与具体包无关，只断言一次。
  assert.ok(
    !semver.satisfies('0.2.1-rc.2', PRERELEASE_TRAP_RANGE),
    `${PRERELEASE_TRAP_RANGE} 是明确禁止的写法：它会把当前宿主 0.2.1-rc.2 判为不满足`,
  )
  for (const name of OFFICIAL_PEERS) {
    assert.ok(
      semver.satisfies('0.2.1-rc.2', peers[name]),
      `${name} 必须放行当前宿主 0.2.1-rc.2，实际范围 ${peers[name]}：` +
        `不要改成 ${PRERELEASE_TRAP_RANGE}，那会让 0.2.1-rc.2 失配`,
    )
  }
})

test('四个 dsh* 官方包的 peer 范围字符串完全一致（防止逐包漂移）', async () => {
  const peers = await readPeers()
  const [reference, ...rest] = OFFICIAL_PEERS.map((name) => ({ name, range: peers[name] }))
  assert.ok(reference.range, `${reference.name} 缺少 peer 范围声明`)
  for (const entry of rest) {
    assert.equal(
      entry.range,
      reference.range,
      `${entry.name} 的 peer 范围与 ${reference.name} 不一致：\n  ${entry.name}: ${entry.range}\n  ${reference.name}: ${reference.range}`,
    )
  }
})

test('pi-ai peer 覆盖宿主实际提供的 0.87.1 / 1.0.2 / 1.1.0', async () => {
  const peers = await readPeers()
  const range = peers[PI_AI]
  assert.ok(range, `${PI_AI} 缺少 peer 范围声明`)
  // 宿主应用包提供 1.1.0；`~/.dsh/profiles/node_modules` 软链指向 1.0.2；
  // 0.87.1 是历史 devDep/最低线，1.3.0 代表 1.x 后续小版本。
  const provided = ['0.87.1', '1.0.2', '1.1.0', '1.3.0'] as const
  for (const version of provided) {
    assert.ok(semver.satisfies(version, range), `${PI_AI} 应放行宿主可能提供的 ${version}，当前范围 ${range}`)
  }
})

test('pi-ai peer 拒绝 0.88.0 与 2.0.0', async () => {
  const peers = await readPeers()
  const range = peers[PI_AI]
  for (const version of ['0.88.0', '2.0.0'] as const) {
    assert.ok(!semver.satisfies(version, range), `${PI_AI} 的范围不应放行 ${version}：${range}`)
  }
})

test('pi-ai devDependency 与 peer 范围同步（精确 1.1.0）', async () => {
  const { peerDependencies, devDependencies } = await readManifest()
  assert.equal(
    devDependencies[PI_AI],
    '1.1.0',
    `${PI_AI} 的开发依赖应精确固定为宿主提供的 1.1.0，实际 ${devDependencies[PI_AI]}`,
  )
  assert.ok(
    semver.satisfies(devDependencies[PI_AI], peerDependencies[PI_AI]),
    `${PI_AI} 的 devDependency ${devDependencies[PI_AI]} 必须落在 peer 范围 ${peerDependencies[PI_AI]} 内`,
  )
})

test('依赖声明与宿主线对齐（cordis / 四个 dsh* / schemastery）', async () => {
  const { peerDependencies, devDependencies, dependencies } = await readManifest()
  // 宿主线实测值（2026-10-19）：DSH 0.2.1-rc.2 自带 cordis 4.0.5 与 schemastery 3.18.5。
  // 这条用例防止 devDeps 再次静默停留在旧宿主（0.2.0-rc.2 / cordis 4.0.4）。
  const HOST_LINE = '0.2.1-rc.2'
  for (const name of OFFICIAL_PEERS) {
    assert.equal(
      devDependencies[name],
      HOST_LINE,
      `${name} 的开发依赖应精确为宿主线 ${HOST_LINE}，实际 ${devDependencies[name]}`,
    )
    assert.ok(
      semver.satisfies(devDependencies[name], peerDependencies[name]),
      `${name} 的开发依赖 ${devDependencies[name]} 必须落在 peer 范围 ${peerDependencies[name]} 内`,
    )
  }
  assert.equal(
    devDependencies['@deepseek-ai/cordis'],
    '4.0.5',
    `@deepseek-ai/cordis 的开发依赖应精确为宿主线 4.0.5，实际 ${devDependencies['@deepseek-ai/cordis']}`,
  )
  assert.ok(
    semver.satisfies(devDependencies['@deepseek-ai/cordis'], peerDependencies['@deepseek-ai/cordis']),
    `@deepseek-ai/cordis 的开发依赖 ${devDependencies['@deepseek-ai/cordis']} 必须落在 peer 范围 ` +
      `${peerDependencies['@deepseek-ai/cordis']} 内`,
  )
  // schemastery 是运行时依赖，这里钉住两项事实：
  // 1) 精确值与宿主线实测一致（3.18.5，见宿主 app.asar 基线）；
  // 2) 范围必须放行宿主提供的 3.18.5——`~3.18.4` 这类旧写法虽然也放行 3.18.5，
  //    但会让 dev 树按旧锁解析出第二份 schemastery，公共 d.ts 随即以
  //    TS2883（推断类型无法命名）失败，所以第 1 条断言必须存在。
  // 若将来有意放宽范围，请同时确认 dev 树仍只有一份 schemastery 并更新本断言。
  assert.equal(
    dependencies['@deepseek-ai/schemastery'],
    '~3.18.5',
    `@deepseek-ai/schemastery 应与宿主线对齐为 ~3.18.5，实际 ${dependencies['@deepseek-ai/schemastery']}`,
  )
  assert.ok(
    semver.satisfies('3.18.5', dependencies['@deepseek-ai/schemastery']),
    `@deepseek-ai/schemastery ${dependencies['@deepseek-ai/schemastery']} 必须放行宿主提供的 3.18.5`,
  )
})
