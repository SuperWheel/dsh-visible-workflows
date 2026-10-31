import { PlanningStore } from '../src/host/planning/store.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowTrialService, type PlanningTrial, type TrialRequest } from '../src/host/planning/trial-service.ts'
import { WorkflowPlanningService, planningDigest, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { PlanningAgentError, type PlanningAgentInput } from '../src/host/planning/agent.ts'
import type { TrialAgentInput, TrialAgentResult } from '../src/host/planning/trial-agent.ts'
import type { TrialPublicEvent } from '../src/shared/planning-trial.ts'
import type { PlanningContext, PlannerOutput } from '../src/shared/planning-types.ts'
import type { TaskProcedure } from '../src/shared/retrospective.ts'
import { makeWorkflow, type WorkflowNode } from '../src/shared/types.ts'
import { projectWorkflow } from '../src/shared/planning-projection.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { fixturePlanningEdits } from './fixtures/planning-edits.ts'
import type { PlanningBackgroundRuntime } from '../src/host/planning/background.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const untilAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason) })
const request = (changes: Partial<TrialRequest> = {}): TrialRequest => ({
  requestId: 'trial-request', instruction: '先完成问候产物，再提炼复用流程',
  spec: { task: '读取 source.json 的姓名，写出 result.json 中的问候', tools: ['read_file', 'write_file'], inputs: ['source.json'],
    artifacts: [{ path: 'result.json', format: 'json', requireChanged: true, checks: [{ kind: 'json-equals', pointer: '/text', value: 'Hello Ada' }] }], reviewItems: [] },
  ...changes,
})
const publicEvents = (prompt = 'Host execution prompt'): TrialPublicEvent[] => [
  { seq: 0, type: 'turn/start', turn: 1 },
  { seq: 1, type: 'user/message', source: 'host', text: prompt.slice(0, 4000), truncated: prompt.length > 4000 },
  { seq: 2, type: 'tool/call', turn: 1, callId: 'read-1', toolName: 'read_file', text: '{"path":"source.json"}', truncated: false },
  { seq: 3, type: 'tool/result', turn: 1, callId: 'read-1', text: '{"name":"Ada"}', truncated: false, isError: false },
  { seq: 4, type: 'tool/call', turn: 1, callId: 'write-1', toolName: 'write_file', text: '{"path":"result.json","text":"Hello Ada"}', truncated: false },
  { seq: 5, type: 'tool/result', turn: 1, callId: 'write-1', text: '{"text":"Hello Ada","written":true}', truncated: false, isError: false },
  { seq: 6, type: 'assistant/message', turn: 1, text: '问候产物已生成', truncated: false, interrupted: false },
  { seq: 7, type: 'turn/end', turn: 1, completed: true },
]
const executionResult = (input: TrialAgentInput, events = publicEvents(input.prompt)): TrialAgentResult => ({
  childId: input.childId, stopReason: 'completed', outcome: 'completed', summary: '问候产物已生成，等待 Host 核验', questions: [], events, steps: 1, usage: { totalTokens: 42 }, evidenceIncomplete: false,
})
type Options = ConstructorParameters<typeof WorkflowTrialService>[0]
function fixture(config: { run?: (input: TrialAgentInput, context: { workspace: string; writeArtifact(): void }) => Promise<TrialAgentResult>; missingInput?: boolean; retentionLimits?:Options['retentionLimits'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trial-service-')), workspace = join(directory, 'workspace'); mkdirSync(workspace)
  if (!config.missingInput) writeFileSync(join(workspace, 'source.json'), '{"name":"Ada"}')
  const controller = new AbortController(), parent = { id: 'root-session', session: { id: 'root-session' } } as Agent, caller: PlanningCaller = { parent, sessionId: 'root-session', workspaceId: 'workspace', signal: controller.signal }
  const live = new Map([[parent.id, parent]]), disposed = new Set<(parent: Agent) => void>(), updates: PlanningTrial[] = [], waiting = new Set<() => void>()
  const runtime: PlanningBackgroundRuntime = { isLive: agent => live.get(agent.id) === agent, withInitiator: (_parent, operation) => operation(), onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener) } } }
  const actions = vi.fn(() => {
    const value = JSON.parse(readFileSync(join(workspace, 'source.json'), 'utf8'))
    writeFileSync(join(workspace, 'result.json'), JSON.stringify({ text: `Hello ${value.name}` }))
  })
  const driver = {
    run: vi.fn(async (input: TrialAgentInput): Promise<TrialAgentResult> => {
      input.authorize(); input.onPrepared?.({ toolDigest: 'b'.repeat(64), tools: input.tools }); input.onStep?.()
      if (config.run) return config.run(input, { workspace, writeArtifact: actions })
      const events = publicEvents(input.prompt); for (const event of events) input.onEvent?.(event)
      actions(); return executionResult(input, events)
    }), close: vi.fn(async () => {}),
  }
  const plan = vi.fn<Options['plan']>(async () => ({ id: 'planned-task', state: 'ready' }) as PlanningTask)
  const options: Options = {
    directory, retentionLimits:config.retentionLimits, driver, admission: new ModelAdmission(1, 1),
    resolve: vi.fn(async () => ({ workspaceRoot: workspace, model: { provider: 'offline', model: 'fixture' }, effort: 'low', policyDigest: 'a'.repeat(64) })),
    authorize: vi.fn((trial, owner) => { if (trial.rootSessionId !== owner.sessionId || trial.workspaceId !== owner.workspaceId) throw new Error('FORBIDDEN owner changed') }),
    plan,
    backgroundRuntime: runtime,
    onUpdate: trial => { updates.push(trial); for (const listener of waiting) listener() },
  }
  const services: WorkflowTrialService[] = []
  const reopen = () => { const service = new WorkflowTrialService(options); services.push(service); return service }
  const service = reopen(), file = join(directory, 'trials', 'planning', 'tasks.json')
  const stored = (): { version: 1; tasks: PlanningTrial[] } => ({version:1,tasks:new PlanningStore<PlanningTrial>(join(directory,'trials')).read(value=>value as PlanningTrial)})
  cleanups.push(async () => { await Promise.all(services.map(item => item.close())); rmSync(directory, { recursive: true, force: true }) })
  const freshCaller = () => ({ ...caller, signal: new AbortController().signal })
  const waitFor = (id: string, predicate: (trial: PlanningTrial) => boolean) => {
    const latest = () => updates.findLast(trial => trial.id === id && predicate(trial))
    if (latest()) return Promise.resolve(latest()!)
    return new Promise<PlanningTrial>(resolve => { const listener = () => { const trial = latest(); if (trial) { waiting.delete(listener); resolve(trial) } }; waiting.add(listener) })
  }
  const dispose = () => { live.delete(parent.id); for (const listener of disposed) listener(parent) }
  return { directory, workspace, caller, controller, service, reopen, options, driver, plan, actions, file, stored, freshCaller, waitFor, dispose, disposed, updates }
}

describe('background execute-first trial service (offline temporary-file driver)', () => {
  it('persists preparing before execution and returns without waiting for the trial or planner; caller abort does not end its lifetime', async () => {
    const entered = deferred(), executionGate = deferred(), planningEntered = deferred(), planningGate = deferred()
    const f = fixture({ run: async (input, { writeArtifact }) => {
      entered.resolve(); await Promise.race([executionGate.promise, untilAbort(input.signal)])
      input.signal.throwIfAborted(); for (const event of publicEvents()) input.onEvent?.(event)
      writeArtifact(); return executionResult(input)
    } })
    f.plan.mockImplementation(async (_request, caller) => { planningEntered.resolve(); await Promise.race([planningGate.promise, untilAbort(caller.signal)]); return { id: 'planned-task', state: 'ready' } as PlanningTask })
    const accepted = await f.service.start(request(), f.caller, { background: true })
    expect(accepted).toMatchObject({ state: 'preparing', delivery: { protocolVersion: 1, mode: 'background' } })
    expect(accepted.execution).toBeUndefined(); expect(accepted.planningTaskId).toBeUndefined()
    expect(f.stored().tasks[0]).toMatchObject({ id: accepted.id, state: 'preparing', childId: accepted.childId })
    await entered.promise
    f.controller.abort(new Error('tool call returned'))
    executionGate.resolve(); await planningEntered.promise
    expect(f.service.get(accepted.id, f.freshCaller()).state).toBe('planning')
    planningGate.resolve()
    const completed = await f.waitFor(accepted.id, trial => trial.state === 'ready')
    expect(completed.planningTaskId).toBe('planned-task'); expect(completed.verification?.verdict).toBe('passed')
    expect(f.actions).toHaveBeenCalledOnce(); expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.plan).toHaveBeenCalledOnce()
    expect(f.updates.filter(trial => trial.id === accepted.id && trial.state === 'ready')).toHaveLength(1)
  })

  it('hands a trial with no stated check to planning once the artifact exists (Desktop r54 A)', async () => {
    const f = fixture(), spec = { ...request().spec, artifacts: [{ path: 'result.json', format: 'json' as const, requireChanged: false, checks: [] }] }
    const accepted = await f.service.start(request({ spec }), f.caller, { background: true })
    const done = await f.waitFor(accepted.id, trial => trial.state === 'ready' || trial.state === 'failed')
    expect(done.diagnostics).toEqual([]); expect(done.state).toBe('ready')
    expect(done.verification).toMatchObject({ verdict: 'passed', artifacts: [{ status: 'passed', checks: [] }] }); expect(f.plan).toHaveBeenCalledOnce()
  })
  it('concurrent background starts return one trial immediately and changed content conflicts without replay', async () => {
    const entered = deferred(), f = fixture({ run: async input => { entered.resolve(); return untilAbort(input.signal) } })
    const [first, second] = await Promise.all([f.service.start(request(), f.caller, { background: true }), f.service.start(request(), f.caller, { background: true })])
    expect(first.id).toBe(second.id); expect(first.childId).toBe(second.childId)
    await entered.promise
    expect((await f.service.start(request(), f.freshCaller())).id).toBe(first.id)
    await expect(f.service.start(request({ instruction: 'Changed request' }), f.freshCaller(), { background: true })).rejects.toThrow('REQUEST_ID_CONFLICT')
    await expect(f.service.start(request({ requestId: 'different-request' }), f.freshCaller(), { background: true })).rejects.toThrow(/WORKSPACE_TRIAL_BUSY：本对话.*完成后自动释放/)
    // Another conversation learns only the stage and start time, never the holder's task.
    await expect(f.service.start(request({ requestId: 'other-request' }), { ...f.freshCaller(), sessionId: 'other-root' }, { background: true })).rejects.toThrow(/^WORKSPACE_TRIAL_BUSY：另一个对话在同一工作区的试做正在试做业务步骤（\d\d:\d\d UTC 开始），完成后自动释放；这不是遗留任务。请等它结束后用同一请求重试，不要取消它，也不必询问用户。$/)
    expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.actions).not.toHaveBeenCalled()
    expect((await f.service.cancel(first.id, f.freshCaller())).state).toBe('cancelled')
  })

  it('frees the workspace once a trial leaves its business steps; a first run waits for them, then holds the workspace (T30.2)', async () => {
    const executionGate = deferred(), planningGate = deferred()
    const f = fixture({ run: async (input, { writeArtifact }) => {
      await Promise.race([executionGate.promise, untilAbort(input.signal)])
      for (const event of publicEvents()) input.onEvent?.(event)
      writeArtifact(); return executionResult(input)
    } })
    f.plan.mockImplementation(async (_request, caller) => { await Promise.race([planningGate.promise, untilAbort(caller.signal)]); return { id: 'planned-task', state: 'ready' } as PlanningTask })
    const first = await f.service.start(request(), f.caller, { background: true })
    let held: (() => void) | undefined
    const holding = f.service.holdFirstRun('workspace', 'other-root', new AbortController().signal).then(release => { held = release })
    await Promise.resolve(); expect(held).toBeUndefined()
    executionGate.resolve(); await f.waitFor(first.id, trial => trial.state === 'planning'); await holding
    // A first run in progress turns new trial steps away, naming only its stage.
    await expect(f.service.start(request({ requestId: 'second-request' }), f.freshCaller(), { background: true })).rejects.toThrow(/^WORKSPACE_TRIAL_BUSY：另一个对话在同一工作区正在首跑新生成的工作流（\d{2}:\d{2} UTC 开始）/)
    held!()
    // The first trial is still generating; that no longer holds the workspace.
    const second = await f.service.start(request({ requestId: 'second-request' }), f.freshCaller(), { background: true })
    await f.waitFor(second.id, trial => trial.state === 'planning')
    planningGate.resolve()
    await f.waitFor(first.id, trial => trial.state === 'ready'); await f.waitFor(second.id, trial => trial.state === 'ready')
    const stopped = new AbortController(), busy = await f.service.start(request({ requestId: 'third-request' }), f.freshCaller(), { background: true })
    expect(busy.state).toBe('preparing')
    const waiting = f.service.holdFirstRun('workspace', 'root-session', stopped.signal)
    stopped.abort(new Error('caller stopped')); await expect(waiting).rejects.toThrow('caller stopped')
  })

  it('immediate cancellation after acceptance does not start a business child', async () => {
    const f = fixture(), accepted = await f.service.start(request(), f.caller, { background: true })
    const stopped = await f.service.cancel(accepted.id, f.freshCaller())
    expect(stopped.state).toBe('cancelled'); expect(f.driver.run).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled()
    expect((await f.service.start(request(), f.freshCaller(), { background: true })).id).toBe(accepted.id)
  })

  it('parent disposal cancels the owned background trial and retains receipts emitted during cleanup', async () => {
    const entered = deferred(), f = fixture({ run: async input => {
      for (const event of publicEvents().slice(0, 4)) input.onEvent?.(event)
      entered.resolve(); await untilAbort(input.signal).catch(() => {})
      input.onEvent?.(publicEvents()[4]!); throw input.signal.reason
    } })
    const accepted = await f.service.start(request(), f.caller, { background: true }); await entered.promise
    f.dispose()
    const cancelled = await f.waitFor(accepted.id, trial => trial.state === 'cancelled')
    expect(cancelled.diagnostics.at(-1)?.code).toBe('PLANNING_PARENT_DISPOSED')
    expect(cancelled.events.at(-1)).toMatchObject({ type: 'tool/call', callId: 'write-1' })
    expect(f.actions).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled()
    await f.service.close(); expect(f.disposed.size).toBe(0)
  })

  it('Host close waits for actual cleanup and preserves interrupted identity and completed effects across restart', async () => {
    const entered = deferred(), abortSeen = deferred(), cleanup = deferred()
    const f = fixture({ run: async (input, { writeArtifact }) => {
      for (const event of publicEvents().slice(0, 5)) input.onEvent?.(event)
      writeArtifact(); entered.resolve()
      await untilAbort(input.signal).catch(() => { abortSeen.resolve() })
      await cleanup.promise; input.onEvent?.(publicEvents()[5]!); throw input.signal.reason
    } })
    const accepted = await f.service.start(request(), f.caller, { background: true }); await entered.promise
    let closed = false
    const closing = f.service.close().then(() => { closed = true })
    await abortSeen.promise
    expect(closed).toBe(false); expect(f.driver.close).not.toHaveBeenCalled()
    cleanup.resolve(); await closing
    expect(f.service.get(accepted.id, f.freshCaller())).toMatchObject({ state: 'interrupted', childId: accepted.childId })
    expect(f.driver.close).toHaveBeenCalledOnce(); expect(f.plan).not.toHaveBeenCalled()
    const restored = await f.reopen().start(request(), f.freshCaller(), { background: true })
    expect(restored.id).toBe(accepted.id); expect(restored.state).toBe('interrupted')
    expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.actions).toHaveBeenCalledOnce()
  })

  it('an in-flight crash snapshot restores the same trial interrupted without replaying actions', async () => {
    const entered = deferred(), f = fixture({ run: async input => { entered.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(request(), f.caller, { background: true }); await entered.promise
    const crashed = readFileSync(f.file, 'utf8')
    await f.service.close(); writeFileSync(f.file, crashed)
    const restored = await f.reopen().start(request(), f.freshCaller(), { background: true })
    expect(restored).toMatchObject({ id: accepted.id, childId: accepted.childId, state: 'interrupted', delivery: { recovered: true } })
    expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.actions).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled()
  })

  it('continues a background rehearsal with final review notes without a human gate', async () => {
    const f=fixture(),req=request();req.spec.reviewItems=['请审阅语气']
    const accepted=await f.service.start(req,f.caller,{background:true})
    const done=await f.waitFor(accepted.id,trial=>trial.state==='ready')
    expect(done.humanReview).toBeUndefined();expect(done.verification?.verdict).toBe('needs-review')
    expect(f.plan).toHaveBeenCalledOnce();expect(f.actions).toHaveBeenCalledOnce()
    expect(f.service.resolveEvidence(done.id,f.caller).trialReport).toMatchObject({summarySource:'agent-claim',verification:{verdict:'needs-review'}})
  })
  it('does not count planning against the trial execution deadline', async () => {
    vi.useFakeTimers()
    const f=fixture();let signal:AbortSignal|undefined
    f.plan.mockImplementation(async(_request,caller)=>{signal=caller.signal;await vi.advanceTimersByTimeAsync(1_500_000);return {id:'planned-task',state:'ready'} as PlanningTask})
    const done=await f.service.start(request(),f.caller)
    expect(done.state).toBe('ready');expect(signal?.aborted).toBe(false)
  })

  it('checks execution evidence before asking for human review', async () => {
    const f = fixture({ run: async (input, { writeArtifact }) => {
      const events = publicEvents(input.prompt).filter(event => !event.type.startsWith('tool/')); for (const event of events) input.onEvent?.(event)
      writeArtifact(); return executionResult(input, events)
    } }), req = request(); req.spec.reviewItems = ['Real human confirms the greeting tone']
    const accepted = await f.service.start(req, f.caller, { background: true })
    const stopped = await f.waitFor(accepted.id, trial => trial.state === 'failed')
    expect(stopped.diagnostics.at(-1)?.message).toContain('业务工具'); expect(f.plan).not.toHaveBeenCalled()
  })

  it('compacts oversized rehearsal evidence visibly and still generates, while telling the agent to limit fetch retries', async () => {
    const f = fixture({ run: async (input, { writeArtifact }) => {
      const base = publicEvents(input.prompt), end = base.pop()!, attempts: TrialPublicEvent[] = []
      for (let index = 0; index < 16; index++) attempts.push(
        { seq: 100 + index * 2, type: 'tool/call', turn: 1, callId: `fetch-${index}`, toolName: 'web_fetch', text: `{"url":"https://mirror-${index}.example/page"}`, truncated: false },
        { seq: 101 + index * 2, type: 'tool/result', turn: 1, callId: `fetch-${index}`, text: 'x'.repeat(1800), truncated: false, isError: false })
      const events = [...base, ...attempts, { ...end, seq: 200 }]; for (const event of events) input.onEvent?.(event)
      writeArtifact(); return executionResult(input, events)
    } }), req = request(); req.spec.reviewItems = ['Real human confirms the greeting tone']
    const accepted = await f.service.start(req, f.caller, { background: true })
    const ready = await f.waitFor(accepted.id, trial => trial.state === 'ready')
    expect(ready.diagnostics.some(item => item.code === 'TRIAL_EVIDENCE_TOO_LARGE')).toBe(false)
    expect(f.plan).toHaveBeenCalledOnce()
    const evidence = ready.verified!.evidence
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(24_000)
    expect(evidence.warnings.some(item => item.includes('超过 100 条或 24 KB') && item.includes('不代表这些步骤未发生'))).toBe(true)
    // The last fetch is the working path and keeps its excerpt; earlier mirrors give way.
    expect(evidence.records.find(record => record.callId === 'fetch-15' && record.kind === 'tool-result')).toMatchObject({ status: 'reported-success', truncated: false })
    expect(evidence.records.filter(record => record.callId?.startsWith('fetch-') && record.truncated).length).toBeGreaterThan(0)
    const sent = JSON.parse(f.driver.run.mock.calls[0]![0].prompt), prompt = sent.instruction
    expect(prompt).toContain('最多再换两个公开镜像或替代地址'); expect(prompt).toContain('实际工具、地址')
    // Desktop r51: the request scope (e.g. every file in a directory) reaches the rehearsal, not only the task's current file names.
    expect(sent.request).toBe('先完成问候产物，再提炼复用流程')
    expect(prompt).toContain('按request的范围演练'); expect(prompt).toContain('不要创建或保存工作流')
  })

  it('refuses a match pattern as a trial input before queuing anything (Desktop r52)', async () => {
    const f = fixture(), patterned = request(); patterned.spec.inputs = ['t05/*.csv']
    await expect(f.service.start(patterned, f.caller, { background: true })).rejects.toThrow(/^TRIAL_INPUT_PATTERN：.*t05\/\*\.csv 是匹配模式。目录和匹配模式写进 task/)
    expect(f.driver.run).not.toHaveBeenCalled()
  })

  it('does not equate a planner acceptance/task ID with trial.ready', async () => {
    const f = fixture(); f.plan.mockResolvedValue({ id: 'only-accepted-planner', state: 'queued' } as PlanningTask)
    const accepted = await f.service.start(request(), f.caller, { background: true })
    const stopped = await f.waitFor(accepted.id, trial => trial.state === 'failed')
    expect(stopped.planningTaskId).toBe('only-accepted-planner'); expect(stopped.diagnostics.at(-1)?.code).toBe('TRIAL_PLANNING_INCOMPLETE')
    expect(stopped.verified).toBeDefined(); expect(stopped.receiptDigest).toBeDefined(); expect(f.actions).toHaveBeenCalledOnce()
  })

  it('deadline failure preserves actual receipts and releases the child before closing its driver', async () => {
    vi.useFakeTimers()
    const entered = deferred(), f = fixture({ run: async input => { for (const event of publicEvents().slice(0, 4)) input.onEvent?.(event); entered.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(request(), f.caller, { background: true }); await entered.promise
    await vi.advanceTimersByTimeAsync(1_200_000)
    const stopped = await f.waitFor(accepted.id, trial => trial.state === 'failed')
    expect(stopped.diagnostics.at(-1)?.code).toBe('PLANNING_DEADLINE_EXCEEDED'); expect(stopped.events).toHaveLength(4)
    expect(f.plan).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled()
    await f.service.close(); expect(f.disposed.size).toBe(0)
  })

  it('requires explicit Host background lifecycle support and rechecks cancellation after environment resolution', async () => {
    const f = fixture(); delete f.options.backgroundRuntime
    await expect(f.service.start(request(), f.caller, { background: true })).rejects.toThrow('受管理的后台试做生命周期')
    expect(existsSync(f.file)).toBe(false); expect(f.driver.run).not.toHaveBeenCalled()
    const resolving = deferred<Awaited<ReturnType<Options['resolve']>>>()
    const original = await f.options.resolve(f.caller); f.options.resolve = () => resolving.promise
    const starting = f.service.start(request(), f.caller)
    f.controller.abort(new Error('Cancelled while resolving'))
    resolving.resolve(original)
    await expect(starting).rejects.toThrow('Cancelled while resolving')
    expect(existsSync(f.file)).toBe(false); expect(f.driver.run).not.toHaveBeenCalled()
  })
})

describe('trial service with real temporary artifacts and evidence builder', () => {
  it('journals admission before execution, independently verifies artifacts and automatically plans exact owned evidence', async () => {
    const f = fixture()
    f.plan.mockImplementation(async (req, caller) => {
      expect(req.source).toMatchObject({ kind: 'verified-trial' })
      expect(req.preview).toBe(false); expect(req.operation).toBe('create')
      const trialId = req.source!.kind === 'verified-trial' ? req.source.trialId : ''
      const resolved = f.service.resolveEvidence(trialId, caller), live = f.service.get(trialId, caller)
      expect(resolved.conversation.sessionId).toBe(live.childId)
      expect(resolved.conversation.sessionId).not.toBe(caller.sessionId)
      expect(resolved.trial).toMatchObject({ trialId, rootSessionId: caller.sessionId, childSessionId: live.childId, verificationDigest: live.verification!.digest, evidenceDigest: live.verified!.evidence.digest, receiptDigest: live.receiptDigest })
      expect(resolved.conversation.records.map(row => row.id)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6'])
      expect(resolved.conversation.records.find(row => row.id === 'e5')?.text).toBe('{"text":"Hello Ada","written":true}')
      expect(req.instruction).toBe(request().instruction)
      expect(resolved.trialTask).toEqual({ task: request().spec.task, inputs: request().spec.inputs, artifacts: request().spec.artifacts, reviewItems: [] })
      return { id: 'planned-task', state: 'ready' } as PlanningTask
    })
    const original = f.driver.run.getMockImplementation()!
    f.driver.run.mockImplementation(async input => {
      expect(f.service.isKnownChild(input.childId)).toBe(true)
      expect(f.stored().tasks[0]).toMatchObject({ childId: input.childId, state: 'executing', before: expect.any(Object) })
      return original(input)
    })
    const task = await f.service.start(request(), f.caller)
    expect(task.diagnostics).toEqual([])
    expect(task).toMatchObject({ state: 'ready', planningTaskId: 'planned-task', steps: 1, spentTokens: 42, toolDigest: 'b'.repeat(64), verification: { verdict: 'passed' } })
    expect(task.before!.files['result.json']!.status).toBe('missing')
    expect(task.verification!.artifacts[0]).toMatchObject({ status: 'passed', changed: true })
    expect(f.actions).toHaveBeenCalledOnce(); expect(f.plan).toHaveBeenCalledOnce()
    const restored = f.reopen().get(task.id, f.caller)
    expect(restored.verified).toEqual(task.verified); expect(restored.planningTaskId).toBe(task.planningTaskId)
  })
  it('preserves failed actual checks while continuing after a completed rehearsal', async () => {
    const f = fixture({ run: async (input, { workspace }) => {
      for (const event of publicEvents()) input.onEvent?.(event)
      writeFileSync(join(workspace, 'result.json'), '{"text":"wrong answer"}')
      return executionResult(input)
    } })
    const task = await f.service.start(request(), f.caller)
    expect(task.state).toBe('ready'); expect(task.verification?.verdict).toBe('failed')
    expect(task.diagnostics.some(item => item.code === 'TRIAL_CHECK_WARNINGS')).toBe(true)
    expect(task.execution?.outcome).toBe('completed'); expect(task.verified).toBeDefined(); expect(f.plan).toHaveBeenCalledOnce()
  })
  describe('continuing a trial that stopped mid-way (T30.1)', () => {
    // The first child read the input, started the write and hit the step limit before its result.
    const stoppedEvents = (prompt: string): TrialPublicEvent[] => [
      { seq: 0, type: 'turn/start', turn: 1 },
      { seq: 1, type: 'user/message', source: 'host', text: prompt.slice(0, 4000), truncated: prompt.length > 4000 },
      { seq: 2, type: 'tool/call', turn: 1, callId: 'read-1', toolName: 'read_file', text: '{"path":"source.json"}', truncated: false },
      { seq: 3, type: 'tool/result', turn: 1, callId: 'read-1', text: '{"name":"Ada"}', truncated: false, isError: false },
      { seq: 4, type: 'tool/call', turn: 1, callId: 'write-1', toolName: 'write_file', text: '{"path":"result.json"}', truncated: false },
      { seq: 5, type: 'turn/end', turn: 1, completed: false },
    ]
    // The fresh child starts after its spawn records and reuses a provider call ID.
    const carriedEvents = (prompt: string): TrialPublicEvent[] => [
      { seq: 3, type: 'turn/start', turn: 1 },
      { seq: 4, type: 'user/message', source: 'host', text: prompt.slice(0, 4000), truncated: prompt.length > 4000 },
      { seq: 5, type: 'tool/call', turn: 1, callId: 'write-1', toolName: 'write_file', text: '{"path":"result.json","text":"Hello Ada"}', truncated: false },
      { seq: 6, type: 'tool/result', turn: 1, callId: 'write-1', text: '{"written":true}', truncated: false, isError: false },
      { seq: 7, type: 'assistant/message', turn: 1, text: '已接着写完', truncated: false, interrupted: false },
      { seq: 8, type: 'turn/end', turn: 1, completed: true },
    ]
    const stop = (code: string) => Object.assign(new Error(`stopped: ${code}`), { code })
    const twoSegments = (second: (input: TrialAgentInput, writeArtifact: () => void) => Promise<TrialAgentResult>, first = 'TRIAL_STEP_LIMIT') => {
      const inputs: TrialAgentInput[] = []
      const f = fixture({ run: async (input, { writeArtifact }) => {
        inputs.push(input)
        if (inputs.length > 1) return second(input, writeArtifact)
        for (const event of stoppedEvents(input.prompt)) input.onEvent?.(event)
        throw stop(first)
      } })
      return { f, inputs }
    }
    const path = [{ call: 1, tool: 'read_file', label: '读取姓名', status: 'success' }, { call: 3, tool: 'write_file', label: '写出问候', status: 'success' }]
    it('carries on once in a fresh child seeded with the earlier calls, and plans from both segments', async () => {
      const { f, inputs } = twoSegments(async (input, writeArtifact) => {
        const events = carriedEvents(input.prompt); for (const event of events) input.onEvent?.(event)
        writeArtifact(); return { ...executionResult(input, events), path }
      })
      const task = await f.service.start(request(), f.caller)
      expect(task.state).toBe('ready'); expect(f.driver.run).toHaveBeenCalledTimes(2); expect(f.actions).toHaveBeenCalledOnce()
      const [first, second] = inputs
      expect(second!.childId).not.toBe(first!.childId); expect(f.service.isKnownChild(second!.childId)).toBe(true)
      const carried = JSON.parse(second!.prompt).continuation
      expect(carried).toMatchObject({ stopped: expect.stringMatching(/^TRIAL_STEP_LIMIT：/), nextCall: 3,
        previousCalls: [{ call: 1, tool: 'read_file', status: 'reported-success', result: '{"name":"Ada"}' }, { call: 2, tool: 'write_file', status: 'unknown' }] })
      expect(task.continuations).toEqual([{ childId: second!.childId, fromSeq: 6, fromCall: 3, failure: { code: 'TRIAL_STEP_LIMIT', message: 'stopped: TRIAL_STEP_LIMIT' }, at: expect.any(String) }])
      expect(task.diagnostics.map(item => item.code)).toContain('TRIAL_CONTINUED')
      // One stream: seq and turn carry on, the reused call ID stays distinct.
      expect(task.events.slice(6).map(event => event.seq)).toEqual([9, 10, 11, 12, 13, 14])
      expect(task.events.at(-1)).toEqual({ seq: 14, type: 'turn/end', turn: 2, completed: true })
      expect(task.events.filter(event => event.type === 'tool/call').map(event => 'callId' in event && event.callId)).toEqual(['read-1', 'write-1', 'r1-write-1'])
      expect(task.verification?.verdict).toBe('passed')
      const resolved = f.service.resolveEvidence(task.id, f.freshCaller())
      expect(resolved.conversation.records.map(row => row.id)).toEqual(['e2', 'e3', 'e11', 'e12'])
      expect(resolved.conversation.warnings.some(warning => warning.includes('试做分两段'))).toBe(true)
      expect(resolved.trialReport.summary).toBe('读取姓名：调用报告成功；写出问候：调用报告成功')
      // The receipt covers both segments and survives a restart.
      expect(f.reopen().get(task.id, f.caller)).toEqual(task)
    })
    it('carries on a child that stopped without submitting its result', async () => {
      const inputs: TrialAgentInput[] = []
      const f = fixture({ run: async (input, { writeArtifact }) => {
        inputs.push(input)
        if (inputs.length === 1) {
          for (const event of stoppedEvents(input.prompt)) input.onEvent?.(event)
          return { ...executionResult(input), stopReason: 'max_turns', outcome: 'failed', summary: '未提交', submitted: false }
        }
        const events = carriedEvents(input.prompt); for (const event of events) input.onEvent?.(event)
        writeArtifact(); return { ...executionResult(input, events), path }
      } })
      const task = await f.service.start(request(), f.caller)
      expect(task.state).toBe('ready'); expect(task.continuations?.[0]?.failure.code).toBe('TRIAL_NOT_SUBMITTED')
      expect(task.spentTokens).toBe(84)
    })
    it('reports a second stop, and never carries on a stop it cannot', async () => {
      const again = twoSegments(async input => { for (const event of carriedEvents(input.prompt).slice(0, 3)) input.onEvent?.(event); throw stop('TRIAL_IDLE_TIMEOUT') })
      const failed = await again.f.service.start(request(), again.f.caller)
      expect(failed.state).toBe('failed'); expect(again.f.driver.run).toHaveBeenCalledTimes(2)
      expect(failed.diagnostics.map(item => item.code)).toEqual(['TRIAL_CONTINUED', 'TRIAL_IDLE_TIMEOUT'])
      for (const code of ['TRIAL_PROVIDER_QUOTA', 'TRIAL_EVIDENCE_LIMIT', 'TRIAL_TOOL_CHANGED']) {
        const once = twoSegments(async () => { throw new Error('must not continue') }, code)
        const ended = await once.f.service.start(request(), once.f.caller)
        expect(ended.state).toBe('failed'); expect(once.f.driver.run).toHaveBeenCalledOnce(); expect(ended.continuations).toBeUndefined()
      }
      // A gap in the stopped child's record leaves nothing safe to build on.
      const gap = fixture({ run: async input => { throw Object.assign(stop('TRIAL_STEP_LIMIT'), { evidenceIncomplete: true }) } })
      expect((await gap.service.start(request(), gap.caller)).state).toBe('failed'); expect(gap.driver.run).toHaveBeenCalledOnce()
    })
  })
  it('does not execute if a frozen input is missing', async () => {
    const f = fixture({ missingInput: true }), task = await f.service.start(request(), f.caller)
    expect(task.state).toBe('failed'); expect(task.diagnostics[0]?.code).toBe('TRIAL_INPUT_UNAVAILABLE')
    expect(f.driver.run).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled(); expect(task.before?.files['source.json']?.status).toBe('missing')
  })
  it('detects input mutation and never treats it as a successful reusable execution', async () => {
    const f = fixture({ run: async (input, { workspace, writeArtifact }) => {
      for (const event of publicEvents()) input.onEvent?.(event)
      writeArtifact(); writeFileSync(join(workspace, 'source.json'), '{"name":"changed"}')
      return executionResult(input)
    } })
    const task = await f.service.start(request(), f.caller)
    expect(task.verification?.inputs[0]?.status).toBe('failed'); expect(f.plan).toHaveBeenCalledOnce();expect(task.state).toBe('ready')
  })
  it('deduplicates concurrent starts across asynchronous environment lookup and rejects reused content', async () => {
    const gate = deferred(), started = deferred()
    const f = fixture({ run: async (input, { writeArtifact }) => { started.resolve(); await gate.promise; for (const event of publicEvents()) input.onEvent?.(event); writeArtifact(); return executionResult(input) } })
    const first = f.service.start(request(), f.caller), second = f.service.start(request(), f.caller)
    await started.promise; expect(f.driver.run).toHaveBeenCalledOnce(); gate.resolve()
    const [a, b] = await Promise.all([first, second]); expect(a.id).toBe(b.id); expect(a.childId).toBe(b.childId)
    expect(f.actions).toHaveBeenCalledOnce(); expect(f.plan).toHaveBeenCalledOnce()
    await expect(f.service.start(request({ instruction: 'changed task' }), f.caller)).rejects.toThrow('REQUEST_ID_CONFLICT')
    expect((await f.reopen().start(request(), f.caller)).id).toBe(a.id); expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.plan).toHaveBeenCalledOnce()
  })
  it('keeps a persisted in-flight receipt interrupted on restart and never replays its effects', async () => {
    const entered = deferred(), release = deferred(); let input!: TrialAgentInput
    const f = fixture({ run: async (value, { writeArtifact }) => {
      input = value; for (const event of publicEvents().slice(0, 4)) value.onEvent?.(event); writeArtifact(); entered.resolve(); await release.promise
      value.signal.throwIfAborted(); return executionResult(value)
    } })
    const work = f.service.start(request(), f.caller); await entered.promise
    const crashSnapshot = JSON.stringify(f.stored()), stopping = f.service.cancel(input.trialId, f.caller)
    release.resolve(); await stopping; await work; await f.service.close()
    // Replay the exact durable snapshot that existed before process loss, without
    // retaining a live executor. This models recovery without repeating actions.
    writeFileSync(f.file, crashSnapshot)
    const restoredService = f.reopen(), restored = await restoredService.start(request(), f.caller)
    expect(restored.state).toBe('interrupted'); expect(restored.events).toHaveLength(4)
    expect(restored.diagnostics.some(item => item.code === 'TRIAL_INTERRUPTED')).toBe(true)
    expect(f.actions).toHaveBeenCalledOnce(); expect(f.driver.run).toHaveBeenCalledOnce(); expect(f.plan).not.toHaveBeenCalled()
  })
  it('cancel waits for driver disposal and preserves receipts produced during cleanup', async () => {
    const entered = deferred(), abortSeen = deferred(), disposeGate = deferred(); let input!: TrialAgentInput, disposed = false
    const f = fixture({ run: async (value, { writeArtifact }) => {
      input = value; for (const event of publicEvents().slice(0, 5)) value.onEvent?.(event); writeArtifact(); entered.resolve()
      await new Promise<void>(resolve => value.signal.addEventListener('abort', () => { abortSeen.resolve(); resolve() }, { once: true }))
      await disposeGate.promise
      value.onEvent?.(publicEvents()[5]!); disposed = true; throw value.signal.reason
    } })
    const work = f.service.start(request(), f.caller); await entered.promise
    let cancelled = false; const stop = f.service.cancel(input.trialId, f.caller).then(task => { cancelled = true; return task })
    await abortSeen.promise; await Promise.resolve(); expect(cancelled).toBe(false); expect(disposed).toBe(false)
    disposeGate.resolve(); const task = await stop; await work
    expect(disposed).toBe(true); expect(task.state).toBe('cancelled'); expect(task.events.at(-1)).toMatchObject({ type: 'tool/result', callId: 'write-1' })
    expect(f.plan).not.toHaveBeenCalled(); expect((await f.service.start(request(), f.caller)).state).toBe('cancelled'); expect(f.driver.run).toHaveBeenCalledOnce()
  })
  it('does not trust a completed artifact without complete successful business receipts', async () => {
    const f = fixture({ run: async (input, { writeArtifact }) => {
      writeArtifact(); const events: TrialPublicEvent[] = [{ seq: 0, type: 'turn/start', turn: 1 }, { seq: 1, type: 'assistant/message', turn: 1, text: '我完成了', truncated: false, interrupted: false }, { seq: 2, type: 'turn/end', turn: 1, completed: true }]
      for (const event of events) input.onEvent?.(event)
      return executionResult(input, events)
    } })
    const task = await f.service.start(request(), f.caller)
    expect(task.verification?.verdict).toBe('passed'); expect(task.state).toBe('failed'); expect(task.verified).toBeUndefined(); expect(f.plan).not.toHaveBeenCalled()
    expect(task.diagnostics.at(-1)?.message).toContain('业务工具')
  })
  it.each([false, true])('retains an incomplete execution trace without allowing human review to upgrade it (review items: %s)', async withReviewItems => {
    const f = fixture({ run: async (input, { writeArtifact }) => {
      for (const event of publicEvents()) input.onEvent?.(event)
      writeArtifact(); return { ...executionResult(input), evidenceIncomplete: true }
    } })
    const req = request(); if (withReviewItems) req.spec.reviewItems = ['人工检查语气']
    const task = await f.service.start(req, f.caller)
    expect(task.verification?.verdict).toBe(withReviewItems ? 'needs-review' : 'passed'); expect(task.state).toBe('failed')
    expect(task.evidenceIncomplete).toBe(true); expect(task.events.length).toBeGreaterThan(0)
    expect(task.diagnostics.at(-1)?.code).toBe('TRIAL_EVIDENCE_INCOMPLETE')
    expect(task.verified).toBeUndefined(); expect(f.plan).not.toHaveBeenCalled()
    const reopened = f.reopen()
    const retained=reopened.get(task.id,f.caller)
    expect(retained.state).toBe('failed');expect(retained.verified).toBeUndefined();expect(f.plan).not.toHaveBeenCalled()
  })
  it('keeps needs-input terminal without automatically starting another execution', async () => {
    const f = fixture({ run: async input => ({ ...executionResult(input, []), outcome: 'needs-input', questions: ['请确认输出语言'] }) })
    const task = await f.service.start(request(), f.caller)
    expect(task.state).toBe('needs_input'); expect(task.verification).toBeUndefined(); expect(f.plan).not.toHaveBeenCalled()
    await f.service.start(request(), f.caller); expect(f.driver.run).toHaveBeenCalledOnce()
  })
  it.each(['failed','unverified'] as const)('generates with %s frozen checks as warnings',async status=>{
    const f=fixture({run:async(input,{workspace})=>{
      for(const event of publicEvents())input.onEvent?.(event)
      if(status==='failed')writeFileSync(join(workspace,'result.json'),'{"text":"wrong"}')
      else mkdirSync(join(workspace,'result.json'))
      return {...executionResult(input),summary:'读取已跑通，输出未跑通'}
    }})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(f.plan).toHaveBeenCalledOnce()
    const evidence=f.service.resolveEvidence(task.id,f.caller)
    expect(evidence.trialReport.verification.artifacts[0]?.status).toBe(status)
    expect(evidence.trialReport.summary).toBe('读取已跑通，输出未跑通')
    expect(evidence.conversation.warnings.join(' ')).toContain('result.json')
    expect(f.reopen().resolveEvidence(task.id,f.caller)).toEqual(evidence)
  })
  it('binds the rehearsal summary to the durable receipt',async()=>{
    const f=fixture(),done=await f.service.start(request(),f.caller)
    await f.service.close()
    done.execution!.summary='篡改后的成功声明'
    new PlanningStore<PlanningTrial>(join(f.directory,'trials')).write([done])
    expect(()=>f.reopen()).toThrow('回执摘要')
    expect(f.driver.run).toHaveBeenCalledOnce();expect(f.plan).toHaveBeenCalledOnce()
  })
  it('ends legacy needs_review on restore without invoking planning or execution',async()=>{
    const f=fixture(),done=await f.service.start(request(),f.caller)
    await f.service.close()
    const legacy={...done,state:'needs_review' as const}
    delete legacy.verified;delete legacy.receiptDigest;delete legacy.planningTaskId;delete legacy.receiptVersion
    new PlanningStore<PlanningTrial>(join(f.directory,'trials')).write([legacy])
    const restored=f.reopen().get(done.id,f.caller)
    expect(restored.state).toBe('interrupted')
    expect(restored.diagnostics.at(-1)?.code).toBe('TRIAL_LEGACY_REVIEW_ENDED')
    expect(restored.events).toEqual(done.events);expect(f.driver.run).toHaveBeenCalledOnce();expect(f.plan).toHaveBeenCalledOnce()
  })
  it('denies evidence or continuation to a different root session', async () => {
    const f = fixture(), task = await f.service.start(request(), f.caller), foreign = { ...f.caller, sessionId: 'other-root', parent: { id: 'other-root' } as Agent }
    expect(() => f.service.resolveEvidence(task.id, foreign)).toThrow('不属于当前主对话')
    await expect(f.service.cancel(task.id, foreign)).rejects.toThrow('不属于当前主对话')
  })
})

describe('trial linking to the real v0.0.2 planner with offline model output', () => {
  it.each(['over-target', 'optimizer-failure'] as const)('keeps the verified execution linked to a retained candidate after %s', async mode => {
    const f = fixture(), base = makeWorkflow('workspace', '问候样本')
    const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode => ({ id, kind, title: id, number: '', x: 0, y: 0, fixed: false, config })
    base.nodes = [node('start', 'input', { fields: [{ name: 'name', label: '姓名', required: true }] }), node('greet', 'llm', { prompt: 'Hello {{input.name}}' }), node('out', 'output', { text: '{{greet.text}}', outputName: 'result' })]
    base.edges = [{ id: 'e-start', source: 'start', target: 'greet' }, { id: 'e-out', source: 'greet', target: 'out' }]
    const generate = vi.fn(async (input: PlanningAgentInput) => {
      input.beforeStep?.(100, undefined)
      let output: unknown
      if (input.purpose === 'distill') {
        const prompt = JSON.parse(input.prompt), procedure: TaskProcedure = { goal: '生成问候结果', parameters: [{ name: 'name', description: '姓名' }], rules: ['问候包含姓名'], steps: [{ id: 'S1', title: '生成问候', instruction: '按样本格式化问候结果', dependsOn: [], evidenceRefs: prompt.conversation.records.map((row: { id: string }) => row.id), requiresReview: false }], excluded: [], reviewItems: [] }
        output = { outcome: 'procedure', procedureJson: JSON.stringify(procedure), summary: '方法已提炼', questions: [] }
      } else if (input.purpose === 'optimize') {
        if (mode === 'optimizer-failure') throw new PlanningAgentError('PLANNING_IDLE_TIMEOUT', '离线优化阶段超时')
        output = { outcome: 'unchanged', graphJson: '', summary: '没有可验证的替换', replacements: [], regressionCases: [] }
      } else output = { outcome: 'candidate', graphJson: JSON.stringify(projectWorkflow(base)), summary: '原始候选', questions: [], assumptions: [], requirementCoverage: [{ requirementId: 'R1', nodeIds: base.nodes.map(item => item.id), note: '图级需求' }, { requirementId: 'S1', nodeIds: ['greet'], note: '提炼步骤' }] } satisfies PlannerOutput
      return { output: fixturePlanningEdits(input, output, base), steps: 1, usage: { totalTokens: 50 } }
    })
    const plannerOptions: ConstructorParameters<typeof WorkflowPlanningService>[0] = {
      directory: f.directory, driver: { generate }, admission: f.options.admission,
      context: async (req, caller): Promise<PlanningContext> => {
        if (req.source?.kind !== 'verified-trial') throw new Error('expected trial source')
        return { workflow:{...structuredClone(base),nodes:structuredClone([base.nodes[0]!,base.nodes.at(-1)!]),edges:[{id:'scaffold',source:'start',target:'out'}]}, operation: 'create', targetNodeIds: [], nodeIds: ['greet'], subagentIds: [], environmentIds: [], tools: [], model: { provider: 'offline', model: 'fixture' }, ...f.service.resolveEvidence(req.source.trialId, caller) }
      },
      authorize: vi.fn(), readiness: async candidate => ({ workflowId: candidate.id, revision: candidate.revision, canRun: true, issues: [] }), publish: vi.fn(async () => {}), receipt: () => undefined,
    }
    const planner = new WorkflowPlanningService(plannerOptions); cleanups.push(() => planner.close())
    f.plan.mockImplementation((req, caller) => planner.start({...req,preview:true}, caller))
    const trial = await f.service.start(request({ optimizationTarget: { maxModelCalls: 0 } }), f.caller)
    expect(trial.state).toBe('ready'); expect(trial.planningTaskId).toBeDefined()
    const task = planner.get(trial.planningTaskId!, f.caller)
    expect(task.state).toBe('ready'); expect(task.candidate).toBeDefined(); expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.selected.targetEvaluation.status).toBe('over_target')
    expect(task.candidate).toEqual(task.optimization?.baseline.candidate)
    if (mode === 'optimizer-failure') expect(task.optimization?.stopReason).toBe('optimization_interrupted_candidate_retained')
    expect(task.request.source).toEqual({ kind: 'verified-trial', trialId: trial.id })
    expect(task.context?.trial?.receiptDigest).toBe(trial.receiptDigest)
    expect(f.actions).toHaveBeenCalledOnce(); expect(f.driver.run).toHaveBeenCalledOnce(); expect(plannerOptions.publish).not.toHaveBeenCalled()
    const restoredPlanner = new WorkflowPlanningService(plannerOptions); cleanups.push(() => restoredPlanner.close())
    const restoredTrial = f.reopen().get(trial.id, f.caller)
    expect(restoredPlanner.get(restoredTrial.planningTaskId!, f.caller).candidateDigest).toBe(planningDigest(task.candidate))
  })
})


describe('trial per-task journal persistence',()=>{
  it('journals only changed trials between phase snapshots and restores the latest event/usage without replay',async()=>{
    const entered=deferred<TrialAgentInput>(),f=fixture({run:async input=>{entered.resolve(input);return untilAbort(input.signal)}})
    const first=await f.service.start(request({requestId:'first'}),f.caller,{background:true}),input=await entered.promise
    const snapshot=readFileSync(f.file,'utf8')
    const secondCaller={...f.freshCaller(),workspaceId:'second-workspace'}
    const second=await f.service.start(request({requestId:'second'}),secondCaller,{background:true})
    for(const event of publicEvents())input.onEvent?.(event)
    input.onUsage?.({seq:1,totalTokens:37})
    expect(readFileSync(f.file,'utf8')).toBe(snapshot)
    const journal=readFileSync(join(f.directory,'trials','planning','tasks.journal'),'utf8')
    expect(journal).toContain(first.id);expect(journal).toContain(second.id)
    const committed=f.stored().tasks.find(trial=>trial.id===first.id)!
    expect(committed.events).toHaveLength(8);expect(committed.spentTokens).toBe(37)
    const writes=vi.spyOn((f.service as any).store,'write')
    for(let i=0;i<10;i++)input.onStep?.()
    expect(writes).not.toHaveBeenCalled()
    // Stop before reopening: restart changes states only and never starts a new child.
    await f.service.close()
    const restored=f.reopen()
    expect(restored.get(first.id,f.freshCaller()).events).toHaveLength(8)
    expect(restored.get(first.id,f.freshCaller()).spentTokens).toBe(37)
    expect(restored.get(second.id,secondCaller).state).toBe('interrupted')
    expect(f.driver.run).toHaveBeenCalledOnce()
  })
})


describe('trial retention',()=>{
  it('evicts old ended trials, keeps waiting trials and removes evicted child/request identities across restart',async()=>{
    const f=fixture({retentionLimits:{maxRows:4},run:async(input)=>({...executionResult(input),outcome:'needs-input'})})
    const waiting=await f.service.start(request({requestId:'waiting'}),f.caller)
    expect(waiting.state).toBe('needs_input')
    f.driver.run.mockImplementation(async input=>({...executionResult(input),outcome:'failed'}))
    const ended:PlanningTrial[]=[]
    for(let index=0;index<4;index++)ended.push(await f.service.start(request({requestId:`ended-${index}`}),f.caller))
    expect(f.stored().tasks.map(task=>task.id)).toEqual([waiting.id,...ended.slice(2).map(task=>task.id)])
    expect(()=>f.service.get(ended[0]!.id,f.caller)).toThrow('已清理')
    expect(f.service.isKnownChild(ended[0]!.childId)).toBe(false)
    await f.service.close()
    const reopened=f.reopen()
    expect(reopened.get(waiting.id,f.caller).state).toBe('needs_input')
    expect(()=>reopened.get(ended[0]!.id,f.caller)).toThrow('已清理')
    await reopened.start(request({requestId:'next'}),f.freshCaller())
    expect(f.stored().tasks.some(task=>task.id===ended[0]!.id)).toBe(false)
  })
  it('never evicts active or waiting-for-human trial states',()=>{
    const f=fixture(),service=f.service as any,retention=service.store.retention
    for(const state of ['preparing','executing','verifying','verified','planning','needs_input','needs_review'])expect(retention.canEvict({id:'row',state}),state).toBe(false)
    for(const state of ['ready','failed','cancelled','interrupted'])expect(retention.canEvict({id:'row',state}),state).toBe(true)
    service.active.set('row',{done:Promise.resolve()})
    expect(retention.canEvict({id:'row',state:'ready'})).toBe(false);service.active.delete('row')
  })
})


it('applies the byte limit to the trial store and compacts ended execution summaries',async()=>{
  const f=fixture({retentionLimits:{snapshotBytes:20_000},run:async input=>({...executionResult(input),outcome:'failed',summary:'说明'.repeat(2000)})})
  const trials:PlanningTrial[]=[]
  for(let index=0;index<3;index++)trials.push(await f.service.start(request({requestId:`large-${index}`}),f.caller))
  expect(()=>f.service.get(trials[0]!.id,f.caller)).toThrow('已清理')
  expect(readFileSync(f.file).byteLength).toBeLessThanOrEqual(15_000)
  expect(f.stored().tasks.at(-1)!.id).toBe(trials.at(-1)!.id)
  await f.service.close()
  expect(()=>f.reopen().get(trials[0]!.id,f.caller)).toThrow('已清理')
})
