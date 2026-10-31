import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, newId, type Workflow, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type AdapterNodeKind, type AdapterRequest, type ExecutionAdapters } from '../src/host/runtime.ts'
import { GraphonBridge } from '../src/host/graphon.ts'
import { NativeRepairExhaustedError } from '../src/host/native-agent.ts'
import { ModelAdmission, recordUsageCall, settleUsage, settleUsageGroup } from '../src/host/run-usage.ts'

// Scheduling and tokenization are the real Graphon subprocess. Only action/model
// providers are explicit doubles; these tests make no paid or external model calls.
const resources: { path: string; runtime: WorkflowRuntime }[] = []
const model = { provider: 'sdk-double', model: 'no-external-model' }
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function setup(adapters: ExecutionAdapters) {
  const path = mkdtempSync(join(tmpdir(), 'workflow-v2-continuation-'))
  const storage = new WorkflowStorage(path)
  const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('No model calls in this fixture') } }, adapters)
  resources.push({ path, runtime })
  return { storage, runtime }
}
function agentFlow(budget = 200, perTask = 40): Workflow {
  const flow = makeWorkflow('workspace', 'Continuation fixture', true)
  flow.nodes[1]!.kind = 'agent'
  flow.nodes[1]!.config = { model, prompt: 'Explicit SDK-shaped fixture only', tools: [], maxSteps: 5, outputSchema: [{ name: 'text', type: 'string', required: true }] }
  flow.nodes[1]!.config.subagentId='worker';flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
  flow.executionPolicy = { tokenBudget: budget, perTaskTokens: perTask, maxAgentTasks: 5, maxRepairAttempts: 2 }
  return flow
}
function liveAdapter() {
  const entered = deferred<AdapterRequest>(), finish = deferred<number | undefined>(), execute = vi.fn(async (_kind: AdapterNodeKind, request: AdapterRequest) => {
    request.onTask?.('owned-task')
    entered.resolve(request)
    const usage = await Promise.race([finish.promise, new Promise<number>((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); if (request.signal.aborted) reject(request.signal.reason) })])
    request.onUsage?.(usage === undefined ? undefined : { totalTokens: usage })
    request.onUsage?.(usage === undefined ? undefined : { totalTokens: usage }) // Native/provider duplicate receipt must not charge twice.
    return { text: 'action receipt' }
  })
  return { adapters: { execute } as ExecutionAdapters, entered, finish, execute }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { runtime, path } of resources.splice(0)) { await runtime.close(); rmSync(path, { recursive: true, force: true }) }
})

describe('v2 continuation with real Graphon and explicit action adapters', () => {
  it('pauses after repair exhaustion and accepts verified manual output without replaying the action or resetting its usage', async () => {
    const execute = vi.fn(async (_kind: AdapterNodeKind, request: AdapterRequest) => {
      request.onTask?.('original-action')
      request.onUsage?.({ totalTokens: 10 })
      const attempts = []
      for (let attempt = 1; attempt <= 2; attempt++) {
        await request.withRepairUsage!(async onUsage => { request.onTask?.(`output-repair-${attempt}`); onUsage({ totalTokens: attempt + 2 }) })
        attempts.push({ attempt, taskId: `output-repair-${attempt}`, error: 'Output is too short', candidate: { text: 'x' } })
      }
      throw new NativeRepairExhaustedError('输出修复达到 2 次上限', attempts, { text: 'x' }, 2)
    })
    const { storage, runtime } = setup({ execute }), flow = agentFlow()
    flow.nodes[1]!.config.verification = { minTextLength: 5 }
    const saved = storage.save(flow, 0), id = runtime.start(saved.id, { text: 'input' }).id, nodeId = flow.nodes[1]!.id
    const paused = await runtime.settle(id), record = paused.executions.find(item => item.nodeId === nodeId)!
    expect(paused.engine?.name).toBe('graphon')
    expect(paused.status).toBe('paused')
    expect(record).toMatchObject({ status: 'waiting', subagentId: 'original-action', repairTaskIds: ['output-repair-1', 'output-repair-2'], repair: { waiting: true, limit: 2, candidate: { text: 'x' }, attempts: [{ attempt: 1 }, { attempt: 2 }] } })
    expect(paused.usage).toMatchObject({ spentTokens: 17, reservedTokens: 0, unknownCalls: 0, calls: 3, agentTasks: 3 })
    expect(() => runtime.resume(id)).toThrow('先处理验证暂停')
    await expect(runtime.acceptRepairOutput(id, nodeId, { text: 42 })).rejects.toThrow('不符合结构')
    await expect(runtime.acceptRepairOutput(id, nodeId, { text: 'Valid length', unexpected: 'extra field' })).rejects.toThrow('不符合结构')
    await expect(runtime.acceptRepairOutput(id, nodeId, { text: 'x' })).rejects.toThrow('最小文本长度')
    expect(storage.run(id).executions.find(item => item.nodeId === nodeId)?.repair?.waiting).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    const resumed = await runtime.acceptRepairOutput(id, nodeId, { text: 'User-verified output' })
    expect(resumed.id).toBe(id)
    const done = await runtime.settle(id), accepted = done.executions.find(item => item.nodeId === nodeId)!
    expect(done.status).toBe('success'); expect(done.outputs.result).toBe('User-verified output')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(done.usage).toEqual(paused.usage)
    expect(accepted.repair).toMatchObject({ waiting: false, candidate: { text: 'x' }, limit: 2, attempts: record.repair!.attempts })
    expect(accepted.repair?.resolvedAt).toEqual(expect.any(String))
    expect(accepted.verification?.status).toBe('passed')
  })

  it('settles the one native task receipt across initial and supplemental reservations exactly once and deduplicates messages', async () => {
    const fixture = liveAdapter(), { storage, runtime } = setup(fixture.adapters), flow = agentFlow(200, 30)
    const saved = storage.save(flow, 0), run = runtime.start(saved.id, { text: 'input' }), request = await fixture.entered.promise
    const deliver = vi.fn((_authorization: { allocationId: string }) => ({ nativeMessageId: 'native-message-1' })), nodeId = flow.nodes[1]!.id
    const supplemented = await runtime.supplementAgent(run.id, nodeId, 'owned-task', 'More context', 'message_1', deliver)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ allocationId: expect.any(String) })
    expect(supplemented.executions.find(item => item.nodeId === nodeId)?.agentMessages).toMatchObject([{ id: 'message_1', taskId: 'owned-task', nativeMessageId: 'native-message-1', status: 'accepted' }])
    await runtime.supplementAgent(run.id, nodeId, 'owned-task', 'More context', 'message_1', deliver)
    expect(deliver).toHaveBeenCalledTimes(1)
    await expect(runtime.supplementAgent(run.id, nodeId, 'owned-task', 'different', 'message_1', deliver)).rejects.toThrow('消息身份')
    // Supplemental authorization keeps its reservation; the model output cap is independent.
    expect(request).not.toHaveProperty('tokenLimit')
    fixture.finish.resolve(65)
    const done = await runtime.settle(run.id)
    expect(done.status).toBe('success')
    expect(done.usage).toMatchObject({ spentTokens: 65, reservedTokens: 0, unknownTokens: 0, unknownCalls: 0, calls: 1, agentTasks: 1 })
    expect(Object.values(done.usage!.allocations).map(item => item.usage)).toEqual([65])
    expect(done.executions.find(item => item.nodeId === nodeId)?.tokenUsage).toBe(65)
    expect(fixture.execute).toHaveBeenCalledTimes(1)
  })

  it('delivers steering even when legacy limits would have exhausted the old balance', async () => {
    const fixture=liveAdapter(),{storage,runtime}=setup(fixture.adapters),flow=agentFlow(1,1)
    const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'input'})
    await fixture.entered.promise
    const deliver=vi.fn(()=>({nativeMessageId:'allowed-native-message'}))
    await runtime.supplementAgent(run.id,flow.nodes[1]!.id,'owned-task','More context','legacy_limit',deliver)
    expect(deliver).toHaveBeenCalledOnce()
    fixture.finish.resolve(20)
    const done=await runtime.settle(run.id)
    expect(done.status).toBe('success');expect(done.usage).toMatchObject({spentTokens:20,calls:1,agentTasks:1,reservedTokens:0})
  })

  it('retains both initial and supplemental reservations when the native cumulative usage is unknown', async () => {
    const fixture = liveAdapter(), { storage, runtime } = setup(fixture.adapters), flow = agentFlow(200, 40)
    const saved = storage.save(flow, 0), run = runtime.start(saved.id, { text: 'input' })
    await fixture.entered.promise
    await runtime.supplementAgent(run.id, flow.nodes[1]!.id, 'owned-task', 'Additional detail', 'unknown_usage', () => ({ nativeMessageId: 'unknown-native-message' }))
    fixture.finish.resolve(undefined)
    const done = await runtime.settle(run.id)
    expect(done.status).toBe('success')
    expect(done.usage).toMatchObject({ spentTokens: 0, reservedTokens: 0, unknownTokens: 0, unknownCalls: 1, calls: 1 })
    expect(done.executions.find(item => item.nodeId === flow.nodes[1]!.id)?.tokenUsage).toBeUndefined()
  })

  it('deduplicates simultaneous supplements atomically without tokenization or additional usage calls', async () => {
    const fixture=liveAdapter(),{storage,runtime}=setup(fixture.adapters),flow=agentFlow()
    const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'input'})
    await fixture.entered.promise
    const count=vi.spyOn(GraphonBridge.prototype,'countTokens'),deliver=vi.fn(()=>({nativeMessageId:'one-native-message'}))
    const submit=()=>runtime.supplementAgent(run.id,flow.nodes[1]!.id,'owned-task','Concurrent duplicate','same_message',deliver)
    await Promise.all([submit(),submit()])
    expect(deliver).toHaveBeenCalledOnce();expect(count).not.toHaveBeenCalled()
    fixture.finish.resolve(25)
    const done=await runtime.settle(run.id)
    expect(done.usage?.calls).toBe(1);expect(done.executions.find(item=>item.nodeId===flow.nodes[1]!.id)?.agentMessages).toHaveLength(1)
  })

  it('rejects steering after the exact original task has completed without new allocations', async () => {
    const fixture=liveAdapter(),{storage,runtime}=setup(fixture.adapters),flow=agentFlow()
    const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'input'})
    await fixture.entered.promise;fixture.finish.resolve(15)
    const done=await runtime.settle(run.id),deliver=vi.fn(()=>({nativeMessageId:'must-not-exist'}))
    await expect(runtime.supplementAgent(run.id,flow.nodes[1]!.id,'owned-task','Late context','late-completed',deliver)).rejects.toThrow('任务已结束')
    expect(deliver).not.toHaveBeenCalled();expect(done.usage).toMatchObject({spentTokens:15,calls:1,reservedTokens:0})
  })

  it('settles a rejected pre-delivery reservation at zero and preserves the final task total', async () => {
    const fixture = liveAdapter(), { storage, runtime } = setup(fixture.adapters), flow = agentFlow(200, 30)
    const saved = storage.save(flow, 0), run = runtime.start(saved.id, { text: 'input' })
    await fixture.entered.promise
    const deliver = vi.fn(() => { throw new Error('Native task already captured its result') })
    await expect(runtime.supplementAgent(run.id, flow.nodes[1]!.id, 'owned-task', 'Late instruction', 'late', deliver)).rejects.toThrow('already captured')
    await expect(runtime.supplementAgent(run.id, flow.nodes[1]!.id, 'owned-task', 'Late instruction', 'late', deliver)).rejects.toThrow('already captured')
    expect(deliver).toHaveBeenCalledTimes(1)
    fixture.finish.resolve(45)
    const done = await runtime.settle(run.id)
    expect(done.usage).toMatchObject({ spentTokens: 45, reservedTokens: 0, unknownCalls: 0, calls: 1 })
    expect(Object.values(done.usage!.allocations).map(item => item.usage)).toEqual([45])
    expect(done.executions.find(item => item.nodeId === flow.nodes[1]!.id)?.agentMessages).toMatchObject([{ id: 'late', status: 'rejected' }])
  })

  it('previews recovery without execution, rejects a stale plan, then reuses successful pure instances from the frozen source', async () => {
    let calls = 0
    const execute = vi.fn(async () => { if (++calls === 1) throw new Error('Explicit code-adapter fixture failure'); return { text: 'recovered result' } })
    const { storage, runtime } = setup({ execute }), flow = makeWorkflow('workspace', 'Recovery plan', true)
    const [input, template, output] = flow.nodes, code = { ...template!, id: newId(), number: 'a-3', title: 'Code fixture', kind: 'code' as const, config: { language: 'javascript' as const, code: 'function main(inputs) { return inputs }', inputs: { text: `{{${template!.id}.text}}` } } }
    output!.number = 'a-4'; output!.config.text = `{{${code.id}.text}}`
    flow.nodes = [input!, template!, code, output!]
    flow.edges = [{ id: newId(), source: input!.id, target: template!.id }, { id: newId(), source: template!.id, target: code.id }, { id: newId(), source: code.id, target: output!.id }]
    const saved = storage.save(flow, 0), source = await runtime.settle(runtime.start(saved.id, { text: 'old input' }).id)
    expect(source.status).toBe('failed')
    const plan = runtime.recoveryPlan(source.id)
    expect(plan.allowed).toBe(true)
    expect(plan.items.find(item => item.executionId === template!.id)).toMatchObject({ action: 'reuse', reason: expect.any(String) })
    expect(plan.items.find(item => item.executionId === code.id)).toMatchObject({ action: 'rerun', reason: expect.any(String) })
    expect(execute).toHaveBeenCalledTimes(1); expect(storage.runs()).toHaveLength(1)
    const changed = storage.run(source.id); changed.executions.find(item => item.nodeId === code.id)!.error = 'Updated failure diagnosis'; storage.saveRun(changed)
    expect(() => runtime.recover(source.id, 'resume', undefined, plan.planDigest)).toThrow('恢复预览已过期')
    expect(storage.runs()).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1)
    const current = storage.get(saved.id); current.nodes[1]!.config.text = 'Future revision only'; storage.save(current, current.revision)
    const fresh = runtime.recoveryPlan(source.id), recovered = runtime.recover(source.id, 'resume', undefined, fresh.planDigest), done = await runtime.settle(recovered.id)
    expect(done.status).toBe('success'); expect(done.id).not.toBe(source.id); expect(done.sourceRunId).toBe(source.id)
    expect(done.sourceRevision).toBe(source.sourceRevision); expect(done.outputs.result).toBe('recovered result')
    expect(done.executions.find(item => item.nodeId === template!.id)).toMatchObject({ reusedFromRunId: source.id, data: source.executions.find(item => item.nodeId === template!.id)!.data })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('shows an unconfirmed external action as blocked and never starts recovery from that plan', async () => {
    const execute = vi.fn(async (_kind: AdapterNodeKind, request: AdapterRequest) => { request.onTask?.('uncertain-action'); throw new Error('Receipt unavailable') })
    const { storage, runtime } = setup({ execute }), saved = storage.save(agentFlow(), 0)
    const source = await runtime.settle(runtime.start(saved.id, { text: 'input' }).id), plan = runtime.recoveryPlan(source.id)
    expect(source.status).toBe('failed'); expect(plan.allowed).toBe(false)
    expect(plan.items.find(item => item.nodeId === saved.nodes[1]!.id)).toMatchObject({ action: 'blocked', reason: expect.stringContaining('结果未确认') })
    expect(() => runtime.recover(source.id, 'resume', undefined, plan.planDigest)).toThrow('结果未确认')
    expect(execute).toHaveBeenCalledTimes(1); expect(storage.runs()).toHaveLength(1)
  })
})

describe('one cumulative receipt across usage allocations', () => {
  function ledger(): WorkflowRun { const graph = agentFlow(200, 30); return { id: 'ledger', workflowId: graph.id, workspaceId: graph.workspaceId, workflowTitle: graph.title, sourceRevision: 1, graph, status: 'running', inputs: {}, outputs: {}, executions: [], startedAt: new Date().toISOString() } }
  it('distributes known usage once and keeps unknown usage reserved as unknown rather than zero', () => {
    const run = ledger(), first = recordUsageCall(run, true), second = recordUsageCall(run, false)
    settleUsageGroup(run, [first.id, second.id], { totalTokens: 55 })
    settleUsageGroup(run, [first.id, second.id], { totalTokens: 55 })
    expect(run.usage).toMatchObject({ spentTokens: 55, reservedTokens: 0, unknownCalls: 1 })
    expect(run.usage!.allocations[first.id]?.usage).toBe(55); expect(run.usage!.allocations[second.id]?.status).toBe('unknown')
    const unknown = ledger(), a = recordUsageCall(unknown, true), b = recordUsageCall(unknown, false)
    settleUsageGroup(unknown, [a.id, b.id], undefined); settleUsageGroup(unknown, [a.id, b.id], undefined)
    expect(unknown.usage).toMatchObject({ spentTokens: 0, reservedTokens: 0, unknownTokens: 0, unknownCalls: 2 })
  })
  it('keeps a failed pre-delivery zero receipt out of later cumulative settlement without losing usage', () => {
    const run = ledger(), first = recordUsageCall(run, true), rejected = recordUsageCall(run, false)
    settleUsage(run, rejected.id, { totalTokens: 0 }); settleUsageGroup(run, [first.id, rejected.id], { totalTokens: 45 })
    expect(run.usage).toMatchObject({ spentTokens: 45, reservedTokens: 0, unknownCalls: 0 })
    expect(run.usage!.allocations[first.id]?.usage).toBe(45); expect(run.usage!.allocations[rejected.id]?.usage).toBe(0)
  })
  it('shares workspace capacity across root runs, allows another workspace, and removes cancelled waiters', async () => {
    const admission = new ModelAdmission(3, 1), signal = new AbortController(), waitingSignal = new AbortController()
    const releaseA = await admission.acquire('root-a', 3, signal.signal, 'workspace-a')
    let sameWorkspaceAdmitted = false
    const waitingA = admission.acquire('root-b', 3, waitingSignal.signal, 'workspace-a').then(release => { sameWorkspaceAdmitted = true; return release })
    const cancelled = expect(waitingA).rejects.toThrow('cancel queued root')
    const releaseB = await admission.acquire('root-c', 3, signal.signal, 'workspace-b')
    expect(sameWorkspaceAdmitted).toBe(false)
    waitingSignal.abort(new Error('cancel queued root')); await cancelled
    let replacementAdmitted = false
    const replacement = admission.acquire('root-d', 3, signal.signal, 'workspace-a').then(release => { replacementAdmitted = true; return release })
    await Promise.resolve(); expect(replacementAdmitted).toBe(false)
    releaseA()
    const releaseReplacement = await replacement
    expect(replacementAdmitted).toBe(true); expect(sameWorkspaceAdmitted).toBe(false)
    releaseReplacement(); releaseReplacement(); releaseB()
    const releaseFinal = await admission.acquire('root-e', 1, signal.signal, 'workspace-a'); releaseFinal()
  })
})
