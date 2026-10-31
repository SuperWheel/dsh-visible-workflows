import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createNativeAgentExecutor, NativeRepairExhaustedError, type NativeAgentOptions, type NativeSubagentService } from '../src/host/native-agent.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'
import type { ToolCatalog } from '../src/host/tool-catalog.ts'

// Fault injection at the documented SDK lifecycle edges. No provider/model,
// native action, network or real Desktop registry is used by these tests.
type ActivationSpec=Parameters<NonNullable<NativeSubagentService['startActivation']>>[0]
function lifecycle(options: { startupFailure?: boolean; cleanupFailure?: boolean; parentFailure?: boolean; grantFailure?: boolean; listenerFailure?: boolean; unknownUsage?: boolean; waitForDispose?: boolean; parentLateUsage?: boolean; structuredText?:string;observeStart?:(spec:ActivationSpec)=>void } = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => any>>()
  const ctx = { on(name: string, fn: (...args: any[]) => any) {
    const group = listeners.get(name) ?? new Set(); group.add(fn); listeners.set(name, group)
    return () => { group.delete(fn); if (options.listenerFailure && name === 'agent/created') throw new Error('listener removal failed') }
  } } as unknown as Pick<Context, 'on'>
  const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
  const child = { id: 'child', session: { id: 'child', header: { parentSession: 'parent' } }, ctx: {
    tools: { guard: () => () => {}, presentAs: () => () => {}, register: () => () => {}, get: () => ({}) },
    systemPrompt: { section: () => () => {} },
  } } as unknown as Agent
  const registry = new Map([['parent', parent], ['child', child]])
  const emitLifecycle = (name: string, event: Record<string, unknown>) => { for (const listener of listeners.get(name) ?? []) listener(event) }
  const activation = { id: 'child', runId: 'activation-epoch', provider: 'spawn', local: true }
  let seq = 0
  const emit = (type: string, data: unknown) => { for (const listener of listeners.get('session/event') ?? []) listener(child.session, { type, data, seq: seq++ }) }
  let finish!: (result: { stopReason: string; output: [] }) => void
  const pending = new Promise<{ stopReason: string; output: [] }>(resolve => { finish = resolve })
  const disposeChild = vi.fn(async () => {
    if (options.cleanupFailure) { emitLifecycle('subagent/end', { ...activation, stopReason: 'error' }); throw new Error('activation teardown failed') }
    if (options.waitForDispose) { emit('assistant/attempt', options.unknownUsage ? {} : { usage: { totalTokens: 17 } }); finish({ stopReason: 'cancelled', output: [] }) }
    registry.delete('child'); emitLifecycle('subagent/end', { ...activation, stopReason: options.waitForDispose ? 'cancelled' : 'completed' })
  })
  const disposeParent = vi.fn(async () => {
    if (options.parentFailure) throw new Error('owned parent teardown failed')
    if (options.parentLateUsage) { emit('assistant/attempt', { usage: { totalTokens: 19 } }); registry.delete('child'); emitLifecycle('subagent/end', { ...activation, stopReason: 'error' }) }
    registry.delete('parent')
  })
  const revoke = vi.fn(() => { if (options.grantFailure) throw new Error('bound grant revoke failed') })
  const service: NativeSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
    start: async () => { throw new Error('legacy start must not execute') },
    startActivation: vi.fn(async spec => {
      options.observeStart?.(spec)
      for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source: 'startup' })
      emitLifecycle('subagent/start', { ...activation, id: 'unrelated-child', runId: 'unrelated-epoch' })
      emitLifecycle('subagent/start', activation)
      emitLifecycle('subagent/start', { ...activation, runId: 'wrong-epoch' })
      emitLifecycle('subagent/end', { ...activation, runId: 'wrong-epoch', stopReason: 'error' })
      emit('step/start', {}); if (!options.waitForDispose) emit('assistant/message', options.unknownUsage ? {} : { usage: { totalTokens: 17 } })
      if (options.startupFailure) throw new Error('startup rejected after child publication')
      return { childId: child.id, result: options.waitForDispose ? pending : Promise.resolve({ stopReason: 'completed', structured: { text: options.structuredText??'done' }, output: [] }), dispose: disposeChild }
    }),
  }
  const catalog = { assertConstraints: () => {}, list: () => [{ id: 'builtin:test', available: true, description: 'Test bridge', inputSchema: { type: 'object' } }] } as unknown as ToolCatalog
  const executor = createNativeAgentExecutor({ ctx, subagents: () => service, parentForRun: () => undefined,
    createParent: async () => ({ agent: parent, dispose: disposeParent }) as AgentHandle,
    nativeTools: () => [], childForId: id => registry.get(id), ...(options.grantFailure ? { catalog, registerBoundTool: (() => revoke) as NativeAgentOptions['registerBoundTool'] } : {}),
  })
  const onUsage = vi.fn(), repair = vi.fn()
  const request: AdapterRequest = { node: { id: 'node', kind: 'agent', number: '1', title: 'Lifecycle', x: 0, y: 0, fixed: false, config: { model: { provider: 'offline', model: 'never-called' }, tools: options.grantFailure ? ['builtin:test'] : [], maxSteps: 2 } },
    inputs: {}, workspaceId: 'w', runId: 'run', executionId: 'node', signal: new AbortController().signal,
    backend: { generate: async () => { throw new Error('no model allowed') } }, onUsage, withRepairUsage: repair,
  }
  return { executor, request, onUsage, repair, disposeChild, disposeParent, revoke, listeners, service }
}

describe('native Agent terminal cleanup and accounting boundaries (offline)', () => {
  it('retains only the owned activation epoch and shows exact child and parent registry release', async () => {
    const f = lifecycle()
    await expect(f.executor(f.request)).resolves.toMatchObject({ text: 'done' })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'completed', lifecycle: {
      activation: { runId: 'activation-epoch', provider: 'spawn', local: true, stopReason: 'completed' },
      cleanup: 'completed', activationDisposed: true, ownedParentDisposed: true, childRegisteredAfterCleanup: false, ownedParentRegisteredAfterCleanup: false, errors: [],
    } })
    expect(f.executor.inspect('child')?.lifecycle.activation?.endedAt).toBeTruthy()
    expect(f.executor.inspect('unrelated-child')).toBeUndefined()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('fails the task inspection when a completed activation cannot dispose, retaining known usage', async () => {
    const f = lifecycle({ cleanupFailure: true })
    await expect(f.executor(f.request)).rejects.toThrow('activation teardown failed')
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', canSteer: false, usage: { totalTokens: 17 } })
    expect(f.executor.inspect('child')?.endedAt).toBeTruthy()
    expect(f.disposeChild).toHaveBeenCalledOnce(); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 17 }); expect(f.repair).not.toHaveBeenCalled()
    expect(f.executor.stop('child')).toBe(false)
    expect(f.executor.inspect('child')?.lifecycle).toMatchObject({ cleanup: 'failed', activationDisposed: false, childRegisteredAfterCleanup: true, ownedParentDisposed: true })
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('drains the exact activation and settles accounting even when revoking a bridge grant fails', async () => {
    const f = lifecycle({ grantFailure: true })
    await expect(f.executor(f.request)).rejects.toThrow('bound grant revoke failed')
    expect(f.revoke).toHaveBeenCalledOnce(); expect(f.disposeChild).toHaveBeenCalledOnce(); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 17 })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', canSteer: false })
    expect(f.repair).not.toHaveBeenCalled(); expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it.each([false, true])('retains receipts from the exact observed child if startup rejects (unknown=%s)', async unknownUsage => {
    const f = lifecycle({ startupFailure: true, unknownUsage })
    await expect(f.executor(f.request)).rejects.toThrow('startup rejected')
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith(unknownUsage ? undefined : { totalTokens: 17 })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', canSteer: false })
    expect(f.disposeParent).toHaveBeenCalledOnce(); expect(f.disposeChild).not.toHaveBeenCalled()
    expect(f.repair).not.toHaveBeenCalled(); expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('still removes peer listeners and disposes the owned parent when an unsubscriber throws', async () => {
    const f = lifecycle({ listenerFailure: true })
    await expect(f.executor(f.request)).rejects.toThrow('listener removal failed')
    expect(f.disposeChild).toHaveBeenCalledOnce(); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 17 })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', canSteer: false })
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('does not report successful completion if the owned parent cannot dispose', async () => {
    const f = lifecycle({ parentFailure: true })
    await expect(f.executor(f.request)).rejects.toThrow('owned parent teardown failed')
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', lifecycle: { cleanup: 'failed', activationDisposed: true, childRegisteredAfterCleanup: false, ownedParentDisposed: false, ownedParentRegisteredAfterCleanup: true } })
    expect(f.disposeChild).toHaveBeenCalledOnce(); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 17 })
  })
  it.each(['provider', 'model', 'schema', 'tools'] as const)('settles a pure %s preflight rejection as zero calls rather than unknown usage', async kind => {
    const f = lifecycle()
    if (kind === 'provider') f.service.getProvider = () => undefined
    if (kind === 'model') delete f.request.node.config.model
    if (kind === 'schema') f.request.node.config.outputSchema = [{ name: '__proto__', type: 'string' }]
    if (kind === 'tools') f.request.node.config.tools = ['native:run_code']
    await expect(f.executor(f.request)).rejects.toThrow()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 0 })
    expect(f.service.startActivation).not.toHaveBeenCalled(); expect(f.disposeChild).not.toHaveBeenCalled(); expect(f.disposeParent).not.toHaveBeenCalled()
  })
  it.each([false, true])('drains late SDK receipts during cancellation before settling exactly once (unknown=%s)', async unknownUsage => {
    const f = lifecycle({ waitForDispose: true, unknownUsage }), controller = new AbortController()
    f.request.signal = controller.signal; f.request.onTask = () => controller.abort(new Error('cancel after activation publication'))
    await expect(f.executor(f.request)).rejects.toThrow('cancel after activation publication')
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith(unknownUsage ? undefined : { totalTokens: 17 })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'cancelled', lifecycle: { cleanup: 'completed', activationDisposed: true, childRegisteredAfterCleanup: false, activation: { stopReason: 'cancelled' } } })
    expect(f.repair).not.toHaveBeenCalled(); expect(f.service.startActivation).toHaveBeenCalledOnce()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('preserves the original startup failure when cleanup also rejects', async () => {
    const f = lifecycle({ startupFailure: true, listenerFailure: true })
    const failure = await f.executor(f.request).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause.message).toContain('startup rejected')
    expect(failure.errors.map((error: Error) => error.message)).toEqual(['startup rejected after child publication', 'listener removal failed'])
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 17 }); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(f.executor.inspect('child')?.lifecycle.cleanup).toBe('failed')
  })
  it('keeps observers until owned-parent drain after startup rejects, retaining its late usage', async () => {
    const f = lifecycle({ startupFailure: true, parentLateUsage: true })
    await expect(f.executor(f.request)).rejects.toThrow('startup rejected')
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 36 })
    expect(f.executor.inspect('child')).toMatchObject({ status: 'failed', lifecycle: { cleanup: 'completed', childRegisteredAfterCleanup: false, ownedParentDisposed: true, activation: { stopReason: 'error' } } })
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('marks a still-registered child as unverified rather than claiming released resources', async () => {
    const f = lifecycle({ startupFailure: true })
    await expect(f.executor(f.request)).rejects.toThrow('startup rejected')
    expect(f.executor.inspect('child')?.lifecycle).toMatchObject({ cleanup: 'unverified', childRegisteredAfterCleanup: true })
  })
  it('preserves the concrete validation failure when pausing for confirmed output repair',async()=>{
    const f=lifecycle();f.request.repairMode='confirm';f.request.node.config.verification={minTextLength:60}
    const failure=await f.executor(f.request).catch(error=>error)
    expect(failure).toBeInstanceOf(NativeRepairExhaustedError);expect(failure.reason).toBe('confirmation')
    expect(failure.message).toContain('60');expect(failure.candidate).toEqual({text:'done'})
    expect(f.service.startActivation).toHaveBeenCalledOnce();expect(f.repair).not.toHaveBeenCalled()
  })
  it('supplies frozen text requirements even for a historical generic repair error without reviving the old action prompt',async()=>{
    let spec!:ActivationSpec
    const repairedText='仅根据原任务已完成的动作与既有候选补充输出说明；本次没有调用任何行动工具，没有重新写入文件，也没有执行或声称新完成任何外部操作。'
    const f=lifecycle({structuredText:repairedText,observeStart:value=>{spec=value}})
    f.request.node.config.prompt='旧配置：写入一次，然后严格返回 done';f.request.node.config.tools=['native:write'];f.request.node.config.verification={minTextLength:60}
    f.request.inputs={prompt:'原始解析输入：写入一次，然后严格返回 done'}
    f.request.outputRepair={candidate:{text:'done'},error:'原 Agent 动作已完成，输出未通过验证；请确认一次空工具修复或人工修正输出',attempt:1}
    await expect(f.executor(f.request)).resolves.toMatchObject({text:repairedText})
    const payload=JSON.parse((spec.request.prompt[0] as {text:string}).text)
    expect(payload.inputs.validationError).toContain('60')
    expect(payload.inputs.originalTask).toBe(f.request.inputs.prompt)
    expect(payload.task).toBe(payload.inputs.prompt);expect(payload.task).not.toBe(f.request.inputs.prompt);expect(payload.task).not.toBe(f.request.node.config.prompt)
    expect(payload.role).toContain('没有任何行动工具');expect(payload.boundTools).toEqual([])
    expect(spec.label).toContain('/repair/1');expect(f.service.startActivation).toHaveBeenCalledOnce();expect(f.repair).not.toHaveBeenCalled()
  })
})
