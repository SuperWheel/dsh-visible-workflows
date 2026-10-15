import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import { makeWorkflow, type WorkflowModelDefaults, type WorkflowNode } from '../src/shared/types.ts'
import { applyModelDefaults, sessionModelDefaults } from '../src/host/model-defaults.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelRequest } from '../src/host/runtime.ts'

const defaults: WorkflowModelDefaults = { model: { provider: 'configured-provider', model: 'chosen-model' }, effort: 'high', source: 'session' }
const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const contexts: { path: string; runtime: WorkflowRuntime }[] = []
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'workflow-default-model-')), requests: ModelRequest[] = []
  const storage = new WorkflowStorage(path), runtime = new WorkflowRuntime(storage, { generate: async request => { requests.push(request); return request.prompt } })
  contexts.push({ path, runtime }); return { storage, runtime, requests }
}
afterEach(async () => { for (const { path, runtime } of contexts.splice(0)) { await runtime.close(); rmSync(path, { recursive: true, force: true }) } })

describe('DSH 默认模型与运行快照（无真实模型请求）', () => {
  it('新选择优先于旧请求，未指定 effort 不从旧请求补回', () => {
    const header = { config: { provider: 'old', model: 'old', reasoningEffort: 'ultra' } } as EpochHeader
    expect(sessionModelDefaults({ provider: 'new', model: 'new' }, header)).toEqual({ model: { provider: 'new', model: 'new' }, source: 'session' })
  })
  it('上轮由 adapter 推导的强度保持 provider 默认，不固化为显式 high', () => {
    const header = { config: { provider: 'p', model: 'm', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } as EpochHeader
    expect(sessionModelDefaults(null, header)).toEqual({ model: { provider: 'p', model: 'm' }, source: 'session' })
    delete header.adapterDefaults
    expect(sessionModelDefaults(null, header)?.effort).toBe('high')
  })
  it.each(['llm', 'agent', 'classifier', 'extractor'] as const)('%s 缺省模型继承且显式低强度保留', kind => {
    const graph = { nodes: [node('n', kind, { effort: 'low' })], edges: [] }
    applyModelDefaults(graph, defaults)
    expect(graph.nodes[0]!.config).toEqual({ model: defaults.model, effort: 'low' })
  })
  it('显式另一模型不继承无关模型的强度；同模型可继承；显式配置均保留', () => {
    const graph = { nodes: [node('other', 'llm', { model: { provider: 'p', model: 'other' } }), node('same', 'llm', { model: { ...defaults.model } }), node('explicit', 'llm', { model: { provider: 'p', model: 'other' }, effort: 'low' })], edges: [] }
    applyModelDefaults(graph, defaults)
    expect(graph.nodes.map(n => n.config.effort)).toEqual([undefined, 'high', 'low'])
    expect(graph.nodes[0]!.config.model).toEqual({ provider: 'p', model: 'other' })
  })
  it('没有配置时明确失败，显式模型和纯数据流程仍可执行', async () => {
    const { storage, runtime, requests } = setup(), flow = makeWorkflow('workspace', 'missing', true)
    flow.nodes[1]!.kind = 'llm'; flow.nodes[1]!.config = { prompt: '{{input.text}}' }
    const saved = storage.save(flow, 0)
    expect(() => runtime.start(saved.id, { text: 'x' })).toThrow('DSH 也未配置默认模型')
    expect(storage.runs()).toHaveLength(0)
    flow.nodes[1]!.config.model = { provider: 'explicit', model: 'kept' }
    storage.save(flow, 1)
    expect((await runtime.settle(runtime.start(flow.id, { text: 'x' }).id)).status).toBe('success')
    expect(requests[0]!.model).toEqual({ provider: 'explicit', model: 'kept' })
    const pure = storage.save(makeWorkflow('workspace', 'pure', true), 0)
    expect((await runtime.settle(runtime.start(pure.id, { text: 'pure' }).id)).outputs.result).toContain('pure')
    expect(requests).toHaveLength(1)
  })
  it('嵌套迭代和 waiting 恢复使用启动快照，编辑草稿保持跟随', async () => {
    const { storage, runtime, requests } = setup(), flow = makeWorkflow('workspace')
    flow.nodes = [node('input', 'input', { fields: [{ name: 'text', label: '文本', required: true }] }), node('iterate', 'iteration', { iterator: '[1,2]', outputVariable: 'model.text', body: { nodes: [node('body-input', 'input', {}), node('model', 'llm', { prompt: '{{input.text}}:{{item}}' }), node('body-output', 'output', { text: '{{model.text}}', outputName: 'item' })], edges: [{ id: 'body-a', source: 'body-input', target: 'model' }, { id: 'body-b', source: 'model', target: 'body-output' }] } }), node('output', 'output', { text: '{{iterate.result}}', outputName: 'result' })]
    flow.edges = [{ id: 'a', source: 'input', target: 'iterate' }, { id: 'b', source: 'iterate', target: 'output' }]
    const saved = storage.save(flow, 0), selected = structuredClone(defaults), waiting = runtime.start(saved.id, {}, selected)
    expect(waiting.status).toBe('waiting')
    expect(waiting.graph.nodes[1]!.config.body!.nodes[1]!.config.model).toEqual(defaults.model)
    expect(storage.get(saved.id).nodes[1]!.config.body!.nodes[1]!.config.model).toBeUndefined()
    selected.model.model = 'changed-later'; selected.effort = 'low'
    runtime.answer(waiting.id, { text: 'frozen' })
    const done = await runtime.settle(waiting.id)
    expect(done.status).toBe('success')
    expect(done.modelDefaults).toEqual(defaults)
    expect(requests).toHaveLength(2)
    expect(requests.map(r => [r.model, r.effort])).toEqual([[defaults.model, 'high'], [defaults.model, 'high']])
    expect(done.executions.filter(e => e.nodeId === 'model').every(e => e.model?.model === 'chosen-model')).toBe(true)
  })
  it('真实 Cordis 服务支持冷会话选择、宿主默认、独立启动及子工作流冻结', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('./fixtures/host-model-defaults-fixture.ts', import.meta.url).pathname], { timeout: 15_000 })
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, cases: ['host-default', 'cold-pending', 'cross-workspace-default', 'live-current-request', 'pure-without-default-services', 'nested-workflow-frozen-default'] })
  })
})
