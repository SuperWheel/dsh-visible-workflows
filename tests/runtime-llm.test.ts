import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { harnessModels, modelCatalog } from '../src/host/llm.ts'

/** SDK-shaped test double only. These tests do not contact a model or consume tokens. */
function adapter(chunks: StreamChunk[], listed = true) {
  const seen: GenerateOptions[] = []
  const mock = {
    listModels: vi.fn(async () => listed ? [{ provider: 'test-double', id: 'fake-model', name: '测试模型' }] : []),
    resolveModelInfo: vi.fn(async () => ({ provider: 'test-double', id: 'fake-model', name: '测试模型', reasoning: { efforts: [{ id: 'low', name: '低' }] } })),
    stream: async function* (options: GenerateOptions) { seen.push(options); for (const chunk of chunks) yield chunk },
  }
  return { backend: harnessModels(mock as unknown as LlmRuntime), mock, seen }
}
const request = () => ({ model: { provider: 'test-double', model: 'fake-model' }, effort: 'low', prompt: '用户输入', system: '角色提示词', signal: new AbortController().signal })

describe('真实 SDK 适配边界（使用明示测试替身，无网络）', () => {
  it('仅接受明确完成的文本流，并传递角色、模型、强度与取消信号', async () => {
    const { backend, seen } = adapter([{ type: 'text-delta', index: 0, text: '结果' }, { type: 'finish', reason: { kind: 'stop' } }])
    const req = request()
    expect(await backend.generate(req)).toBe('结果')
    expect(seen[0]).toMatchObject({ provider: 'test-double', model: 'fake-model', reasoningEffort: 'low', system: '角色提示词', messages: [{ role: 'user', content: [{ type: 'text', text: '用户输入' }] }], signal: req.signal })
  })
  it('提供方失败与部分文本不能被误报为成功', async () => {
    const { backend } = adapter([{ type: 'text-delta', index: 0, text: '部分文本' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '凭据无效' } } }])
    await expect(backend.generate(request())).rejects.toThrow('[AUTH] 凭据无效')
  })
  it('意外断流和截断输出不会伪造完整结果', async () => {
    await expect(adapter([{ type: 'text-delta', index: 0, text: '部分' }]).backend.generate(request())).rejects.toThrow('未收到完成标记')
    await expect(adapter([{ type: 'finish', reason: { kind: 'max-tokens' } }]).backend.generate(request())).rejects.toThrow('结果不完整')
  })
  it('模型不在当前宿主目录中时不发起流', async () => {
    const { backend, seen } = adapter([], false)
    await expect(backend.generate(request())).rejects.toThrow('可用目录')
    expect(seen).toEqual([])
  })
  it('无效思考强度在提供方 I/O 前拒绝', async () => {
    const { backend, seen } = adapter([])
    await expect(backend.generate({ ...request(), effort: 'invented-effort' })).rejects.toThrow('不受此模型支持')
    expect(seen).toEqual([])
  })
  it('已经取消的请求不读取目录、不调用模型', async () => {
    const { backend, mock, seen } = adapter([]), controller = new AbortController(); controller.abort(new Error('已取消'))
    await expect(backend.generate({ ...request(), signal: controller.signal })).rejects.toThrow('已取消')
    expect(mock.listModels).not.toHaveBeenCalled(); expect(seen).toEqual([])
  })
  it('reports exact usage including cache totals once, even when a model finishes with an error', async () => {
    const onUsage = vi.fn()
    const { backend } = adapter([{ type:'usage',usage:{inputTokens:5,outputTokens:2,cacheReadTokens:8,totalTokens:15} },{type:'finish',reason:{kind:'max-tokens'}}])
    await expect(backend.generate({...request(),onUsage})).rejects.toThrow('结果不完整')
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({inputTokens:5,outputTokens:2,totalTokens:15})
  })
  it('keeps absent or incomplete provider usage unknown instead of settling zero', async () => {
    const onUsage=vi.fn()
    await adapter([{type:'finish',reason:{kind:'stop'}}]).backend.generate({...request(),onUsage})
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined)
    const incomplete=vi.fn()
    await adapter([{type:'usage',usage:{inputTokens:5,outputTokens:2}},{type:'finish',reason:{kind:'stop'}}]).backend.generate({...request(),onUsage:incomplete})
    expect(incomplete).toHaveBeenCalledExactlyOnceWith(undefined)
  })
  it('ignores obsolete plugin token caps and leaves output configuration to the provider', async()=>{
    const {backend,seen}=adapter([{type:'finish',reason:{kind:'stop'}}])
    await backend.generate({...request(),maxTokens:512} as any)
    await backend.generate({...request(),maxTokens:0} as any)
    expect(seen).toHaveLength(2)
    expect(seen.every(value=>!Object.hasOwn(value,'maxTokens'))).toBe(true)
  })
  it('单个提供方或模型失败不会隐藏其他可用模型，也不会替用户换模型', async () => {
    const catalog = await modelCatalog({
      listProviders: () => [{ id: 'offline', name: '离线服务' }, { id: 'online', name: '在线服务' }],
      listModels: async provider => { if (provider === 'offline') throw new Error('测试目录失败'); return [{ provider, id: 'bad', name: '坏模型' }, { provider, id: 'good', name: '好模型' }] },
      resolveModelInfo: async (provider, model) => { if (model === 'bad') throw new Error('测试能力失败'); return { provider, id: model, name: '好模型' } },
    })
    expect(catalog.choices).toEqual([{ provider: 'online', model: 'good', label: '好模型 · 在线服务', efforts: [] }])
    expect(catalog.failures).toHaveLength(2)
  })
})
