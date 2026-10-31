import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeWorkflow } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { HumanPause, WorkflowRuntime, type AdapterRequest } from '../src/host/runtime.ts'
import { createNativeAgentExecutor, NativeRepairExhaustedError, type NativeSubagentService } from '../src/host/native-agent.ts'

const resources: { runtime: WorkflowRuntime; directory: string }[] = []
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

/** Explicit SDK-shaped action fixture. The native adapter and Graphon are real;
 * this provider's model outcome/action receipt is simulated, with no external call. */
function nativeFixture() {
  const listeners = new Map<string, Set<(...args: any[]) => any>>(), started = deferred(), finish = deferred()
  const observations = { starts: 0, completedActions: 0, disposed: 0 }
  const ctx = { on(name: string, listener: (...args: any[]) => any) { const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group); return () => group.delete(listener) } } as unknown as Pick<Context, 'on'>
  const parent = { id: 'parent', session: { header: { delegationDepth: 0 } } } as unknown as Agent
  const service: NativeSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }),
    async start(_name, request) {
      const id = `native-action-${++observations.starts}`, child = { id, session: { id, header: { parentSession: parent.id } }, cancel: vi.fn(), ctx:{tools:{guard(){return()=>{}},presentAs(){return()=>{}}},systemPrompt:{section(){return()=>{}}}} } as unknown as Agent
      for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source: 'startup' })
      let seq = 0
      const emit = (type: string, data: unknown) => { for (const listener of listeners.get('session/event') ?? []) listener(child.session, { type, data, seq: seq++ }) }
      const result = (async () => {
        emit('subagent/descriptor', { label: request.label })
        for (const listener of listeners.get('agent/pre-step') ?? []) await listener({ agent: child }, async () => ({ kind: 'enter', messages: [] }))
        emit('step/start', {}); started.resolve()
        await Promise.race([finish.promise, new Promise<void>(resolve => { request.signal.addEventListener('abort', () => resolve(), { once: true }); if (request.signal.aborted) resolve() })])
        if (request.signal.aborted) return { stopReason: 'aborted', output: [] }
        observations.completedActions++
        emit('assistant/message', { usage: { totalTokens: 11 } })
        return { stopReason: 'completed', structured: { text: 'x' }, output: [] }
      })()
      return { id, localAgent: child, result, async dispose() { await result; observations.disposed++ } }
    },
  }
  const execute = createNativeAgentExecutor({ ctx, subagents: () => service, parentForRun: () => parent, createParent: async () => { throw new Error('Unexpected parent') }, nativeTools: () => [] })
  return { execute, observations, started, finish }
}

afterEach(async () => { for (const { runtime, directory } of resources.splice(0)) { await runtime.close(); rmSync(directory, { recursive: true, force: true }) } })

describe('pausing before output repair never replays the completed Agent action', () => {
  it('persists verification waiting after an in-flight pause and continues from manual output with one original action', async () => {
    const native = nativeFixture(), directory = mkdtempSync(join(tmpdir(), 'native-repair-pause-')), storage = new WorkflowStorage(directory)
    const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('No external model calls') } }, { execute: async (kind, request) => { if (kind !== 'agent') throw new Error('Unexpected adapter kind'); return native.execute(request) } })
    resources.push({ runtime, directory })
    const flow = makeWorkflow('workspace', 'Pause output repair', true), node = flow.nodes[1]!
    node.kind = 'agent'; node.config = { model: { provider: 'fake-sdk', model: 'no-model' }, tools: [], prompt: 'Explicit action fixture', maxSteps: 3, verification: { minTextLength: 5 } }
    node.config.subagentId='worker';flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
    flow.executionPolicy = { tokenBudget: 200, perTaskTokens: 40, maxRepairAttempts: 2 }
    const saved = storage.save(flow, 0), run = runtime.start(saved.id, { text: 'input' }, undefined, {repairAuthorization:{source:'agent-tool'}})
    await native.started.promise
    expect((await runtime.pause(run.id)).status).toBe('pausing')
    native.finish.resolve()
    const paused = await runtime.settle(run.id), record = paused.executions.find(item => item.nodeId === node.id)!
    expect(paused.engine?.name).toBe('graphon'); expect(paused.status).toBe('paused')
    expect(record).toMatchObject({ status: 'waiting', subagentId: 'native-action-1', repair: { waiting: true, reason: 'unavailable', candidate: { text: 'x' }, attempts: [], limit: 2 } })
    expect(record.status).not.toBe('pending')
    expect(native.observations).toEqual({ starts: 1, completedActions: 1, disposed: 1 })
    expect(paused.usage).toMatchObject({ spentTokens: 11, reservedTokens: 0, unknownCalls: 0, calls: 1, agentTasks: 1 })
    expect(() => runtime.resume(run.id)).toThrow('先处理验证暂停')
    await runtime.acceptRepairOutput(run.id, node.id, { text: 'Manually verified existing result' })
    const done = await runtime.settle(run.id)
    expect(done.status).toBe('success'); expect(done.outputs.result).toBe('Manually verified existing result')
    expect(done.usage).toEqual(paused.usage)
    expect(done.executions.find(item => item.nodeId === node.id)?.repair).toMatchObject({ waiting: false, attempts: [], candidate: { text: 'x' } })
    expect(native.observations).toEqual({ starts: 1, completedActions: 1, disposed: 1 })
  })

  it('does not turn cancellation at repair admission into a recoverable verification pause', async () => {
    const native = nativeFixture(), controller = new AbortController(), usage = vi.fn()
    const request: AdapterRequest = {
      node: { id: 'node', number: 'a-2', title: 'Action', kind: 'agent', x: 0, y: 0, fixed: false, config: { model: { provider: 'fake', model: 'none' }, tools: [], verification: { minTextLength: 5 } } },
      workspaceId: 'workspace', runId: 'run', executionId: 'node', inputs: { prompt: 'fixture' }, signal: controller.signal,
      backend: { generate: async () => { throw new Error('No model calls') } }, onUsage: usage,
      repairMode:'auto',withRepairUsage: async () => { controller.abort(new Error('cancel at repair admission')); throw new HumanPause() },
    }
    const pending = native.execute(request), rejected = expect(pending).rejects.toThrow('cancel at repair admission')
    await native.started.promise; native.finish.resolve(); await rejected
    await pending.catch(error => { expect(error).not.toBeInstanceOf(NativeRepairExhaustedError) })
    expect(native.observations.starts).toBe(1); expect(usage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 11 })
  })

  it('keeps a pause requested before first dispatch as pending without creating a native task', async () => {
    const native = nativeFixture(), directory = mkdtempSync(join(tmpdir(), 'native-before-dispatch-pause-')), storage = new WorkflowStorage(directory)
    const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('No model calls') } }, { execute: async (_kind, request) => native.execute(request) })
    resources.push({ runtime, directory })
    const flow = makeWorkflow('workspace', 'Pause before dispatch', true), node = flow.nodes[1]!
    node.kind = 'agent'; node.config = { model: { provider: 'fake', model: 'none' }, tools: [], prompt: 'fixture' }
    node.config.subagentId='worker';flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
    const saved = storage.save(flow, 0), run = runtime.start(saved.id, { text: 'input' }, undefined, {repairAuthorization:{source:'agent-tool'}})
    await runtime.pause(run.id)
    const paused = await runtime.settle(run.id)
    expect(paused.status).toBe('paused'); expect(paused.executions.find(item => item.nodeId === node.id)).toMatchObject({ status: 'pending' })
    expect(paused.executions.find(item => item.nodeId === node.id)?.repair).toBeUndefined()
    expect(native.observations.starts).toBe(0)
  })
})
