import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createNativeAgentExecutor, type NativeSubagentRun, type NativeSubagentService } from '../src/host/native-agent.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'

type Result = Awaited<NativeSubagentRun['result']>
type ActivationSpec = Parameters<NonNullable<NativeSubagentService['startActivation']>>[0]
type RetryAction = { kind: 'retry' } | undefined
interface Controls {
  emit(type: string, data: unknown): void
  step(): Promise<void>
  retry(): Promise<RetryAction>
}

// SDK-shaped, offline adaptation of dsh-runtime-audit-retry-20261020.mts.
// Pending managed activations finish only on disposal, not admission-signal abort.
function fixture(run?: (controls: Controls) => Promise<Result>) {
  const listeners = new Map<string, Set<(...args: any[]) => any>>()
  const ctx = { on(name: string, fn: (...args: any[]) => any) {
    const group = listeners.get(name) ?? new Set()
    group.add(fn); listeners.set(name, group)
    return () => group.delete(fn)
  } } as unknown as Pick<Context, 'on'>
  const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
  const cancel = vi.fn()
  const child = { id: 'child', session: { id: 'child', header: { parentSession: 'parent' } }, cancel, ctx: {
    tools: { guard: () => () => {}, presentAs: () => () => {}, get: () => ({}), register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  } } as unknown as Agent
  const registry = new Map([['child', child]])
  let sequence = 0, spec!: ActivationSpec, result!: Promise<Result>, finish!: (value: Result) => void
  const pending = new Promise<Result>(resolve => { finish = resolve })
  const emit = (type: string, data: unknown) => {
    for (const listener of listeners.get('session/event') ?? []) listener(child.session, { seq: sequence++, type, data })
  }
  const retryPolicy = vi.fn(async (): Promise<RetryAction> => ({ kind: 'retry' }))
  const controls: Controls = {
    emit,
    async step() {
      for (const listener of listeners.get('agent/pre-step') ?? []) {
        const decision = await listener({ agent: child, signal: spec.signal }, async () => ({ kind: 'enter', messages: [] }))
        if (decision.kind !== 'enter') throw new Error('step rejected')
      }
      emit('step/start', {})
    },
    async retry() {
      const chain = [...listeners.get('agent/request-error') ?? []]
      const invoke = (index: number): Promise<RetryAction> => index < chain.length
        ? chain[index]!({ agent: child, signal: spec.signal }, () => invoke(index + 1)) : retryPolicy()
      return invoke(0)
    },
  }
  const disposeChild = vi.fn(async () => {
    finish({ stopReason: 'cancelled', output: [] })
    await result
    registry.delete(child.id)
  })
  const service: NativeSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
    start: async () => { throw new Error('legacy start must not execute') },
    startActivation: vi.fn(async start => {
      spec = start
      for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source: 'startup' })
      result = run ? run(controls) : (async () => { await controls.step(); return pending })()
      return { childId: child.id, result, dispose: disposeChild }
    }),
  }
  const onUsage = vi.fn(), beforeModelStep = vi.fn()
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const request: AdapterRequest = {
    node: { id: 'node', number: '1', title: 'Offline retry', kind: 'agent', x: 0, y: 0, fixed: false,
      config: { model: { provider: 'fake', model: 'never-called' }, tools: [], maxSteps: 1 } },
    inputs: {}, workspaceId: 'w', runId: 'run', signal: new AbortController().signal,
    backend: { generate: vi.fn(async () => { throw new Error('no model calls allowed') }) },
    beforeModelStep, onUsage, onTask: () => ready(),
  }
  const executor = createNativeAgentExecutor({ ctx, subagents: () => service, parentForRun: () => parent,
    createParent: async () => { throw new Error('must reuse parent') }, nativeTools: () => [], childForId: id => registry.get(id),
  })
  return { executor, request, started, onUsage, beforeModelStep, cancel, disposeChild, retryPolicy, listeners,
    signal: () => spec.signal,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('native Agent request attempt and deadline bounds (offline)', () => {
  it.each([true, false])('bounds 1000 same-step SDK retry requests to 4 attempts and retains usage (known=%s)', async known => {
    let permittedRetries = 0, failedAttempts = 0
    const f = fixture(async ({ emit, step, retry }) => {
      await step()
      for (let index = 0; index < 1000; index++) {
        failedAttempts++
        emit('assistant/attempt', known ? { usage: { totalTokens: 1 } } : {})
        if ((await retry())?.kind !== 'retry') return { stopReason: 'failed', output: [] }
        permittedRetries++
      }
      return { stopReason: 'completed', structured: { text: 'unbounded retry bug' }, output: [] }
    })
    await expect(f.executor(f.request)).rejects.toThrow('工作流 Agent 模型请求重试达到 4 次上限（含首次请求）')
    expect(permittedRetries).toBe(3); expect(failedAttempts).toBe(4)
    expect(f.retryPolicy).toHaveBeenCalledTimes(4)
    expect(f.beforeModelStep.mock.calls).toEqual([
      [undefined, 0], ...[1, 2, 3].map(total => [known ? { totalTokens: total } : undefined, total]),
    ])
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'hook', reason: '工作流 Agent 模型请求重试达到 4 次上限（含首次请求）' })
    expect(f.signal().aborted).toBe(true)
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith(known ? { totalTokens: 4 } : undefined)
    expect(f.executor.inspect('child')).toMatchObject({ status: 'cancelled', steps: 1, lifecycle: { cleanup: 'completed' } })
    expect(f.disposeChild).toHaveBeenCalledOnce()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
    expect(f.request.backend.generate).not.toHaveBeenCalled()
  })

  it('resets the request attempt allowance for each admitted step', async () => {
    const f = fixture(async ({ emit, step, retry }) => {
      for (let index = 0; index < 2; index++) {
        await step()
        for (let attempt = 0; attempt < 3; attempt++) {
          emit('assistant/attempt', { usage: { totalTokens: 1 } })
          expect(await retry()).toEqual({ kind: 'retry' })
        }
        emit('assistant/message', { usage: { totalTokens: 1 } })
      }
      return { stopReason: 'completed', structured: { text: 'done' }, output: [] }
    })
    f.request.node.config.maxSteps = 2
    await expect(f.executor(f.request)).resolves.toMatchObject({ text: 'done', steps: 2 })
    expect(f.retryPolicy).toHaveBeenCalledTimes(6)
    expect(f.beforeModelStep).toHaveBeenCalledTimes(8)
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 8 })
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it.each([undefined, 25])('aborts and disposes a pending activation at its deadline (timeoutMs=%s)', async timeoutMs => {
    vi.useFakeTimers()
    const f = fixture(), deadline = timeoutMs ?? 30 * 60 * 1000
    if (timeoutMs !== undefined) f.request.node.config.timeoutMs = timeoutMs
    const running = f.executor(f.request)
    const rejected = expect(running).rejects.toThrow('原生 Agent 执行超时')
    await f.started
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(deadline - 1)
    expect(f.signal().aborted).toBe(false); expect(f.disposeChild).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(f.signal().aborted).toBe(true)
    expect(f.disposeChild).toHaveBeenCalledOnce()
    expect(f.onUsage).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(f.executor.inspect('child')).toMatchObject({ status: 'cancelled', lifecycle: { cleanup: 'completed' } })
    expect(vi.getTimerCount()).toBe(0)
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })

  it.each([true, false])('clears the default deadline after a settled activation (success=%s)', async success => {
    vi.useFakeTimers()
    const f = fixture(async ({ emit, step }) => {
      await step(); emit('assistant/message', { usage: { totalTokens: 1 } })
      return { stopReason: success ? 'completed' : 'failed', structured: { text: 'done' }, output: [] }
    })
    if (success) await expect(f.executor(f.request)).resolves.toMatchObject({ text: 'done' })
    else await expect(f.executor(f.request)).rejects.toThrow('原生 Agent 未完成')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(f.signal().aborted).toBe(false)
  })
})
