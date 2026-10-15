import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRuntime, type ModelRequest } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { makeWorkflow, type WorkflowNode } from '../src/shared/types.ts'

const contexts: { path: string; runtime: WorkflowRuntime }[] = []
function node(id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}): WorkflowNode {
  return { id, number: id, title: id, kind, config, x: 0, y: 0, fixed: false }
}
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.runtime.close()
    rmSync(context.path, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('Graphon process failure boundaries', () => {
  it('does not accept a late node success after the engine process fails', async () => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: (text: string) => void
    let request!: ModelRequest
    const path = mkdtempSync(join(tmpdir(), 'graphon-process-failure-'))
    const storage = new WorkflowStorage(path)
    const persist = vi.spyOn(storage, 'saveRun')
    let calls = 0
    const runtime = new WorkflowRuntime(storage, {
      generate: received => {
        if (calls++ > 0) return Promise.resolve('recovered')
        request = received
        announce()
        // A provider can finish late even when cancellation is requested.
        return new Promise<string>(resolve => { release = resolve })
      },
    })
    contexts.push({ path, runtime })
    const graph = makeWorkflow('test', '引擎异常退出', true)
    graph.nodes[1]!.kind = 'llm'
    graph.nodes[1]!.config = { model: { provider: 'test', model: 'controlled' }, prompt: '{{input.text}}' }
    const flow = storage.save(graph, 0)
    const run = runtime.start(flow.id, { text: 'test' })
    await started
    const child = (runtime as unknown as { graphon: { child: ChildProcessWithoutNullStreams } }).graphon.child
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(request.signal.aborted).toBe(true)
    const writesAtFailure = persist.mock.calls.length
    release('late result')
    await new Promise<void>(resolve => setImmediate(resolve))
    const result = await runtime.settle(run.id)
    expect(result.status).toBe('failed')
    expect(result.outputs).toEqual({})
    expect(result.executions[1]!.status).not.toBe('success')
    expect(result.executions[2]!.status).toBe('skipped')
    expect(persist.mock.calls.length).toBe(writesAtFailure)
    const recovered = await runtime.settle(runtime.start(flow.id, { text: 'restart' }).id)
    expect(recovered.status).toBe('success')
    expect(recovered.outputs.result).toBe('recovered')
  })

  it('aborts parallel child calls when the shared engine fails without a parent-child deadlock', async () => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    const requests: ModelRequest[] = []
    const path = mkdtempSync(join(tmpdir(), 'graphon-nested-failure-'))
    const storage = new WorkflowStorage(path)
    const runtime = new WorkflowRuntime(storage, { generate: request => new Promise((_resolve, reject) => {
      requests.push(request)
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      if (requests.length === 2) announce()
    }) })
    contexts.push({ path, runtime })
    const graph = makeWorkflow('test', '并行子图异常退出')
    graph.nodes = [
      node('input', 'input', { fields: [] }),
      node('iteration', 'iteration', {
        iterator: '[1,2,3,4]', parallel: true, concurrency: 2, outputVariable: 'child-llm.text',
        body: {
          nodes: [node('child-input', 'input', { fields: [] }), node('child-llm', 'llm', { model: { provider: 'test', model: 'controlled' }, prompt: '{{item}}' })],
          edges: [{ id: 'child-edge', source: 'child-input', target: 'child-llm' }],
        },
      }),
      node('output', 'output', { text: '{{iteration.result}}' }),
    ]
    graph.edges = [{ id: 'a', source: 'input', target: 'iteration' }, { id: 'b', source: 'iteration', target: 'output' }]
    const flow = storage.save(graph, 0), run = runtime.start(flow.id, {})
    await started
    const child = (runtime as unknown as { graphon: { child: ChildProcessWithoutNullStreams } }).graphon.child
    child.kill('SIGKILL')
    const result = await runtime.settle(run.id)
    expect(result.status).toBe('failed')
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.signal.aborted)).toBe(true)
    expect(result.outputs).toEqual({})
    expect(result.executions.filter(record => record.nodeId === 'child-llm').every(record => record.status === 'failed')).toBe(true)
    await runtime.close()
  })

  it('close waits for an aborted provider to finish after engine failure without late persistence', async () => {
    let announce!: () => void, release!: (text: string) => void
    const started = new Promise<void>(resolve => { announce = resolve })
    const path = mkdtempSync(join(tmpdir(), 'graphon-close-failure-'))
    const storage = new WorkflowStorage(path), persist = vi.spyOn(storage, 'saveRun')
    const runtime = new WorkflowRuntime(storage, { generate: () => { announce(); return new Promise<string>(resolve => { release = resolve }) } })
    contexts.push({ path, runtime })
    const graph = makeWorkflow('test', '关闭等待迟到模型', true)
    graph.nodes[1]!.kind = 'llm'
    graph.nodes[1]!.config = { model: { provider: 'test', model: 'controlled' }, prompt: '{{input.text}}' }
    const flow = storage.save(graph, 0), run = runtime.start(flow.id, { text: 'test' })
    await started
    const child = (runtime as unknown as { graphon: { child: ChildProcessWithoutNullStreams } }).graphon.child
    child.kill('SIGKILL')
    expect((await runtime.settle(run.id)).status).toBe('failed')
    const writesAtFailure = persist.mock.calls.length
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      expect(closed).toBe(false)
    } finally {
      release('late ignored result')
    }
    await closing
    expect(persist.mock.calls.length).toBe(writesAtFailure)
  })
})
