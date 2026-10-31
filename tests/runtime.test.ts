import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelBackend, type ModelRequest } from '../src/host/runtime.ts'
import { assertGraph, parseWorkflow } from '../src/host/validation.ts'

const contexts: { path: string; runtime: WorkflowRuntime }[] = []
const noModel: ModelBackend = { generate: async () => { throw new Error('此确定性测试不得调用模型') } }
function setup(backend: ModelBackend = noModel) {
  const path = mkdtempSync(join(tmpdir(), 'dsh-workflow-runtime-test-'))
  const storage = new WorkflowStorage(path), runtime = new WorkflowRuntime(storage, backend)
  contexts.push({ path, runtime }); return { path, storage, runtime }
}
function node(id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode {
  return { id, number: id, kind, config, title: id, x: 0, y: 0, fixed: false }
}
function branchFlow(): Workflow {
  const flow = makeWorkflow('workspace-test', '分支测试')
  flow.nodes = [node('input', 'input', { fields: [{ name: 'text', label: '文本', required: true }] }), node('condition', 'if', { variable: 'input.text', operator: 'contains', value: 'yes' }), node('yes', 'output', { text: 'yes={{input.text}}', outputName: 'yes' }), node('no', 'output', { text: 'no={{input.text}}', outputName: 'no' })]
  flow.edges = [{ id: 'entry', source: 'input', target: 'condition' }, { id: 'true-edge', source: 'condition', target: 'yes', port: 'true' }, { id: 'false-edge', source: 'condition', target: 'no', port: 'false' }]
  return flow
}
afterEach(async () => { for (const context of contexts.splice(0)) { await context.runtime.close(); rmSync(context.path, { recursive: true, force: true }) } })

describe('独立图运行器（确定性实际执行，无真实模型请求）', () => {
  it('执行模板并保留结果，重开存储仍可读取', async () => {
    const { storage, runtime, path } = setup()
    const flow = storage.save(makeWorkflow('workspace-test', '模板测试', true), 0)
    const run = runtime.start(flow.id, { text: '保留实际输入' })
    const result = await runtime.settle(run.id)
    expect(result.status).toBe('success'); expect(result.outputs).toEqual({ result: '处理结果\n\n保留实际输入' })
    expect(result.executions.every(e => e.status === 'success')).toBe(true)
    await runtime.close()
    const reopened = new WorkflowStorage(path)
    expect(reopened.run(run.id).outputs).toEqual(result.outputs)
    expect(statSync(join(path, 'library.json')).mode & 0o777).toBe(0o600)
    reopened.close()
  })
  it('缺失输入只等待，同一次运行回答后执行且不能重复提交', async () => {
    const { storage, runtime } = setup()
    const flow = storage.save(makeWorkflow('workspace-test', '输入测试', true), 0)
    const waiting = runtime.start(flow.id, {})
    expect(waiting.status).toBe('waiting'); expect(waiting.executions.every(e => e.status === 'pending')).toBe(true)
    expect(waiting.missingFields?.map(f => f.name)).toEqual(['text'])
    expect(runtime.answer(waiting.id, { text: '用户回答' }).id).toBe(waiting.id)
    expect((await runtime.settle(waiting.id)).outputs.result).toContain('用户回答')
    expect(() => runtime.answer(waiting.id, { text: '重复回答' })).toThrow('不再等待')
  })
  it('姓名问答按稳定节点引用映射到模板局部变量，再沿 Graphon 输出结果', async () => {
    const { storage, runtime } = setup(), graph = makeWorkflow('workspace-test', '姓名问候')
    const inputId = '65001be3-c022-4327-aa9f-8a97f78cdb82', templateId = 'd38d1203-23a4-4241-89b4-0e114f9eb174'
    graph.nodes = [node(inputId, 'input', { fields: [{ name: 'name', label: '姓名', required: true, type: 'text' }] }), node(templateId, 'template', { inputs: { name: `{{${inputId}.name}}` }, text: '你好，{{name}}，欢迎使用工作流！祝你愉快！' }), node('result', 'output', { text: `{{${templateId}.text}}`, outputName: 'result' })]
    graph.edges = [{ id: 'input-template', source: inputId, target: templateId }, { id: 'template-result', source: templateId, target: 'result' }]
    const saved = storage.save(graph, 0), waiting = runtime.start(saved.id, {})
    expect(waiting.status).toBe('waiting')
    runtime.answer(waiting.id, { name: '小明' })
    const result = await runtime.settle(waiting.id)
    expect(result.status).toBe('success')
    expect(result.executions[0]!.data?.name).toBe('小明')
    expect(result.outputs).toEqual({ result: '你好，小明，欢迎使用工作流！祝你愉快！' })
  })
  it.each(['yes please', 'no'])('条件路径 %s 仅执行被选中支路', async text => {
    const { storage, runtime } = setup(), flow = storage.save(branchFlow(), 0)
    const result = await runtime.settle(runtime.start(flow.id, { text }).id)
    expect(result.status).toBe('success')
    const chosen = text.includes('yes') ? 'yes' : 'no', other = chosen === 'yes' ? 'no' : 'yes'
    expect(result.outputs).toEqual({ [chosen]: `${chosen}=${text}` })
    expect(result.executions.find(e => e.nodeId === other)?.status).toBe('skipped')
  })
  it('条件分支汇合等待拓扑依赖，跳过支路不会阻断汇合', async () => {
    const { storage, runtime } = setup(), graph = branchFlow()
    graph.nodes.find(n => n.id === 'yes')!.kind = 'template'; graph.nodes.find(n => n.id === 'yes')!.config = { text: 'yes' }
    graph.nodes.find(n => n.id === 'no')!.kind = 'template'; graph.nodes.find(n => n.id === 'no')!.config = { text: 'no' }
    graph.nodes.push(node('join', 'output', { text: '收到 {{input.text}}', outputName: 'result' }))
    graph.edges.push({ id: 'join-y', source: 'yes', target: 'join' }, { id: 'join-n', source: 'no', target: 'join' })
    const saved = storage.save(graph, 0), result = await runtime.settle(runtime.start(saved.id, { text: 'no' }).id)
    expect(result.outputs).toEqual({ result: '收到 no' }); expect(result.executions.find(e => e.nodeId === 'join')?.status).toBe('success')
  })
  it('引用稳定节点身份，显示编号改变不破坏执行', async () => {
    const { storage, runtime } = setup(), graph = makeWorkflow('workspace-test', '身份测试', true)
    graph.nodes[1]!.number = 'b-92'
    const saved = storage.save(graph, 0), result = await runtime.settle(runtime.start(saved.id, { text: '仍可引用' }).id)
    expect(result.outputs.result).toBe('处理结果\n\n仍可引用')
  })
  it('无效变量明确失败，不会显示虚构成功结果', async () => {
    const { storage, runtime } = setup(), graph = makeWorkflow('workspace-test', '失败测试', true)
    graph.nodes[1]!.config.text = '{{missing-node.text}}'
    const saved = storage.save(graph, 0), result = await runtime.settle(runtime.start(saved.id, { text: '内容' }).id)
    expect(result.status).toBe('failed'); expect(result.error).toContain('不存在'); expect(result.outputs).toEqual({})
    expect(result.executions[1]!.status).toBe('failed'); expect(result.executions[2]!.status).toBe('skipped')
  })
  it('不支持的节点、循环和错误条件出口无法进入执行', () => {
    const { storage } = setup(), flow = makeWorkflow('workspace-test', '校验', true)
    expect(() => parseWorkflow({ ...flow, nodes: [{ ...flow.nodes[0], kind: 'shell' }] })).toThrow()
    const cycle = structuredClone(flow); cycle.edges.push({ id: 'cycle', source: cycle.nodes[2]!.id, target: cycle.nodes[1]!.id })
    expect(() => storage.save(cycle, 0)).toThrow('循环')
    const branch = branchFlow(); branch.edges[1]!.port = 'default'
    expect(() => assertGraph(branch, true)).toThrow('true 或 false')
  })
  it('拒绝未声明的输入字段', () => {
    const { storage, runtime } = setup(), flow = storage.save(makeWorkflow('workspace-test'), 0)
    expect(() => runtime.start(flow.id, { text: '内容', arbitrary: '额外字段' })).toThrow('未声明')
  })
  it('取消运行等待模型后端停止，后续节点不会执行', async () => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let stopped = false
    const backend: ModelBackend = { generate: request => new Promise((_resolve, reject) => {
      announce(); request.signal.addEventListener('abort', () => { stopped = true; reject(new Error('测试模型已停止')) }, { once: true })
    }) }
    const { storage, runtime } = setup(backend), graph = makeWorkflow('workspace-test', '取消测试', true)
    graph.nodes[1]!.kind = 'llm'; graph.nodes[1]!.config = { model: { provider: 'test-double', model: 'mock' }, prompt: '{{input.text}}' }
    const flow = storage.save(graph, 0), run = runtime.start(flow.id, { text: '取消' })
    await started
    const result = await runtime.cancel(run.id)
    expect(stopped).toBe(true); expect(result.status).toBe('cancelled'); expect(result.outputs).toEqual({})
    expect(result.executions[2]!.status).toBe('cancelled')
  })
  it('预设统一更新只影响未来运行，已启动请求保留准确提示词快照', async () => {
    const requests: ModelRequest[] = []
    const { storage, runtime } = setup({ generate: async request => { requests.push(request); return request.system } })
    const role = { id: 'reviewer', name: '审核人', prompt: '旧角色', revision: 0 }
    storage.savePreset(role)
    const graph = makeWorkflow('workspace-test', '角色快照', true)
    graph.nodes[1]!.kind = 'llm'; graph.nodes[1]!.config = { model: { provider: 'test-double', model: 'mock' }, prompt: '{{input.text}}', rolePresetId: role.id }
    const flow = storage.save(graph, 0)
    const first = runtime.start(flow.id, { text: '材料一' })
    storage.savePreset({ ...role, prompt: '新角色', revision: 1 })
    const firstDone = await runtime.settle(first.id)
    expect(firstDone.outputs.result).toBe('旧角色')
    expect(firstDone.executions[1]!.input).toBe('材料一'); expect(firstDone.executions[1]!.rolePrompt).toBe('旧角色')
    expect((await runtime.settle(runtime.start(flow.id, { text: '材料二' }).id)).outputs.result).toBe('新角色')
    expect(requests.map(r => r.system)).toEqual(['旧角色', '新角色'])
  })
})

describe('版本、固定节点与持久恢复', () => {
  it('乐观锁拒绝过期覆盖，用户编辑固定节点可保存', () => {
    const { storage } = setup(), graph = makeWorkflow('workspace-test', '版本测试', true)
    graph.nodes[1]!.fixed = true
    const first = storage.save(graph, 0), second = storage.save({ ...first, title: '新标题' }, 1)
    expect(() => storage.save({ ...first, title: '旧版本覆盖' }, 1)).toThrow('已被修改')
    expect(storage.get(first.id).title).toBe('新标题')
    second.nodes[1]!.config.text = '用户指定修改'
    expect(storage.save(second, 2, 'user').nodes[1]!.config.text).toBe('用户指定修改')
  })
  it('Agent 不能修改或绕过固定节点，移动位置仍允许', () => {
    const { storage } = setup(), graph = makeWorkflow('workspace-test', '固定测试', true)
    graph.nodes[1]!.fixed = true; const saved = storage.save(graph, 0)
    const edit = structuredClone(saved); edit.nodes[1]!.config.text = 'agent 改写'
    expect(() => storage.save(edit, 1, 'agent')).toThrow('已固定')
    const bypass = structuredClone(saved); bypass.edges.push({ id: 'bypass', source: saved.nodes[0]!.id, target: saved.nodes[2]!.id })
    expect(() => storage.save(bypass, 1, 'agent')).toThrow('绕过固定节点')
    const moved = structuredClone(saved); moved.nodes[1]!.x += 50
    expect(storage.save(moved, 1, 'agent').revision).toBe(2)
  })
  it('运行时保存为未来版本，活动运行的图快照保持不变', async () => {
    const { storage, runtime } = setup(), flow = storage.save(makeWorkflow('workspace-test'), 0)
    const run = runtime.start(flow.id, {})
    expect(storage.save({ ...flow, title: '运行中修改' }, 1).revision).toBe(2)
    expect(storage.run(run.id).graph.title).toBe(flow.title)
    expect(() => runtime.start(flow.id, {})).toThrow('未结束的运行')
    await runtime.cancel(run.id)
    expect(storage.save({ ...flow, title: '取消后修改' }, 2).revision).toBe(3)
  })
  it('库快照按最新运行排序，卡片不会显示旧的成功覆盖新的失败', async () => {
    const { storage, runtime } = setup(), flow = storage.save(makeWorkflow('workspace-test', '最新运行', true), 0)
    const first = await runtime.settle(runtime.start(flow.id, { text: '第一次' }).id)
    const nextGraph = storage.get(flow.id); nextGraph.nodes[1]!.config.text = '{{missing.text}}'; storage.save(nextGraph, flow.revision)
    const second = await runtime.settle(runtime.start(flow.id, { text: '第二次' }).id)
    expect(storage.runs()[0]!.id).toBe(second.id); expect(storage.runs()[0]!.status).toBe('failed')
    expect(storage.runs()[1]!.id).toBe(first.id)
  })
  it('中断恢复不会自动重放模型节点或覆盖历史结果', async () => {
    const { storage, runtime, path } = setup(), flow = storage.save(makeWorkflow('workspace-test'), 0)
    const interrupted = runtime.start(flow.id, {})
    interrupted.status = 'running'; interrupted.executions[0]!.status = 'running'; storage.saveRun(interrupted)
    await runtime.close()
    const reopened = new WorkflowStorage(path)
    expect(reopened.run(interrupted.id).status).toBe('interrupted')
    expect(reopened.run(interrupted.id).error).toContain('未自动重放')
    expect(JSON.parse(readFileSync(join(path, 'runs', `${interrupted.id}.json`), 'utf8')).status).toBe('interrupted')
    reopened.close()
  })
})
