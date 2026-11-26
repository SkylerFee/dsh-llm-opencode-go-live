import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OTHER_VENDOR, transformProvider, vendorCounts, vendorLabel, vendorOf } from '../src/index.js'

test('从 canonical_model_id 提取厂商标识', () => {
  assert.equal(vendorOf('moonshotai/kimi-k3'), 'moonshotai')
  assert.equal(vendorOf('ZhipuAI/glm-5.3'), 'zhipuai', '应统一小写')
  assert.equal(vendorOf('deepseek/deepseek-v4-pro'), 'deepseek')
})

test('缺少规范 id 或格式不符时返回 undefined，不编造厂商', () => {
  for (const bad of [undefined, null, 42, '', '/kimi-k3', 'kimi-k3', '  /x']) {
    assert.equal(vendorOf(bad), undefined, `输入 ${JSON.stringify(bad)} 不应产生厂商`)
  }
})

test('厂商代号映射成可读名，未收录代号按原样首字母大写', () => {
  assert.equal(vendorLabel('zhipuai'), 'Z.ai')
  assert.equal(vendorLabel('moonshotai'), 'Moonshot')
  assert.equal(vendorLabel('xai'), 'xAI')
  assert.equal(vendorLabel('somefuturevendor'), 'Somefuturevendor')
  assert.equal(vendorLabel(undefined), 'Other')
})

test('厂商计数把无归属归入 other', () => {
  assert.deepEqual(vendorCounts({ a: 'openai', b: 'openai', c: 'xai', d: undefined }), {
    openai: 2, xai: 1, [OTHER_VENDOR]: 1,
  })
})

test('转换结果带出厂商映射，且不影响模型成员', () => {
  const result = transformProvider({
    models: {
      'kimi-k3': { tool_call: true, limit: { context: 100, output: 10 }, canonical_model_id: 'moonshotai/kimi-k3' },
      'glm-5.3': { tool_call: true, limit: { context: 100, output: 10 }, canonical_model_id: 'zhipuai/glm-5.3' },
      // 没有规范 id：仍应进入目录，只是不参与分组
      'mystery': { tool_call: true, limit: { context: 100, output: 10 } },
    },
  })
  assert.deepEqual(result.models.map(model => model.id).sort(), ['glm-5.3', 'kimi-k3', 'mystery'])
  assert.deepEqual(result.vendors, { 'kimi-k3': 'moonshotai', 'glm-5.3': 'zhipuai' })
  assert.equal('mystery' in result.vendors, false, '无厂商的模型不应被编造厂商')
})

test('来源结构非法时厂商映射为空对象而不是缺失', () => {
  const result = transformProvider({ models: undefined })
  assert.deepEqual(result.vendors, {})
  assert.equal(result.models.length, 0)
})
