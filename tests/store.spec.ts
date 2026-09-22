import { strict as assert } from 'node:assert'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JsonCatalogStore } from '../src/store.js'

test('JSON 存储使用可恢复快照且不写入临时残留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-opencode-go-live-'))
  const path = join(directory, 'catalog.json')
  const store = new JsonCatalogStore(path)
  const snapshot = { version: 1 as const, checkedAt: new Date(0).toISOString(), models: [], diagnostics: [] }
  await store.save(snapshot)
  assert.deepEqual(await store.load(), snapshot)
  assert.match(await readFile(path, 'utf8'), /"version":1/)
})
