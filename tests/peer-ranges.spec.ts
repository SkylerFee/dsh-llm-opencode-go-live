import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import semver from 'semver'

/**
 * 已发布的 DeepSeek Harness 通道，以及每个通道提供的官方包版本。
 *
 * 数据取自 npm registry（2026-10-07）：
 * - `next` 通道 `@deepseek-ai/dsh-llm@0.2.0-rc.2` 声明 `@deepseek-ai/cordis` `~4.0.4`；
 * - `alpha` 通道 `@deepseek-ai/dsh-llm@0.2.1-alpha.1` 声明 `@deepseek-ai/cordis` `~4.0.5-alpha.1`。
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
] as const

/** 插件要求宿主提供的官方包。 */
const OFFICIAL_PEERS = [
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
] as const

/** 读取 `package.json` 声明的 peer 范围。 */
async function readPeers(): Promise<Record<string, string>> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  return JSON.parse(raw).peerDependencies as Record<string, string>
}

test('官方 peer 范围放行所有已发布 harness 通道的预发布版本', async () => {
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

test('peer 范围保留下一条线的上界', async () => {
  const peers = await readPeers()
  for (const name of OFFICIAL_PEERS) {
    assert.ok(!semver.satisfies('0.3.0', peers[name]), `${name} 的范围不应放行 0.3.0`)
    assert.ok(!semver.satisfies('1.0.0', peers[name]), `${name} 的范围不应放行 1.0.0`)
  }
  const cordisRange = peers['@deepseek-ai/cordis']
  assert.ok(!semver.satisfies('4.1.0', cordisRange), `@deepseek-ai/cordis 的范围不应放行 4.1.0：${cordisRange}`)
})
