import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { cancelPlanningBackground, closePlanningBackground, interruptPlanningBackgroundEnvelope, planningBackgroundEnvelopeSchema, planningBackgroundRuntime, registerPlanningBackground, type PlanningActiveOperation, type PlanningBackgroundOwner, type PlanningBackgroundRuntime } from '../src/host/planning/background.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const parent = { id: 'parent', session: { id: 'parent' } } as unknown as Agent
  const owner: PlanningBackgroundOwner = { parent, sessionId: 'parent', workspaceId: 'workspace' }
  const live = new Map([[parent.id, parent]]), listeners = new Set<(agent: Agent) => void>(), initiators = new AsyncLocalStorage<Agent>()
  const host = new AbortController(), call = new AbortController(), active = new Map<string, PlanningActiveOperation<string>>()
  const withInitiator = vi.fn(<T>(agent: Agent, operation: () => Promise<T>) => initiators.run(agent, operation))
  const runtime: PlanningBackgroundRuntime = { isLive: agent => live.get(agent.id) === agent, withInitiator, onDisposed: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const dispose = (agent = parent) => { if (live.get(agent.id) === agent) live.delete(agent.id); for (const listener of listeners) listener(agent) }
  const register = (run: (signal: AbortSignal, externalSignal: AbortSignal) => Promise<string>, changes: Partial<Parameters<typeof registerPlanningBackground<string>>[0]> = {}) => registerPlanningBackground({ active, taskId: 'task', owner, callSignal: call.signal, hostSignal: host.signal, runtime, deadlineMs: 1000, run, ...changes })
  return { parent, owner, live, listeners, initiators, host, call, active, runtime, withInitiator, dispose, register }
}
const untilAbort = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  if (signal.aborted) reject(signal.reason)
})

afterEach(() => vi.useRealTimers())

describe('Host-owned planning background lifecycle', () => {
  it('accepts immediately, uses the service active Map and survives caller-tool signal completion', async () => {
    const f = fixture(), gate = deferred<string>(), begun = deferred<void>()
    const operation = f.register(async signal => { expect(f.initiators.getStore()).toBe(f.parent); begun.resolve(); const result = await gate.promise; expect(f.initiators.getStore()).toBe(f.parent); expect(signal.aborted).toBe(false); return result })
    expect(f.active.get('task')).toBe(operation)
    expect(f.withInitiator).not.toHaveBeenCalled()
    f.call.abort(new Error('tool returned'))
    await begun.promise
    let completed = false
    void operation.done.then(() => { completed = true })
    await Promise.resolve(); expect(completed).toBe(false)
    gate.resolve('candidate')
    await expect(operation.done).resolves.toBe('candidate')
    expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('deduplicates active same-task admission and rejects a changed owner without cancelling the original', async () => {
    const f = fixture(), gate = deferred<string>(), run = vi.fn(async () => gate.promise)
    const first = f.register(run), duplicate = f.register(async () => 'duplicate')
    expect(duplicate).toBe(first)
    expect(() => f.register(run, { owner: { ...f.owner, workspaceId: 'other' } })).toThrow('归属')
    expect(() => f.register(run, { owner: { ...f.owner, parent: { ...f.parent } as Agent } })).toThrow('归属')
    await Promise.resolve(); expect(run).toHaveBeenCalledOnce()
    gate.resolve('one'); await first.done
  })

  it('cancels before dispatch without starting generation and preserves a terminal callback under the same identity', async () => {
    const f = fixture(), run = vi.fn(async () => 'unexpected'), onFailure = vi.fn((_error, signal: AbortSignal) => signal.aborted ? 'cancelled' : 'failed')
    const operation = f.register(run, { onFailure })
    const cancellation = cancelPlanningBackground(f.active, 'task', f.owner)
    await expect(cancellation).resolves.toBe('cancelled')
    await expect(operation.done).resolves.toBe('cancelled')
    expect(run).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce()
    expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('requires exact workspace and parent ownership for cancellation', async () => {
    const f = fixture(), gate = deferred<string>(), operation = f.register(async () => gate.promise)
    await expect(cancelPlanningBackground(f.active, 'task', { ...f.owner, workspaceId: 'other' })).rejects.toThrow('归属')
    expect(operation.controller.signal.aborted).toBe(false)
    gate.resolve('done'); await operation.done
  })

  it('ignores other Agent disposal and cancels when the exact initiating parent is disposed', async () => {
    const f = fixture(), begun = deferred<void>()
    const operation = f.register(async signal => { begun.resolve(); return untilAbort(signal) })
    await begun.promise
    f.dispose({ ...f.parent } as Agent)
    expect(operation.controller.signal.aborted).toBe(false); expect(f.active.has('task')).toBe(true)
    f.dispose()
    await expect(operation.done).rejects.toMatchObject({ code: 'PLANNING_PARENT_DISPOSED' })
    expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('rejects replaced/dead parents and closes the subscribe-versus-dispose race', async () => {
    const f = fixture(), run = vi.fn(async () => 'unexpected')
    f.live.set(f.parent.id, { ...f.parent } as Agent)
    expect(() => f.register(run)).toThrow('主对话 Agent 已关闭')
    f.live.set(f.parent.id, f.parent)
    const runtime = { ...f.runtime, onDisposed: (listener: (agent: Agent) => void) => { const off = f.runtime.onDisposed(listener); f.live.delete(f.parent.id); return off } }
    const operation = f.register(run, { runtime })
    await expect(operation.done).rejects.toMatchObject({ code: 'PLANNING_PARENT_DISPOSED' })
    expect(run).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0)
  })

  it('rechecks parent liveness after acceptance and before the tracked SDK boundary', async () => {
    const f = fixture(), run = vi.fn(async () => 'unexpected'), operation = f.register(run)
    f.live.delete(f.parent.id) // Simulate registry replacement without delivery of a disposed observer.
    await expect(operation.done).rejects.toMatchObject({ code: 'PLANNING_PARENT_DISPOSED' })
    expect(f.withInitiator).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled()
  })

  it('retains the deadline failure code while excluding the internal deadline from the external signal', async () => {
    vi.useFakeTimers()
    const f = fixture(), begun = deferred<void>()
    let external!: AbortSignal
    const operation = f.register(async (signal, outer) => { external = outer; begun.resolve(); return untilAbort(signal) })
    const rejected = expect(operation.done).rejects.toMatchObject({ code: 'PLANNING_DEADLINE_EXCEEDED' })
    await begun.promise
    await vi.advanceTimersByTimeAsync(1000); await rejected
    expect(external.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0)
    expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('Host shutdown aborts work and close drains real child cleanup before releasing the active task', async () => {
    const f = fixture(), begun = deferred<void>(), cleanup = deferred<string>(), aborted = deferred<void>()
    const operation = f.register(async signal => { begun.resolve(); await untilAbort(signal).catch(() => { aborted.resolve() }); return cleanup.promise })
    await begun.promise
    f.host.abort(new Error('Host closed'))
    let closed = false
    const closing = closePlanningBackground(f.active).then(() => { closed = true })
    await aborted.promise
    expect(closed).toBe(false); expect(f.active.get('task')).toBe(operation)
    expect(() => f.register(async () => 'unexpected', { taskId: 'new-task' })).toThrow('Host closed')
    cleanup.resolve('interrupted'); await closing
    expect(closed).toBe(true); expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('does not remove a replacement active entry when the previous operation settles', async () => {
    const f = fixture(), gate = deferred<string>(), operation = f.register(async () => gate.promise)
    const replacement = { controller: new AbortController(), done: Promise.resolve('replacement') }
    f.active.set('task', replacement)
    gate.resolve('previous'); await operation.done
    expect(f.active.get('task')).toBe(replacement); expect(f.listeners.size).toBe(0)
  })

  it('turns SDK setup errors into persisted terminal state, cleans listeners and contains detached rejection', async () => {
    const f = fixture(), run = vi.fn(async () => 'unexpected')
    const operation = f.register(run, { runtime: { ...f.runtime, withInitiator: () => { throw new Error('initiator closing') } }, onFailure: error => error instanceof Error ? error.message : 'failed' })
    await expect(operation.done).resolves.toBe('initiator closing')
    expect(run).not.toHaveBeenCalled(); expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0)
  })

  it('rejects invalid acceptance before creating any timer, subscription or active work', () => {
    vi.useFakeTimers()
    const f = fixture()
    for (const deadlineMs of [0, NaN, 2 ** 31]) expect(() => f.register(async () => 'unexpected', { deadlineMs })).toThrow('时长')
    f.call.abort(new Error('not admitted'))
    expect(() => f.register(async () => 'unexpected')).toThrow('not admitted')
    expect(f.active.size).toBe(0); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('SDK adapter resolves exact live identity and receives only public lifecycle payloads', () => {
    const f = fixture(), on = vi.fn((_name, listener) => { listener({ agent: f.parent }); return () => {} })
    const runtime = planningBackgroundRuntime({ on } as unknown as Pick<Context, 'on'>, { get: id => f.live.get(id), withInitiator: f.withInitiator } as unknown as Pick<AgentRegistry, 'get' | 'withInitiator'>)
    expect(runtime.isLive(f.parent)).toBe(true); expect(runtime.isLive({ ...f.parent } as Agent)).toBe(false)
    const observed = vi.fn(); runtime.onDisposed(observed)
    expect(on).toHaveBeenCalledWith('agent/disposed', expect.any(Function)); expect(observed).toHaveBeenCalledWith(f.parent)
  })

  it('uses the installed SDK tracked initiator across the complete returned Promise without models', async () => {
    const ctx = new Context(), registry = new AgentRegistry(ctx), parent = fixture().parent, gate = deferred<void>()
    const run = registry.withInitiator(parent, async () => {
      expect(registry.currentInitiator()).toBe(parent)
      await gate.promise
      expect(registry.currentInitiator()).toBe(parent)
      return 'settled'
    })
    expect(registry.currentInitiator()).toBeUndefined()
    gate.resolve(); await expect(run).resolves.toBe('settled')
  })
})

describe('compact background restart envelope', () => {
  const accepted = { protocolVersion: 1, taskId: 'same-task', requestId: 'same-request', requestDigest: 'a'.repeat(64), sessionId: 'parent', workspaceId: 'workspace', acceptedAt: '2026-10-19T12:00:00.000Z', state: 'accepted' }
  it('marks the same identity interrupted without starting work or changing its original acceptance time', () => {
    const interrupted = interruptPlanningBackgroundEnvelope(accepted, '2026-10-19T12:01:00.000Z')
    expect(interrupted).toEqual({ ...accepted, state: 'interrupted', interruptedAt: '2026-10-19T12:01:00.000Z' })
    expect(interruptPlanningBackgroundEnvelope(interrupted, '2026-10-19T12:02:00.000Z')).toEqual(interrupted)
  })
  it('rejects full preview history, private source material and invalid state timestamps', () => {
    for (const field of ['request', 'source', 'history', 'context', 'prompt']) expect(planningBackgroundEnvelopeSchema.safeParse({ ...accepted, [field]: 'private' }).success).toBe(false)
    expect(planningBackgroundEnvelopeSchema.safeParse({ ...accepted, state: 'interrupted' }).success).toBe(false)
    expect(planningBackgroundEnvelopeSchema.safeParse({ ...accepted, interruptedAt: '2026-10-19T12:01:00.000Z' }).success).toBe(false)
  })
})
