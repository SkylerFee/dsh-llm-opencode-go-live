import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import semver from 'semver'

/**
 * 宿主的插件兼容闸门判定。
 *
 * 实测 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`：
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。
 * 传 `includePrerelease` 意味着预发布版本按普通版本参与比较，不再受
 * "范围里必须有同 major.minor.patch 元组的预发布比较符"这条限制。
 *
 * 本文件的所有断言都用这个语义，否则测的就不是宿主的真实行为。
 */
function gate(version: string, range: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true })
}

/**
 * 已发布且有实测 cordis 声明的 harness 版本。
 *
 * 下限是 `>=0.1.7-rc.1`：这些版本此前都逐条验证过，只声明下限后它们仍然全部命中，
 * 因此保留原始下限而不是收紧到当前宿主线。
 */
const HOST_LINES = [
  { harness: '0.1.7-rc.1', cordis: '4.0.4' },
  { harness: '0.2.0-rc.1', cordis: '4.0.4' },
  { harness: '0.2.0-rc.2', cordis: '4.0.4' },
  { harness: '0.2.1-alpha.1', cordis: '4.0.5-alpha.1' },
  { harness: '0.2.1-rc.2', cordis: '4.0.5' },
  { harness: '0.2.2-rc.1', cordis: '4.0.5' },
] as const

/** 插件要求宿主提供的官方包。 */
const OFFICIAL_PEERS = [
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
] as const

/** `@earendil-works/pi-ai` 的 peer 名称。 */
const PI_AI = '@earendil-works/pi-ai'

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

test('dsh* peer 只声明下限，不再写 OR 分支或上界', async () => {
  const peers = await readPeers()
  for (const name of OFFICIAL_PEERS) {
    const range = peers[name]
    assert.ok(range, `${name} 缺少 peer 范围声明`)
    assert.equal(range, '>=0.1.7-rc.1', `${name} 应只声明历史上已验证的下限 >=0.1.7-rc.1，实际 ${range}`)
    assert.ok(!range.includes('||'), `${name} 不应再枚举 OR 分支：${range}`)
    assert.ok(!/<\d/.test(range), `${name} 不应再声明上界：${range}`)
  }
})

test('dsh* peer 的四个包声明完全一致（防止逐包漂移）', async () => {
  const peers = await readPeers()
  const [reference, ...rest] = OFFICIAL_PEERS.map((name) => ({ name, range: peers[name] }))
  for (const entry of rest) {
    assert.equal(
      entry.range,
      reference.range,
      `${entry.name} 的 peer 范围与 ${reference.name} 不一致：\n  ${entry.name}: ${entry.range}\n  ${reference.name}: ${reference.range}`,
    )
  }
})

test('所有已发布的 harness 线都满足 peer 下限', async () => {
  const peers = await readPeers()
  for (const host of HOST_LINES) {
    for (const name of OFFICIAL_PEERS) {
      assert.ok(gate(host.harness, peers[name]), `${name} ${host.harness} 不满足 ${peers[name]}`)
    }
    assert.ok(
      gate(host.cordis, peers['@deepseek-ai/cordis']),
      `@deepseek-ai/cordis ${host.cordis} 不满足 ${peers['@deepseek-ai/cordis']}`,
    )
  }
})

test('只声明下限时，未来所有 0.2.x 预发布都被放行（含新 patch 线）', async () => {
  const peers = await readPeers()
  // 这是"只声明下限"带来的实际收益：不必再为每条新 patch 线补分支。
  // 这些版本在 `includePrerelease: false` 的旧写法下需要逐条枚举。
  const future = ['0.2.1', '0.2.2', '0.2.3-rc.1', '0.2.9-rc.1', '0.2.10-rc.1'] as const
  for (const name of OFFICIAL_PEERS) {
    for (const version of future) {
      assert.ok(gate(version, peers[name]), `${name} 应放行 ${version}，当前范围 ${peers[name]}`)
    }
  }
})

test('只声明下限也意味着不拦截 0.3.0 与 1.0.0（已知取舍）', async () => {
  const peers = await readPeers()
  // 把"没有上界"这件事显式写成断言：它不是遗漏，而是明确接受的行为。
  // 若将来要重新加回上界，这条用例会提醒同时更新正文说明。
  for (const name of OFFICIAL_PEERS) {
    for (const version of ['0.3.0-rc.1', '0.3.0', '1.0.0'] as const) {
      assert.ok(gate(version, peers[name]), `${name} 无上界，${version} 会被放行；若需拦截请补上界`)
    }
  }
})

test('下限覆盖所有声明过的 devDependency 宿主线', async () => {
  const { peerDependencies, devDependencies } = await readManifest()
  for (const name of OFFICIAL_PEERS) {
    assert.ok(
      gate(devDependencies[name]!, peerDependencies[name]!),
      `${name} 的 devDependency ${devDependencies[name]} 必须落在 peer 范围 ${peerDependencies[name]} 内`,
    )
  }
  assert.ok(
    gate(devDependencies['@deepseek-ai/cordis']!, peerDependencies['@deepseek-ai/cordis']!),
    '@deepseek-ai/cordis 的 devDependency 必须落在 peer 范围内',
  )
})

test('cordis 仍保留上界：协议层大版本不兼容不应当静默放行', async () => {
  const range = (await readPeers())['@deepseek-ai/cordis']
  assert.ok(gate('4.0.4', range), `cordis 4.0.4 应放行：${range}`)
  assert.ok(gate('4.0.5-alpha.1', range), `cordis 4.0.5-alpha.1 应放行：${range}`)
  assert.ok(gate('4.0.5', range), `cordis 4.0.5 应放行：${range}`)
  assert.ok(!gate('4.1.0', range), `cordis 4.1.0 不应放行：${range}`)
})

test('pi-ai peer 覆盖宿主实际提供的版本，并拒绝 0.88.0 与 2.0.0', async () => {
  const range = (await readPeers())[PI_AI]
  assert.ok(range, `${PI_AI} 缺少 peer 范围声明`)
  // 宿主应用包提供 1.1.0；profile 软链曾指向 1.0.2；0.87.1 是历史最低线。
  for (const version of ['0.87.1', '1.0.2', '1.1.0', '1.3.0'] as const) {
    assert.ok(gate(version, range), `${PI_AI} 应放行 ${version}，当前范围 ${range}`)
  }
  for (const version of ['0.88.0', '2.0.0'] as const) {
    assert.ok(!gate(version, range), `${PI_AI} 不应放行 ${version}，当前范围 ${range}`)
  }
})

test('pi-ai devDependency 精确固定为宿主提供的 1.1.0', async () => {
  const { peerDependencies, devDependencies } = await readManifest()
  assert.equal(devDependencies[PI_AI], '1.1.0', `${PI_AI} 的开发依赖应为 1.1.0`)
  assert.ok(
    gate(devDependencies[PI_AI]!, peerDependencies[PI_AI]!),
    `${PI_AI} 的 devDependency 必须落在 peer 范围内`,
  )
})

test('schemastery 与宿主线对齐，避免公共 d.ts 报 TS2883', async () => {
  const { dependencies } = await readManifest()
  // 精确值必须与宿主线一致：`~3.18.4` 也会放行 3.18.5，但会让 dev 树解析出
  // 第二份 schemastery，公共 d.ts 随即以 TS2883（推断类型无法命名）失败。
  assert.equal(dependencies['@deepseek-ai/schemastery'], '~3.18.5')
  assert.ok(semver.satisfies('3.18.5', dependencies['@deepseek-ai/schemastery']!))
})
