import { PlanningStore } from '../src/host/planning/store.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createTrialAgent, type TrialAgentInput, type TrialAgentResult } from '../src/host/planning/trial-agent.ts'
import { WorkflowTrialService, type PlanningTrial, type TrialRequest } from '../src/host/planning/trial-service.ts'
import type { PlanningCaller, PlanningTask } from '../src/host/planning/service.ts'
import type { PlanningSubagentService } from '../src/host/planning/agent.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const untilAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  if (signal.aborted) reject(signal.reason)
})
const request = (): TrialRequest => ({
  requestId: 'audit-request', instruction: '先完成问候产物，再提炼流程',
  spec: {
    task: '读取 source.json 的姓名，生成 result.json 问候', tools: ['read_file', 'write_file'], inputs: ['source.json'],
    artifacts: [{ path: 'result.json', format: 'json', requireChanged: true, checks: [{ kind: 'json-equals', pointer: '/text', value: 'Hello Ada' }] }],
    reviewItems: ['人工确认语气'],
  },
})
const result = (input: TrialAgentInput, changes: Partial<TrialAgentResult> = {}): TrialAgentResult => ({
  childId: input.childId, stopReason: 'completed', outcome: 'needs-input', summary: '等待确认', questions: ['请确认用途'],
  events: [], steps: 1, usage: { totalTokens: 42 }, evidenceIncomplete: false, ...changes,
})
type Options = ConstructorParameters<typeof WorkflowTrialService>[0]
function fixture(run?: (input: TrialAgentInput) => Promise<TrialAgentResult>) {
  const directory = mkdtempSync(join(tmpdir(), 'trial-audit-')), workspace = join(directory, 'workspace')
  mkdirSync(workspace); writeFileSync(join(workspace, 'source.json'), '{"name":"Ada"}')
  const parent = { id: 'root', session: { id: 'root' } } as Agent
  const caller: PlanningCaller = { parent, sessionId: parent.id, workspaceId: 'workspace', signal: new AbortController().signal }
  const actions = vi.fn(() => writeFileSync(join(workspace, 'result.json'), '{"text":"Hello Ada"}'))
  const driver = {
    run: vi.fn(async (input: TrialAgentInput) => {
      input.onPrepared?.({ toolDigest: 'b'.repeat(64), tools: input.tools })
      input.onStep?.()
      if (run) return run(input)
      input.onEvent?.({ seq: 0, type: 'turn/start', turn: 1 })
      input.onEvent?.({ seq: 1, type: 'tool/call', turn: 1, callId: 'write-1', toolName: 'write_file', text: '{"path":"result.json"}', truncated: false })
      actions()
      input.onEvent?.({ seq: 2, type: 'tool/result', turn: 1, callId: 'write-1', text: '{"written":true}', truncated: false, isError: false })
      input.onEvent?.({ seq: 3, type: 'turn/end', turn: 1, completed: true })
      return result(input, { outcome: 'completed', summary: '产物已生成', questions: [] })
    }),
    close: vi.fn(async () => {}),
  }
  const plan = vi.fn<Options['plan']>(async () => ({ id: 'planned-task', state: 'ready' }) as PlanningTask)
  const options: Options = {
    directory, driver, admission: new ModelAdmission(1, 1), plan,
    resolve: async () => ({ workspaceRoot: workspace, model: { provider: 'offline', model: 'fixture' }, policyDigest: 'a'.repeat(64) }),
    authorize: vi.fn(),
  }
  const services: WorkflowTrialService[] = []
  const reopen = () => { const service = new WorkflowTrialService(options); services.push(service); return service }
  const service = reopen()
  const stored = (): PlanningTrial => new PlanningStore<PlanningTrial>(join(directory,'trials')).read(value=>value as PlanningTrial)[0]!
  cleanups.push(async () => {
    await Promise.all(services.map(service => service.close()))
    rmSync(directory, { recursive: true, force: true })
  })
  return { service, caller, driver, actions, plan, reopen, stored, directory }
}

describe('trial audit: durable per-call usage', () => {
  it.each(['cancel', 'timeout', 'error'] as const)('persists known and unknown receipts before %s and keeps them after reload without replay', async mode => {
    if (mode === 'timeout') vi.useFakeTimers()
    const entered = deferred<TrialAgentInput>()
    const f = fixture(async input => {
      input.onUsage?.({ seq: 5, totalTokens: 17 })
      input.onUsage?.({ seq: 6, totalTokens: undefined })
      // The sink is synchronous: receipts must already be durable before run settles.
      expect(f.stored()).toMatchObject({ state: 'executing', spentTokens: 17, unknownUsageCalls: 1 })
      entered.resolve(input)
      if (mode === 'error') throw new Error('driver failed after reporting usage')
      try { return await untilAbort(input.signal) }
      finally {
        // Usage emitted during actual driver cleanup must survive cancellation too.
        input.onUsage?.({ seq: 7, totalTokens: 3 })
      }
    })
    const work = f.service.start(request(), f.caller), input = await entered.promise
    if (mode === 'cancel') await f.service.cancel(input.trialId, f.caller)
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1_200_000)
    const stopped = await work, spentTokens = mode === 'error' ? 17 : 20
    expect(stopped).toMatchObject({ state: mode === 'cancel' ? 'cancelled' : 'failed', spentTokens, unknownUsageCalls: 1 })
    expect(f.stored()).toEqual(stopped)
    const restored = f.reopen()
    expect(restored.get(stopped.id, f.caller)).toEqual(stopped)
    expect(await restored.start(request(), f.caller)).toEqual(stopped)
    expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.plan).not.toHaveBeenCalled()
  })

  it('deduplicates known and unknown seq receipts and ignores the returned aggregate', async () => {
    const f = fixture(async input => {
      input.onUsage?.({ seq: 1, totalTokens: 12 })
      input.onUsage?.({ seq: 1, totalTokens: 12 })
      input.onUsage?.({ seq: 2, totalTokens: undefined })
      input.onUsage?.({ seq: 2, totalTokens: undefined })
      input.onUsage?.({ seq: 3, totalTokens: 8 })
      return result(input, { usage: { totalTokens: 999 } })
    })
    const trial = await f.service.start(request(), f.caller)
    expect(trial).toMatchObject({ spentTokens: 20, unknownUsageCalls: 1 })
    expect(f.stored()).toEqual(trial)
    expect(f.reopen().get(trial.id, f.caller)).toEqual(trial)
  })

  it('keeps all-unknown usage absent even when the returned aggregate claims tokens', async () => {
    const f = fixture(async input => {
      input.onUsage?.({ seq: 1, totalTokens: undefined })
      input.onUsage?.({ seq: 2, totalTokens: undefined })
      return result(input)
    })
    const trial = await f.service.start(request(), f.caller)
    expect(trial.unknownUsageCalls).toBe(2); expect(trial.spentTokens).toBeUndefined()
    expect(f.stored()).not.toHaveProperty('spentTokens')
    expect(f.reopen().get(trial.id, f.caller).unknownUsageCalls).toBe(2)
  })

  it('retains aggregate-only legacy drivers and loads records without unknownUsageCalls', async () => {
    const f = fixture(async input => result(input))
    const trial = await f.service.start(request(), f.caller)
    expect(trial.spentTokens).toBe(42); expect(trial.unknownUsageCalls).toBeUndefined()
    expect(f.stored()).not.toHaveProperty('unknownUsageCalls')
    expect(f.reopen().get(trial.id, f.caller)).toEqual(trial)
  })
})

describe('trial audit: cancel parked trials', () => {
  it.each(['needs_input', 'interrupted'] as const)('cancels resting %s without starting another child', async state => {
    const f = fixture(async input => result(input))
    let waiting = await f.service.start(request(), f.caller)
    if (state === 'interrupted') {
      // Model a durable in-flight snapshot recovered after process loss.
      const snapshot = { ...waiting, state: 'executing' }
      writeFileSync(join(f.directory, 'trials', 'planning', 'tasks.json'), JSON.stringify({ version: 1, tasks: [snapshot] }))
      waiting = f.reopen().get(waiting.id, f.caller)
    }
    expect(waiting.state).toBe(state)
    const restored = f.reopen(), cancelled = await restored.cancel(waiting.id, f.caller)
    expect(cancelled).toMatchObject({ state: 'cancelled', revision: waiting.revision + 1 })
    expect(f.reopen().get(waiting.id, f.caller)).toEqual(cancelled)
    expect(await restored.cancel(waiting.id, f.caller)).toEqual(cancelled)
    expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.plan).not.toHaveBeenCalled()
  })

  it.each(['ready', 'failed'] as const)('leaves final %s unchanged', async state => {
    const f = fixture(state === 'failed' ? async () => { throw new Error('failed') } : undefined)
    const req = request(); req.spec.reviewItems = []
    const final = await f.service.start(req, f.caller)
    expect(final.state).toBe(state)
    expect(await f.service.cancel(final.id, f.caller)).toEqual(final)
    expect(f.stored()).toEqual(final)
  })
})

describe('trial audit: native session usage receipt delivery', () => {
  it('synchronously emits message and failed-attempt usage once per child event seq, including unknown usage', async () => {
    const listeners = new Map<string, Set<(...args: any[]) => any>>()
    const ctx = { on(name: string, listener: (...args: any[]) => any) {
      const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group)
      return () => group.delete(listener)
    } } as unknown as Pick<Context, 'on'>
    const schema = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
    const parent = { id: 'root', session: { header: { delegationDepth: 0 } }, ctx: { tools: {
      schemas: () => [schema('read_file')], get: () => ({}),
    } } } as unknown as Agent
    let child: Agent | undefined
    const onUsage = vi.fn(), runBusiness = vi.fn(), dispose = vi.fn(async () => {})
    const service: PlanningSubagentService = {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      async startActivation(spec) {
        child = { id: spec.childId, session: { id: spec.childId, seq: 0, inheritedEventCount: 0, firstLiveSeq: 0, firstLifecycleSeq: 0, header: { parentSession: parent.id, isSeeded: false } },
          cancel: vi.fn(), ctx: { tools: { schemas: () => [schema('read_file'), schema('structured_output')], get: () => ({}), guard: vi.fn(), presentAs: vi.fn() }, systemPrompt: { section: vi.fn() } },
        } as unknown as Agent
        for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source: 'startup' })
        const emit = (seq: number, type: string, data: unknown, session = child!.session) => {
          for (const listener of listeners.get('session/event') ?? []) listener(session, { seq, type, data })
        }
        runBusiness()
        emit(0, 'assistant/message', { usage: { totalTokens: 900 } }, { id: 'unrelated' } as Agent['session'])
        expect(onUsage).not.toHaveBeenCalled()
        emit(0, 'assistant/message', { turn: 1, usage: { totalTokens: 12 }, message: { content: [{ type: 'text', text: '完成' }] } })
        expect(onUsage.mock.calls).toEqual([[{ seq: 0, totalTokens: 12 }]])
        emit(0, 'assistant/message', { usage: { totalTokens: 12 } })
        emit(1, 'assistant/attempt', { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { totalTokens: 8 } } }] })
        emit(2, 'assistant/attempt', {})
        emit(2, 'assistant/attempt', {})
        emit(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '用量未知' }] } })
        expect(onUsage.mock.calls).toEqual([
          [{ seq: 0, totalTokens: 12 }], [{ seq: 1, totalTokens: 8 }],
          [{ seq: 2, totalTokens: undefined }], [{ seq: 3, totalTokens: undefined }],
        ])
        return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed', structured: { outcome: 'completed', summary: '完成', questions: [] }, output: [] }), dispose }
      },
    }
    const driver = createTrialAgent({ ctx, subagents: () => service, childForId: () => child, isKnownChild: id => id === 'child' })
    cleanups.push(() => driver.close())
    const output = await driver.run({ trialId: 'trial', childId: 'child', parent, model: { provider: 'offline', model: 'fixture' },
      prompt: '执行任务', tools: ['read_file'], maxSteps: 1, signal: new AbortController().signal, authorize() {}, onUsage,
    })
    expect(output.usage).toBeUndefined(); expect(onUsage).toHaveBeenCalledTimes(4)
    expect(runBusiness).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce()
  })
})
