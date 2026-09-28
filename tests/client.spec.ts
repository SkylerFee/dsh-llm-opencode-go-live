import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** 等待客户端的异步读取与 React 状态更新完成。 */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** 在纯对象元素树中寻找一个指定节点。 */
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as Element
  if (predicate(element)) return element
  return element.children?.map(child => find(child, predicate)).find(Boolean)
}

interface Element {
  type: string
  props: Record<string, any>
  children: unknown[]
}

test('客户端卡片仅在点击编辑后允许修改密钥并显示动态模型', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')

  let registration: { id: string; factory: (require: (name: string) => unknown) => any } | undefined
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  runInNewContext(client, { window: { __ModuleLoader__: { load: (entry: typeof registration) => { registration = entry } } } })
  assert.equal(registration?.id, pkg.name)

  const state: unknown[] = []
  const effects: { deps: unknown[]; dispose?: () => void }[] = []
  const pending: { index: number; run: () => void; deps: unknown[] }[] = []
  let cursor = 0
  const React = {
    createElement: (type: string, props: Record<string, any> | null, ...children: unknown[]): Element => ({
      type, props: props ?? {}, children,
    }),
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect(run: () => (() => void), deps: unknown[]) {
      const index = cursor++
      const previous = effects[index]
      if (previous === undefined || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.dispose?.()
        pending.push({ index, run, deps })
      }
    },
  }
  const extension = registration!.factory((name: string) => {
    assert.equal(name, 'react')
    return React
  })
  let component: ((props: { t: (key: string) => string }) => Element) | undefined
  let dictionary: Record<string, string> = {}
  let ref = 'OPENCODE_GO_LIVE_API_KEY'
  let models = [{ id: 'new-model', name: 'New Model' }]
  let configured = false
  const saved: [string, string][] = []
  const listeners = new Map<string, ((...args: string[]) => void)[]>()
  const ctx = {
    effect: (setup: () => () => void) => { setup() },
    locale: { register: (_ns: string, copy: { zh: Record<string, string> }) => {
      dictionary = copy.zh
      return () => {}
    } },
    slots: {
      inject: (name: string, register: () => void) => { assert.equal(name, 'settings.models.footer'); register() },
      register: (_meta: unknown, render: typeof component) => { component = render },
    },
    remote: {
      settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'llm-opencode-go-live', value: { apiKeyEnv: ref } }] } }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'opencode-go-live', models }], failures: [] } }) },
      credentials: {
        describe: async () => ({ ok: true, value: { [ref]: { configured, writable: true } } }),
        set: async (name: string, key: string) => { saved.push([name, key]); configured = true; return { ok: true } },
      },
      $on: (event: string, callback: (...args: string[]) => void) => {
        listeners.set(event, [...listeners.get(event) ?? [], callback])
        return () => { listeners.set(event, listeners.get(event)!.filter(item => item !== callback)) }
      },
    },
  }
  extension.apply(ctx)
  assert.ok(component)
  const t = (key: string): string => dictionary[key]!
  /** 执行模拟 React 渲染及这次渲染新注册的 effect。 */
  function render(): Element {
    cursor = 0
    const tree = component!({ t })
    for (const next of pending.splice(0)) {
      effects[next.index] = { deps: next.deps, dispose: next.run() }
    }
    return tree
  }

  render()
  await settle()
  let tree = render()
  assert.equal(find(tree, node => node.type === 'code' && node.children[0] === 'new-model')?.children[0], 'new-model')
  assert.equal(find(tree, node => node.type === 'input'), undefined)
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  const input = find(tree, node => node.type === 'input')!
  input.props.onChange({ target: { value: 'discarded-key' } })
  tree = render()
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.cancel)!.props.onClick()
  tree = render()
  assert.equal(find(tree, node => node.type === 'input'), undefined)
  assert.deepEqual(saved, [])
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  assert.equal(find(tree, node => node.type === 'input')?.props.value, '')
  const activeInput = find(tree, node => node.type === 'input')!
  activeInput.props.onChange({ target: { value: 'sk-test-live' } })
  tree = render()
  await find(tree, node => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
  await settle()
  tree = render()
  await settle()
  tree = render()
  assert.deepEqual(saved, [['OPENCODE_GO_LIVE_API_KEY', 'sk-test-live']])
  assert.equal(find(tree, node => node.type === 'input'), undefined)
  assert.ok(find(tree, node => node.type === 'p' && node.children[0] === dictionary.configured))

  // 编辑期间凭据引用变化：草稿作废，旧引用的密钥不得写进新引用
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  find(tree, node => node.type === 'input')!.props.onChange({ target: { value: 'stale-draft-key' } })
  tree = render()
  assert.equal(find(tree, node => node.type === 'input')?.props.value, 'stale-draft-key')

  ref = 'CUSTOM_GO_KEY'
  models = [{ id: 'later-model', name: 'Later Model' }]
  listeners.get('settings/document-updated')![0]!('llm-opencode-go-live')
  await settle()
  tree = render()
  assert.ok(find(tree, node => node.type === 'code' && node.children[0] === 'later-model'))
  tree = render()
  assert.equal(find(tree, node => node.type === 'input'), undefined)
  assert.deepEqual(saved, [['OPENCODE_GO_LIVE_API_KEY', 'sk-test-live']])
  find(tree, node => node.type === 'button' && node.children[0] === dictionary.edit)!.props.onClick()
  tree = render()
  find(tree, node => node.type === 'input')!.props.onChange({ target: { value: 'sk-next-live' } })
  tree = render()
  await find(tree, node => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(saved[1], ['CUSTOM_GO_KEY', 'sk-next-live'])
  for (const effect of effects) effect?.dispose?.()
})
