import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorkflow, type NodeGraph, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ExecutionAdapters, type ModelBackend } from '../src/host/runtime.ts'

// The engine is the bundled Graphon process. These callbacks are controlled,
// local test effects only; no provider, MCP, network or user file is accessed.
const noModel: ModelBackend = { generate: async () => { throw new Error('控制流测试不得调用外部模型') } }
const contexts: { path: string; runtime: WorkflowRuntime }[] = []
const modes = ['terminate', 'null', 'remove'] as const
const modesAndParallel = [false, true].flatMap(parallel => modes.map(errorMode => ({ parallel, errorMode })))
const n = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, number: id, title: id, x: 0, y: 0, fixed: false })
const edge = (source: string, target: string, port?: string) => ({ id: `${source}_${target}`, source, target, ...(port ? { port } : {}) })
const chain = (nodes: WorkflowNode[]): NodeGraph => ({ nodes, edges: nodes.slice(1).map((current, index) => edge(nodes[index]!.id, current.id)) })
const flow = (nodes: WorkflowNode[]): Workflow => ({ ...makeWorkflow('control-audit', '嵌套循环控制'), ...chain(nodes) })
const input = (id: string) => n(id, 'input', { fields: [] })
function setup(adapters?: ExecutionAdapters) {
  const path = mkdtempSync(join(tmpdir(), 'nested-loop-control-')), storage = new WorkflowStorage(path), runtime = new WorkflowRuntime(storage, noModel, adapters)
  contexts.push({ path, runtime })
  return { path, storage, runtime }
}
function iteration(body: NodeGraph, errorMode: typeof modes[number], parallel = false, iterator = '[1]') {
  return n('iterate', 'iteration', { iterator, body, outputVariable: `${body.nodes.at(-1)!.id}.text`, errorMode, parallel, concurrency: 2 })
}
function outerGraph(item: WorkflowNode, suffix: WorkflowNode[] = []) {
  return flow([input('start'), n('outer', 'loop', { maxIterations: 3, initialVariables: {}, body: chain([input('loop_input'), item]) }), ...suffix, n('result', 'output', { text: '{{outer.iterations}}' })])
}

afterEach(async () => {
  for (const context of contexts.splice(0)) { await context.runtime.close(); rmSync(context.path, { recursive: true, force: true }) }
})

describe('Graphon nested Exit Loop propagation', () => {
  it.each(modesAndParallel)('does not turn ExitLoop into an item error: parallel=$parallel errorMode=$errorMode', async ({ parallel, errorMode }) => {
    const { storage, runtime } = setup()
    const graph = storage.save(outerGraph(iteration(chain([input('item_input'), n('leave', 'exit_loop')]), errorMode, parallel)), 0)
    const done = await runtime.settle(runtime.start(graph.id, {}).id)
    expect(done.engine).toEqual({ name: 'graphon', version: '0.7.0', protocol: 1 })
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ result: '1' })
    expect(done.executions.filter(record => record.nodeId === 'leave')).toHaveLength(1)
    const container = done.executions.find(record => record.nodeId === 'iterate')!
    expect(container.error).toBeUndefined()
    expect(container.data?.errors ?? []).toEqual([])
    expect(done.executions.some(record => record.status === 'failed')).toBe(false)
  })

  it.each(modes)('aborts unfinished parallel items and preserves ExitLoop over sibling abort errors: %s', async errorMode => {
    const calls: number[] = [], aborted: number[] = [], finished: number[] = []
    let signalSecondStarted!: () => void
    const secondStarted = new Promise<void>(resolve => { signalSecondStarted = resolve })
    const adapters: ExecutionAdapters = { execute: async (_kind, request) => {
      const item = Number(request.inputs.item)
      calls.push(item)
      if (item === 1) { await secondStarted; return { text: 'first' } }
      if (item === 2) {
        signalSecondStarted()
        return new Promise((_resolve, reject) => {
          let settled = false
          const stop = () => {
            if (settled) return
            settled = true; clearTimeout(timer); aborted.push(item)
            reject(new Error('受控同伴中止：不应覆盖 ExitLoop'))
          }
          // This item must remain unfinished until the loop exit cancels it.
          // A slow Graphon startup is not a reason for it to complete normally.
          const timer = setTimeout(() => {
            if (settled) return
            settled = true; request.signal.removeEventListener('abort', stop)
            reject(new Error('退出循环后并行项在 10 秒内未收到取消'))
          }, 10_000)
          request.signal.addEventListener('abort', stop, { once: true })
          if (request.signal.aborted) stop()
        })
      }
      finished.push(item)
      return { text: `unexpected-${item}` }
    } }
    const body: NodeGraph = {
      nodes: [input('item_input'), n('effect', 'tool', { toolId: 'controlled', inputs: { item: '{{item}}' } }), n('choose', 'if', { variable: 'item', operator: 'equals', value: '1' }), n('leave', 'exit_loop'), n('keep', 'template', { text: '{{effect.text}}' })],
      edges: [edge('item_input', 'effect'), edge('effect', 'choose'), edge('choose', 'leave', 'true'), edge('choose', 'keep', 'false')],
    }
    const { storage, runtime } = setup(adapters), graph = storage.save(outerGraph(iteration(body, errorMode, true, '[1,2,3]')), 0)
    const done = await runtime.settle(runtime.start(graph.id, {}).id)
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ result: '1' })
    expect([...calls].sort()).toEqual([1, 2])
    expect(aborted).toEqual([2])
    expect(finished).toEqual([])
    expect(done.executions.some(record => record.status === 'running' || record.status === 'failed')).toBe(false)
    expect(done.executions.find(record => record.nodeId === 'iterate')?.data?.errors ?? []).toEqual([])
  })

  it('exits only the nearest loop while its outer loop continues', async () => {
    let afterInner = 0
    const adapters: ExecutionAdapters = { execute: async () => ({ text: String(++afterInner) }) }
    const nearest = n('nearest', 'loop', { maxIterations: 4, initialVariables: {}, body: chain([input('nearest_input'), iteration(chain([input('item_input'), n('leave', 'exit_loop')]), 'null', true)]) })
    const outer = n('outer', 'loop', { maxIterations: 3, initialVariables: {}, body: chain([input('outer_input'), nearest, n('after_inner', 'tool', { toolId: 'controlled' })]) })
    const { storage, runtime } = setup(adapters), graph = storage.save(flow([input('start'), outer, n('result', 'output', { text: '{{outer.iterations}}' })]), 0)
    const done = await runtime.settle(runtime.start(graph.id, {}).id)
    expect(done.status).toBe('success')
    expect(done.outputs.result).toBe('3')
    expect(afterInner).toBe(3)
    const innerRuns = done.executions.filter(record => record.nodeId === 'nearest')
    expect(innerRuns).toHaveLength(3)
    expect(innerRuns.map(record => record.data?.iterations)).toEqual([1, 1, 1])
  })

  it.each(modes)('HumanPause stays resumable and restart does not replay effects or a cached nested exit: %s', async errorMode => {
    const counts: Record<string, number> = {}
    const adapters: ExecutionAdapters = { execute: async (_kind, request) => { counts[request.node.id] = (counts[request.node.id] ?? 0) + 1; return { text: request.node.id } } }
    const body = chain([input('item_input'), n('item_effect', 'tool', { toolId: 'controlled' }), n('inside_human', 'human', { fields: [], actions: [{ id: 'go', label: '继续' }] }), n('leave', 'exit_loop')])
    const nodes = outerGraph(iteration(body, errorMode), [n('outside_human', 'human', { fields: [], actions: [{ id: 'go', label: '继续' }] })])
    nodes.nodes.splice(1, 0, n('before_effect', 'tool', { toolId: 'controlled' }))
    nodes.edges = chain(nodes.nodes).edges
    const { path, storage, runtime } = setup(adapters), graph = storage.save(nodes, 0)
    const waiting = await runtime.settle(runtime.start(graph.id, {}).id)
    expect(waiting.status).toBe('waiting')
    expect(waiting.waitingNodeId).toBe('inside_human')
    expect(counts).toEqual({ before_effect: 1, item_effect: 1 })
    const next = await runtime.settle(runtime.answer(waiting.id, { __action: 'go' }).id)
    expect(next.status).toBe('waiting')
    expect(next.waitingNodeId).toBe('outside_human')
    expect(counts).toEqual({ before_effect: 1, item_effect: 1 })
    await runtime.close()
    const reopened = new WorkflowStorage(path), resumed = new WorkflowRuntime(reopened, noModel, adapters)
    contexts.find(context => context.runtime === runtime)!.runtime = resumed
    const done = await resumed.settle(resumed.answer(next.id, { __action: 'go' }).id)
    expect(done.status).toBe('success')
    expect(done.outputs.result).toBe('1')
    expect(counts).toEqual({ before_effect: 1, item_effect: 1 })
  })

  it.each(modes)('user cancellation remains cancellation for nested parallel items: %s', async errorMode => {
    const calls: number[] = [], aborted: number[] = []
    let bothStarted!: () => void
    const started = new Promise<void>(resolve => { bothStarted = resolve })
    const adapters: ExecutionAdapters = { execute: async (_kind, request) => {
      const item = Number(request.inputs.item); calls.push(item)
      if (calls.length === 2) bothStarted()
      return new Promise((_resolve, reject) => {
        const stop = () => { aborted.push(item); reject(new Error('受控取消')) }
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stop()
      })
    } }
    const body = chain([input('item_input'), n('effect', 'tool', { toolId: 'controlled', inputs: { item: '{{item}}' } }), n('leave', 'exit_loop')])
    const { storage, runtime } = setup(adapters), graph = storage.save(outerGraph(iteration(body, errorMode, true, '[1,2,3]')), 0)
    const run = runtime.start(graph.id, {})
    await started
    const done = await runtime.cancel(run.id)
    expect(done.status).toBe('cancelled')
    expect(done.outputs).toEqual({})
    expect([...calls].sort()).toEqual([1, 2])
    expect(aborted.sort()).toEqual([1, 2])
    expect(done.executions.some(record => record.status === 'running')).toBe(false)
  })
})
