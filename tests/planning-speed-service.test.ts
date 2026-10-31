import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowPlanningService, planningDigest, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import type { PlanningAgentInput, PlanningAgentResult } from '../src/host/planning/agent.ts'
import type { PlanningBackgroundRuntime } from '../src/host/planning/background.ts'
import type { PlanningRequest } from '../src/shared/planning-types.ts'
import { parsePlanningRequest } from '../src/shared/planning-schema.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { filling, templateContext } from './fixtures/planning-compiler/template.ts'
import type { ConversationEvidence } from '../src/shared/retrospective.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { sealRepairCheckpoint } from '../src/shared/planning-continuation.ts'
import { deduplicatedPlanningPrompt } from '../src/host/planning/prompt-layout.ts'
import { planningPayloadSummary } from '../src/host/planning/payload-summary.ts'
import { TEMPLATE_QUERY_GUIDANCE } from '../src/host/planning/template-catalog.ts'
import { tools as reviewTools } from './fixtures/t18-tools.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { planningEditView } from '../src/shared/planning-edits.ts'
import { arrangeNodes } from '../src/shared/canvas-layout.ts'
import type { NodeGraph } from '../src/shared/types.ts'

const services: WorkflowPlanningService[] = [], directories: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.close())); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const untilAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason) })
const ids = { input: 'a1e0d001-0000-4000-8000-000000000001', text: 'a1e0d001-0000-4000-8000-000000000002', output: 'a1e0d001-0000-4000-8000-000000000003' }
type Options = ConstructorParameters<typeof WorkflowPlanningService>[0]

function fixture(config: { run?: (input: PlanningAgentInput) => Promise<PlanningAgentResult>; runtime?: boolean; permission?: () => boolean; conversation?: ConversationEvidence; reviewModule?:boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'planning-speed-service-')); directories.push(directory)
  const parent = { id: 'parent-session', session: { id: 'parent-session' } } as unknown as Agent, call = new AbortController()
  const caller: PlanningCaller = { parent, sessionId: parent.id, workspaceId: 'workspace', signal: call.signal, modelSource: 'selection', modelSelection: { provider: 'fixture', model: 'no-model', reasoningEffort: 'max' } }
  const live = new Map([[parent.id, parent]]), disposed = new Set<(parent: Agent) => void>(), updates: PlanningTask[] = [], waiting = new Set<() => void>()
  const runtime: PlanningBackgroundRuntime = { isLive: agent => live.get(agent.id) === agent, withInitiator: (_parent, operation) => operation(), onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener) } } }
  const base = templateContext().workflow
  Object.assign(base, { id: 'flow', revision: 1, title: 'Existing graph' })
  base.nodes = [
    { id: ids.input, kind: 'input', title: 'Input', number: '1', fixed: false, x: 0, y: 0, config: { fields: [{ name: 'name', label: 'Name', required: true }] } },
    { id: ids.text, kind: 'template', title: 'Original title', number: '2', fixed: false, x: 200, y: 0, config: { text: 'Original text', inputs: { untouched: 'keep' } } },
    { id: ids.output, kind: 'output', title: 'Output', number: '3', fixed: false, x: 400, y: 0, config: { text: `{{${ids.text}.text}}`, outputName: 'result' } },
  ]
  base.edges = [{ id: 'entry', source: ids.input, target: ids.text }, { id: 'exit', source: ids.text, target: ids.output }]
  const receipts = new Map<string, PlanningReceipt>()
  const submit = (input: PlanningAgentInput, value: unknown): PlanningAgentResult => {
    if (!input.compiler) throw Error('Expected the real service submission compiler')
    input.beforeSubmission?.()
    const result = input.compiler.submit(value)
    if (!result.ok) throw Error('Fixture compiler rejection: ' + JSON.stringify(result.feedback))
    return { output: result.value, steps: 1, usage: { totalTokens: 12 } }
  }
  const generate = vi.fn(async (input: PlanningAgentInput): Promise<PlanningAgentResult> => {
    input.beforeStep?.(100, undefined, { turn: 1, step: 1 }); input.onTask?.('fixture-child')
    if (config.run) return config.run(input)
    return submit(input, { submission: { mode: 'edit', updates: { n2: { set: { text: 'Filled by fixture' } } }, coverage: { R1: ['n2'] } } })
  })
  const publish = vi.fn<Options['publish']>(async (candidate, task, _caller, commit) => {
    receipts.set(commit.key, { ...commit, workflowId: candidate.id, revision: task.request.operation === 'create' ? 1 : candidate.revision, kind: task.request.operation === 'create' ? 'created' : 'proposed', ...(task.request.operation === 'revise' ? { proposalId: 'proposal-1' } : {}) })
  })
  const context = vi.fn<Options['context']>(async (request, owner) => {
    const context = templateContext()
    if(config.reviewModule)context.tools=reviewTools()
    if (request.operation === 'revise') context.workflow = structuredClone(base)
    context.operation = request.operation; context.targetNodeIds = request.targetNodeIds ?? []
    context.model = { provider: owner.modelSelection!.provider, model: owner.modelSelection!.model }; context.effort = owner.modelSelection!.reasoningEffort
    if (config.conversation) context.conversation = config.conversation
    return context
  })
  const options: Options = {
    directory, compilerMode: 'compact-repair', admission: new ModelAdmission(2, 2), driver: { generate }, context,
    authorize: (task, owner) => { if (task.workspaceId !== owner.workspaceId || task.sessionId !== owner.sessionId || config.permission?.() === false) throw Error('FORBIDDEN: workspace/session permission revoked') },
    readiness: async candidate => ({ workflowId: candidate.id, revision: candidate.revision, canRun: true, issues: [] }), publish, receipt: key => receipts.get(key),
    onUpdate: task => { updates.push(task); for (const listener of waiting) listener() },
    ...(config.runtime === false ? {} : { backgroundRuntime: runtime }),
  }
  const reopen = () => { const service = new WorkflowPlanningService(options); services.push(service); return service }
  const service = reopen()
  const freshCaller = () => ({ ...caller, signal: new AbortController().signal })
  const waitFor = (id: string, predicate: (task: PlanningTask) => boolean) => {
    const latest = () => updates.findLast(task => task.id === id && predicate(task))
    if (latest()) return Promise.resolve(latest()!)
    return new Promise<PlanningTask>(resolve => { const listener = () => { const task = latest(); if (task) { waiting.delete(listener); resolve(task) } }; waiting.add(listener) })
  }
  const dispose = () => { live.delete(parent.id); for (const listener of disposed) listener(parent) }
  return { service, options, reopen, freshCaller, caller, call, parent, live, disposed, updates, waitFor, directory, base, generate, publish, context, submit, dispose, receipts }
}
const revise = (changes: Partial<PlanningRequest> = {}): PlanningRequest => ({ requestId: 'speed-request', operation: 'revise', instruction: 'Update the greeting', targetWorkflowId: 'flow', expectedRevision: 1, ...changes })
const direct = (): PlanningRequest => revise({ handoff: { version: 1, mode: 'edit', changes: [{ op: 'set-config', nodeId: ids.text, field: 'text', value: 'Direct greeting' }], constraints: ['Preserve unrelated fields'], evidenceRefs: ['user-choice'] } })
const partial = (): PlanningRequest => revise({ handoff: { version: 1, mode: 'partial', changes: [{ op: 'set-title', nodeId: ids.text, value: 'Already decided title' }], unresolved: [{ nodeId: ids.text, fields: ['text'], question: 'Fill only this greeting' }], constraints: ['Keep decided title'], evidenceRefs: ['user-choice'] } })
const moduleRequest = (): PlanningRequest => ({ requestId: 'module-request', operation: 'create', instruction: 'Render the selected structured columns', handoff: { version: 1, mode: 'module', constraints: [], evidenceRefs: ['explicit-columns'], module: { moduleId: 'structured-result-table', version: '1.0.0', instanceKey: 'report', parameters: { title: 'Result table', columns: [{ key: 'name', label: 'Name' }], emptyText: 'No rows' } } } })
const clarification = { submission: { mode: 'needs-input', questions: [{ id: 'format', question: 'Confirm the greeting format', options: ['Text', 'JSON'] }], summary: 'Await the real user answer' } }

describe('background human questions and retained compiler checkpoints', () => {
  it('refuses the activation cleanup window and publishes manual readiness for synchronous compatibility',async()=>{
    let f!:ReturnType<typeof fixture>,refusal:Promise<unknown>|undefined,settling:any
    f=fixture({run:async input=>f.submit(input,clarification)})
    const observe=f.options.onUpdate!
    f.options.onUpdate=task=>{observe(task);if(task.state==='awaiting_input'&&f.service.isActive(task.id,f.freshCaller())){
      settling=f.service.inputState(task)
      refusal=expect(f.service.answer(task.id,task.revision,[{questionId:'format',answer:'Text'}],f.freshCaller())).rejects.toMatchObject({code:'PLANNING_ANSWER_ACTIVATION_ACTIVE',retryable:false,nextAction:'wait-for-task-state'})
    }}
    const waiting=await f.service.start(partial(),f.caller);await refusal
    expect(settling).toMatchObject({mode:'settling',manualAnswerAllowed:false})
    expect(f.service.inputState(waiting)).toMatchObject({mode:'manual',revision:waiting.revision,manualAnswerAllowed:true})
    expect(waiting.answers).toEqual([]);expect(waiting.answeredQuestions).toBeUndefined();expect(f.generate).toHaveBeenCalledOnce()
  })

  it('restores a persisted native-pending batch as manual without replaying the old provider',async()=>{
    let f!:ReturnType<typeof fixture>
    const asked=deferred<void>()
    f=fixture({run:async input=>f.submit(input,clarification)})
    f.options.askQuestions=async(_task,caller)=>{asked.resolve();return untilAbort(caller.signal)}
    const accepted=await f.service.start(partial(),f.caller,{background:true});await asked.promise
    expect(f.service.inputState(f.service.get(accepted.id,f.freshCaller()))?.mode).toBe('native-pending')
    // Read the exact persisted crash boundary into another service; the old live
    // service stays isolated and is cancelled after the recovery observations.
    const recovered=f.reopen(),waiting=recovered.get(accepted.id,f.freshCaller())
    expect(recovered.inputState(waiting)).toMatchObject({mode:'manual',manualAnswerAllowed:true,nativeQuestionPending:false})
    expect(waiting.state).toBe('awaiting_input');expect(waiting.answers).toEqual([]);expect(f.generate).toHaveBeenCalledOnce()
    await recovered.close();await f.service.cancel(accepted.id,f.freshCaller())
  })

  it('marks native ownership before the first awaiting event and refuses both exact and guessed manual revisions',async()=>{
    let f!:ReturnType<typeof fixture>
    const asked=deferred<PlanningTask>(),answer=deferred<{questionId:string;answer:string}[]>(),routes:any[]=[]
    f=fixture({run:async input=>f.submit(input,clarification)})
    const observe=f.options.onUpdate!
    f.options.onUpdate=task=>{observe(task);if(task.state==='awaiting_input')routes.push(f.service.inputState(task))}
    f.options.askQuestions=async task=>{asked.resolve(task);return answer.promise}
    const accepted=await f.service.start(partial(),f.caller,{background:true}),question=await asked.promise
    expect(routes[0]).toMatchObject({mode:'native-pending',revision:question.revision,nativeQuestionPending:true,manualAnswerAllowed:false})
    for(const revision of [question.revision,question.revision+1])await expect(f.service.answer(accepted.id,revision,[{questionId:'format',answer:'Text'}],f.freshCaller())).rejects.toMatchObject({code:'PLANNING_NATIVE_QUESTION_PENDING',retryable:false,nextAction:'wait-for-host-question'})
    expect(f.service.get(accepted.id,f.freshCaller()).answeredQuestions).toBeUndefined()
    // A native provider error is a failed task, never an unavailable-UI fallback.
    answer.resolve([{questionId:'wrong',answer:'Text'}]);await f.waitFor(accepted.id,t=>t.state==='failed')
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it('publishes a fresh manual-ready event only after native-unavailable activation releases, and restart never revives pending',async()=>{
    let f!:ReturnType<typeof fixture>
    const fallback=deferred<undefined>(),asked=deferred<void>(),routes:any[]=[]
    f=fixture({run:async input=>f.submit(input,clarification)})
    const observe=f.options.onUpdate!
    f.options.onUpdate=task=>{observe(task);if(task.state==='awaiting_input')routes.push({task,route:f.service.inputState(task),active:f.service.isActive(task.id,f.freshCaller())})}
    f.options.askQuestions=async()=>{asked.resolve();return fallback.promise}
    const accepted=await f.service.start(partial(),f.caller,{background:true});await asked.promise
    const native=f.service.get(accepted.id,f.freshCaller());fallback.resolve(undefined)
    await (f.service as any).active.get(accepted.id)?.done
    const waiting=f.service.get(accepted.id,f.freshCaller())
    expect(waiting.revision).toBeGreaterThan(native.revision)
    expect(routes.at(-1)).toMatchObject({active:false,route:{mode:'manual',revision:waiting.revision,manualAnswerAllowed:true}})
    await f.service.close();const reopened=f.reopen(),restored=reopened.get(accepted.id,f.freshCaller())
    expect(reopened.inputState(restored)).toMatchObject({mode:'manual',manualAnswerAllowed:true,nativeQuestionPending:false})
    expect(f.generate).toHaveBeenCalledOnce();expect(restored.answers).toEqual([])
  })

  it('keeps provider failures distinct from unavailable native UI and does not apply answers',async()=>{
    let f!:ReturnType<typeof fixture>
    f=fixture({run:async input=>f.submit(input,clarification)})
    f.options.askQuestions=async()=>{throw new Error('native delivery provider failed')}
    const accepted=await f.service.start(partial(),f.caller,{background:true}),failed=await f.waitFor(accepted.id,t=>t.state==='failed')
    expect(failed.diagnostics.at(-1)?.message).toContain('native delivery provider failed')
    expect(f.service.inputState(failed)).toBeUndefined();expect(failed.answeredQuestions).toBeUndefined();expect(failed.answers).toEqual([])
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it('rejects persisted answer bindings from another task or mismatched flat answers',async()=>{
    let f!:ReturnType<typeof fixture>,calls=0
    f=fixture({run:async input=>++calls===1?f.submit(input,clarification):f.submit(input,{submission:{mode:'edit',updates:{n2:{set:{text:'Selected text'}}},coverage:{R1:['n2']}}})})
    const waiting=await f.service.start(partial(),f.caller),completed=await f.service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'Text'}],f.freshCaller())
    await f.service.close()
    const path=join(f.directory,'planning','tasks.json'),original=JSON.parse(readFileSync(path,'utf8'))
    for(const mutate of [(row:any)=>row.answeredQuestions[0].taskId='other-task',(row:any)=>row.answeredQuestions[0].questions[0].answer='unbound']){
      const stored=structuredClone(original);mutate(stored.tasks.find((t:any)=>t.id===completed.id));writeFileSync(path,JSON.stringify(stored))
      expect(()=>f.reopen()).toThrow(/真人回答批次/)
    }
    // Historical optional-field absence is accepted without inventing bindings.
    const legacy=structuredClone(original);delete legacy.tasks[0].answeredQuestions;writeFileSync(path,JSON.stringify(legacy))
    const restored=f.reopen().get(completed.id,f.freshCaller());expect(restored.answers).toEqual(completed.answers);expect(restored.answeredQuestions).toBeUndefined()
  })

  it.each(['native','manual','restart-manual'] as const)('binds repeated question IDs to original same-task human batches on no-draft %s continuation',async route=>{
    let f!:ReturnType<typeof fixture>,calls=0
    const prompts:any[]=[],request=partial()
    request.instruction='On the first attempt ask a human; then use their choice. Do not execute business actions.'
    f=fixture({run:async input=>{
      prompts.push(JSON.parse(input.prompt))
      if(++calls<=2)return f.submit(input,{submission:{mode:'needs-input',questions:[{id:'choice',question:calls===1?'Select greeting style':'Select a separate suffix',options:calls===1?['Text','JSON']:['Short','Long']} ]}})
      return f.submit(input,{submission:{mode:'edit',updates:{n2:{set:{text:'Selected text'}}},coverage:{R1:['n2']}}})
    }})
    if(route==='native')f.options.askQuestions=async task=>[{questionId:'choice',answer:task.questionRounds===1?'Text':'Short'}]
    let service=f.service,task=await service.start(request,f.caller,{background: true})
    if(route==='native'){
      task=await f.waitFor(task.id,t=>t.state==='published')
    }else for(const answer of ['Text','Short']){
      await (service as any).active.get(task.id)?.done
      if(route==='restart-manual'){await service.close();service=f.reopen()}
      const waiting=service.get(task.id,f.freshCaller())
      task=await service.answer(task.id,waiting.revision,[{questionId:'choice',answer}],f.freshCaller())
      await expect(service.answer(task.id,waiting.revision,[{questionId:'choice',answer}],f.freshCaller())).rejects.toMatchObject({code:'PLANNING_NOT_AWAITING_INPUT',retryable:false})
    }
    await (service as any).active.get(task.id)?.done;task=service.get(task.id,f.freshCaller())
    expect(task.state).toBe('published');expect(task.request).toEqual(request);expect(calls).toBe(3)
    expect(task.answeredQuestions?.map(b=>({taskId:b.taskId,question:b.questions[0]?.question,options:b.questions[0]?.options,answer:b.questions[0]?.answer}))).toEqual([
      {taskId:task.id,question:'Select greeting style',options:['Text','JSON'],answer:'Text'},
      {taskId:task.id,question:'Select a separate suffix',options:['Short','Long'],answer:'Short'},
    ])
    expect(task.answeredQuestions![0]!.revision).toBeLessThan(task.answeredQuestions![1]!.revision)
    expect(prompts[1].humanAnswerContext).toMatchObject({phase:'resumed-after-human-answer',taskId:task.id,batches:[{taskId:task.id,questions:[{id:'choice',question:'Select greeting style',answer:'Text'}]}]})
    expect(prompts[2].humanAnswerContext.batches).toHaveLength(2)
    expect(prompts.every(p=>p.requirement.text===request.instruction||p.handoff)).toBe(true)
    await expect(service.answer(task.id,task.revision,[{questionId:'choice',answer:'Too late'}],f.freshCaller())).rejects.toMatchObject({code:'PLANNING_NOT_AWAITING_INPUT',retryable:false})
    expect(service.get(task.id,f.freshCaller()).answeredQuestions).toEqual(task.answeredQuestions)
    await service.close();const reopened=f.reopen();expect(reopened.get(task.id,f.freshCaller()).answeredQuestions).toEqual(task.answeredQuestions)
  })

  it('keeps the same batch manually answerable when native question UI is unavailable', async () => {
    let f!: ReturnType<typeof fixture>, calls = 0
    f = fixture({ run: async input => ++calls === 1 ? f.submit(input, clarification) : f.submit(input, { submission: { mode: 'edit', updates: { n2: { set: { text: 'Confirmed greeting' } } }, coverage: { R1: ['n2'] } } }) })
    f.options.askQuestions = async () => undefined
    const accepted = await f.service.start(partial(), f.caller, { background: true })
    await (f.service as any).active.get(accepted.id)?.done
    const waiting = f.service.get(accepted.id, f.freshCaller())
    expect(waiting.state).toBe('awaiting_input'); expect(waiting.answers).toEqual([])
    await f.service.answer(waiting.id, waiting.revision, [{ questionId: 'format', answer: 'Text' }], f.freshCaller())
    await (f.service as any).active.get(accepted.id)?.done
    expect(f.service.get(accepted.id, f.freshCaller()).state).toBe('published')
    expect(f.generate).toHaveBeenCalledTimes(2)
  })

  it.each(['exhausted', 'inflated'] as const)('does not launch a new model for a %s continuation allowance', async condition => {
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => {
      const wire = filling(); wire.submission.forms[1].values.text = 42
      expect(input.compiler!.submit(wire).ok).toBe(false)
      if (condition === 'exhausted') {
        input.beforeStep?.(100, undefined, { turn: 1, step: 2 })
        expect(input.compiler!.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/formsByKey/greet/values/text', value: true }] } }).ok).toBe(false)
      }
      input.beforeStep?.(100, undefined, { turn: 1, step: condition === 'exhausted' ? 3 : 2 })
      return f.submit(input, clarification)
    } })
    f.options.compilerMode = 'template-fill'
    const accepted = await f.service.start({ requestId: 'continuation-allowance', operation: 'create', instruction: 'Keep the greeting contract' }, f.caller, { background: true })
    await (f.service as any).active.get(accepted.id)?.done
    const waiting = f.service.get(accepted.id, f.freshCaller())
    expect(waiting.state).toBe('awaiting_input')
    if (condition === 'inflated') {
      const stored = (f.service as any).tasks.get(accepted.id)
      const { digest: _digest, ...checkpoint } = stored.compilerDraft.checkpoint
      stored.compilerDraft.checkpoint = sealRepairCheckpoint({ ...checkpoint, maxSubmissions: 4 })
    }
    await f.service.answer(waiting.id, waiting.revision, [{ questionId: 'format', answer: 'Text' }], f.freshCaller())
    await (f.service as any).active.get(accepted.id)?.done
    const stopped = f.service.get(accepted.id, f.freshCaller())
    expect(stopped.diagnostics.some(issue => issue.code === (condition === 'exhausted' ? 'PLANNING_REPAIR_LIMIT' : 'COMPILER_RESUME_CONFLICT'))).toBe(true)
    expect(stopped.compilerDraft?.checkpoint?.document).toBeDefined()
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
  })

  it('returns before the native question answer, keeps its question state, and resumes only the same task unresolved fields', async () => {
    const asked = deferred<PlanningTask>(), answer = deferred<{ questionId: string; answer: string }[]>()
    let f!: ReturnType<typeof fixture>, calls = 0
    f = fixture({ run: async input => ++calls === 1 ? f.submit(input, clarification) : f.submit(input, { submission: { mode: 'edit', updates: { n2: { set: { text: 'Human chose Text' } } }, coverage: { R1: ['n2'] } } }) })
    const ask = vi.fn<NonNullable<Options['askQuestions']>>(async (task, caller) => { asked.resolve(task); return Promise.race([answer.promise, untilAbort(caller.signal)]) })
    f.options.askQuestions = ask
    const accepted = await f.service.start(partial(), f.caller, { background: true })
    expect(accepted.state).toBe('queued'); expect(accepted.output).toBeUndefined()
    const question = await asked.promise
    expect(question.id).toBe(accepted.id); expect(question.state).toBe('awaiting_input'); expect(question.answers).toEqual([])
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
    expect(f.service.get(accepted.id, f.freshCaller()).output?.questions).toEqual(clarification.submission.questions)
    answer.resolve([{ questionId: 'format', answer: 'Text' }])
    const completed = await f.waitFor(accepted.id, task => task.state === 'published')
    expect(completed.id).toBe(accepted.id); expect(completed.answers).toEqual([{ questionId: 'format', answer: 'Text' }])
    expect(completed.candidate!.nodes.find(node => node.id === ids.text)).toMatchObject({ title: 'Already decided title', config: { text: 'Human chose Text', inputs: { untouched: 'keep' } } })
    expect(f.context).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledTimes(2); expect(ask).toHaveBeenCalledOnce()
    expect(JSON.parse(f.generate.mock.calls[1]![0].prompt).handoff.unresolved).toEqual(partial().handoff!.mode === 'partial' ? (partial().handoff as any).unresolved : [])
  })

  it('cancellation while the native question is open never applies a late answer or starts another child', async () => {
    const asked = deferred<void>(), answer = deferred<{ questionId: string; answer: string }[]>()
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => f.submit(input, clarification) })
    f.options.askQuestions = async (_task, caller) => { asked.resolve(); return Promise.race([answer.promise, untilAbort(caller.signal)]) }
    const accepted = await f.service.start(partial(), f.caller, { background: true }); await asked.promise
    const cancelled = await f.service.cancel(accepted.id, f.freshCaller())
    expect(cancelled.state).toBe('cancelled'); expect(cancelled.answers).toEqual([]);expect(cancelled.answeredQuestions).toBeUndefined()
    answer.resolve([{ questionId: 'format', answer: 'Too late' }]); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled(); expect(f.service.get(accepted.id, f.freshCaller()).state).toBe('cancelled')
  })

  it.each([
    { answers: [] }, { answers: [{ questionId: 'other-batch', answer: 'Text' }] }, { answers: [{ questionId: 'format', answer: 'Text' }, { questionId: 'format', answer: 'duplicate' }] }, { answers: [{ questionId: 'format', answer: ' ' }] },
  ])('rejects malformed or mismatched native answers without continuation (%j)', async ({ answers }) => {
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => f.submit(input, clarification) }); f.options.askQuestions = async () => answers
    const accepted = await f.service.start(partial(), f.caller, { background: true })
    const rejected = await f.waitFor(accepted.id, task => task.state === 'failed')
    expect(rejected.answers).toEqual([]);expect(rejected.answeredQuestions).toBeUndefined(); expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
  })

  it('rechecks current workspace authority after receiving a human answer', async () => {
    const asked = deferred<void>(), answer = deferred<{ questionId: string; answer: string }[]>(); let authorized = true
    let f!: ReturnType<typeof fixture>
    f = fixture({ permission: () => authorized, run: async input => f.submit(input, clarification) })
    f.options.askQuestions = async () => { asked.resolve(); return answer.promise }
    const accepted = await f.service.start(partial(), f.caller, { background: true }); await asked.promise
    authorized = false; answer.resolve([{ questionId: 'format', answer: 'Text' }])
    const rejected = await f.waitFor(accepted.id, task => task.state === 'blocked')
    expect(rejected.answers).toEqual([]);expect(rejected.answeredQuestions).toBeUndefined(); expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
  })

  it('rejects a stale native question batch revision before applying its answer', async () => {
    const asked = deferred<void>(), answer = deferred<{ questionId: string; answer: string }[]>()
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => f.submit(input, clarification) }); f.options.askQuestions = async () => { asked.resolve(); return answer.promise }
    const accepted = await f.service.start(partial(), f.caller, { background: true }); await asked.promise
    // Fault injection models an independently updated batch, rather than a model
    // being allowed to alter the live task or its question revision.
    ;(f.service as any).tasks.get(accepted.id).revision++
    answer.resolve([{ questionId: 'format', answer: 'Text' }])
    const rejected = await f.waitFor(accepted.id, task => ['failed', 'conflict'].includes(task.state))
    expect(rejected.diagnostics.at(-1)?.message).toContain('过期回答'); expect(rejected.answers).toEqual([])
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
  })

  it('manual answer compatibility rejects foreign owners, stale revisions and mismatched question identities', async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => f.submit(input, clarification) })
    const accepted = await f.service.start(partial(), f.caller, { background: true })
    await f.waitFor(accepted.id, task => task.state === 'awaiting_input')
    await (f.service as any).active.get(accepted.id)?.done
    const waiting=f.service.get(accepted.id,f.freshCaller())
    const answers = [{ questionId: 'format', answer: 'Text' }]
    await expect(f.service.answer(waiting.id, waiting.revision, answers, { ...f.freshCaller(), workspaceId: 'foreign' })).rejects.toThrow('当前主对话')
    await expect(f.service.answer(waiting.id, waiting.revision - 1, answers, f.freshCaller())).rejects.toThrow('问题批次已变化')
    await expect(f.service.answer(waiting.id, waiting.revision, [{ questionId: 'other-batch', answer: 'Text' }], f.freshCaller())).rejects.toThrow('身份无效')
    expect(f.service.get(waiting.id, f.freshCaller()).answers).toEqual([]); expect(f.generate).toHaveBeenCalledOnce()
  })

  it.each(['native-answer', 'restart-then-manual-answer'] as const)('retains failed draft through clarification and resumes only repair under the same checkpoint (%s)', async mode => {
    const asked = deferred<PlanningTask>(), answer = deferred<{ questionId: string; answer: string }[]>(); let calls = 0
    let f!: ReturnType<typeof fixture>, paused: any
    f = fixture({ run: async input => {
      if (++calls === 1) {
        const wire = filling(); wire.submission.forms[1].values.text = 42
        const bad = input.compiler!.submit(wire); expect(bad.ok).toBe(false)
        input.beforeStep?.(100, undefined, { turn: 1, step: 2 })
        const result = f.submit(input, clarification); paused = input.compiler!.checkpoint!()
        expect(paused).toMatchObject({ state: 'clarification', revision: 1, submissions: 2, maxSubmissions: 3 })
        return result
      }
      const prompt = JSON.parse(input.prompt)
      expect(Object.keys(prompt).sort()).toEqual(['answers', 'continuation', 'humanAnswerContext', 'instruction', 'requirement'])
      expect(prompt.humanAnswerContext).toMatchObject({phase:'resumed-after-human-answer',batches:[{questions:[{id:'format',question:'Confirm the greeting format',options:['Text','JSON'],answer:'Text'}]}]})
      expect(prompt.requirement).toEqual({ id: 'R1', text: 'Finish the greeting after the human answers' })
      expect(prompt.continuation).toMatchObject({ hasDraft: true, kind: 'draft-repair', draftRevision: 1, submissions: 2, remainingSubmissions: 1 })
      expect(prompt.continuation.unresolved).toContain('/formsByKey/greet/values/text')
      expect(prompt.continuation.scope).toBe(paused.scope); expect(prompt.answers).toEqual([{ questionId: 'format', answer: 'Text' }])
      return f.submit(input, { submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/formsByKey/greet/values/text', value: 'Human greeting {{input.name}}' }] } })
    } })
    f.options.compilerMode = 'template-fill'
    if (mode === 'native-answer') f.options.askQuestions = async (task, caller) => { asked.resolve(task); return Promise.race([answer.promise, untilAbort(caller.signal)]) }
    const accepted = await f.service.start({ requestId: 'retained-draft-question', operation: 'create', instruction: 'Finish the greeting after the human answers' }, f.caller, { background: true })
    const waiting = mode === 'native-answer' ? await asked.promise : await f.waitFor(accepted.id, task => task.state === 'awaiting_input')
    expect(waiting.compilerDraft?.checkpoint?.scope).toBe(JSON.stringify(['workspace', 'parent-session', accepted.id, 'author']))
    expect(waiting.compilerDraft?.checkpoint?.document).toEqual(paused.document)
    if (mode === 'native-answer') answer.resolve([{ questionId: 'format', answer: 'Text' }])
    else {
      await (f.service as any).active.get(waiting.id)?.done; await f.service.close()
      const restarted = f.reopen(), restored = restarted.get(waiting.id, f.freshCaller())
      expect(restored.compilerDraft?.checkpoint).toEqual(paused)
      await restarted.answer(restored.id, restored.revision, [{ questionId: 'format', answer: 'Text' }], f.freshCaller())
    }
    const completed = await f.waitFor(accepted.id, task => task.state === 'published')
    expect(completed.id).toBe(accepted.id); expect(completed.childAttempts).toBe(2); expect(completed.candidateAttempts).toBe(2)
    expect(completed.compilerDraft?.checkpoint).toMatchObject({ state: 'accepted', submissions: 3, maxSubmissions: 3 })
    expect((completed.compilerDraft!.document as any).formsByKey.start).toEqual(paused.document.formsByKey.start)
    expect(completed.candidate!.nodes.find(node => node.kind === 'template')!.config.text).toBe('Human greeting {{input.name}}')
    expect(f.context).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledTimes(2); expect(f.publish).toHaveBeenCalledOnce()
  })
})

describe('planning speed routes through the real service', () => {
  it('compiles determined edits with zero child/model calls and preserves the original proposal receipt path', async () => {
    const f = fixture(), before = structuredClone(f.base), task = await f.service.start(direct(), f.caller)
    expect(task.state, JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.receipt).toMatchObject({ kind: 'proposed', proposalId: 'proposal-1', workflowId: 'flow' })
    expect(task.childAttempts).toBe(0); expect(task.steps).toBe(0); expect(f.generate).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenCalledOnce()
    expect(task.candidate!.nodes.find(node => node.id === ids.text)).toMatchObject({ title: 'Original title', config: { text: 'Direct greeting', inputs: { untouched: 'keep' } } })
    expect(task.candidate!.nodes.filter(node => node.id !== ids.text)).toEqual(before.nodes.filter(node => node.id !== ids.text))
    expect(task.candidate!.edges).toEqual(before.edges); expect(f.base).toEqual(before)
    const duplicate = await f.service.start(direct(), f.caller)
    expect(duplicate.id).toBe(task.id); expect(duplicate.receipt).toEqual(task.receipt); expect(f.publish).toHaveBeenCalledOnce()
  })

  it('instantiates pinned module parameters with zero planning calls and records provenance plus a created receipt', async () => {
    const f = fixture(), task = await f.service.start(moduleRequest(), f.caller)
    expect(task.state, JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.receipt?.kind).toBe('created'); expect(task.moduleProvenance).toMatchObject({ moduleId: 'structured-result-table', version: '1.0.0', instanceKey: 'report' })
    expect(task.candidate!.nodes).toHaveLength(3); expect(f.generate).not.toHaveBeenCalled(); expect(task.childAttempts).toBe(0)
    expect(task.candidate!.nodes).toEqual(arrangeNodes(task.candidate!))
    expect(task.candidateDigest).toBe(planningDigest(task.candidate))
    expect(task.receipt!.digest).toBe(task.candidateDigest)
    expect(f.publish.mock.calls[0]![0].nodes).toEqual(task.candidate!.nodes)
    expect(task.candidate!.nodes.find(node => node.kind === 'code')!.config.inputs).toMatchObject({ specification: { title: 'Result table' } })
  })

  const reviewRequest=():PlanningRequest=>({requestId:'review-module',operation:'create',instruction:'审核后写文件',handoff:{version:1,mode:'module',module:{moduleId:'reviewed-file-write',version:'1.0.0',instanceKey:'report',parameters:{target:'report.txt',producer:{text:'正文 {{reviewBase}}{{reviewNote}}'},maxIterations:3}},constraints:[],evidenceRefs:[]}})
  it('runs a module the create entry instantiated once after saving, and no other module create (Desktop r59 D)',async()=>{
    const f=fixture({reviewModule:true});f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    const task=await f.service.start({...reviewRequest(),runAfterSave:true},f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.childAttempts).toBe(0)
    expect(task.firstRun).toEqual({requestId:`trial-first-${task.id}`,status:'recorded',runId:'run-first'})
    await f.service.close();const again=f.reopen()
    expect(again.get(task.id,f.freshCaller()).firstRun).toEqual(task.firstRun)
    const plain=await again.start({...reviewRequest(),requestId:'review-plain'},f.freshCaller())
    expect(plain.state,JSON.stringify(plain.diagnostics)).toBe('published');expect(plain.firstRun).toBeUndefined()
    expect(f.options.runCreated).toHaveBeenCalledOnce()
    expect(()=>parsePlanningRequest({...reviewRequest(),operation:'revise',targetWorkflowId:'w',expectedRevision:1,runAfterSave:true})).toThrow('保存后运行一次')
  })
  it('creates, restores and revises a reviewed-file module without any planner/driver calls',async()=>{
    const f=fixture({reviewModule:true}),created=await f.service.start(reviewRequest(),f.caller)
    expect(created.state,JSON.stringify(created.diagnostics)).toBe('published')
    expect(created.receipt?.kind).toBe('created');expect(created.childAttempts).toBe(0)
    expect(created.moduleProvenance!.nodeIds).toHaveLength(22)
    const arranged=(graph:NodeGraph):void=>{expect(graph.nodes).toEqual(arrangeNodes(graph));for(const node of graph.nodes)if(node.config.body)arranged(node.config.body)}
    arranged(created.candidate!)
    expect(created.candidateDigest).toBe(planningDigest(created.candidate))
    expect(created.receipt!.digest).toBe(created.candidateDigest)
    expect(f.publish.mock.calls[0]![0]).toEqual(created.candidate)
    await f.service.close()
    const restored=f.reopen()
    expect(restored.get(created.id,f.freshCaller()).state).toBe('published')
    const current={...structuredClone(created.candidate!),revision:1}
    f.options.context=async request=>({...templateContext(),tools:reviewTools(),workflow:structuredClone(current),operation:request.operation,targetNodeIds:[],model:{provider:'fixture',model:'no-model'},effort:'max'})
    const updatedService=f.reopen(),input=reviewRequest()
    if(input.handoff?.mode!=='module'||input.handoff.module.moduleId!=='reviewed-file-write')throw Error('fixture')
    input.handoff.module.parameters.producer.text='新正文 {{reviewBase}}{{reviewNote}}'
    const updated=await updatedService.start({...input,requestId:'review-update',operation:'revise',targetWorkflowId:current.id,expectedRevision:1},f.freshCaller())
    expect(updated.state,JSON.stringify(updated.diagnostics)).toBe('published');expect(updated.receipt?.kind).toBe('proposed')
    expect(updated.moduleProvenance!.implementationDigest).toBe(created.moduleProvenance!.implementationDigest)
    expect(updated.moduleProvenance!.nodeIds).toEqual(created.moduleProvenance!.nodeIds)
    expect(allNodes(updated.candidate!).map(({id,x,y})=>({id,x,y}))).toEqual(allNodes(created.candidate!).map(({id,x,y})=>({id,x,y})))
    expect(allNodes(updated.candidate!).find(node=>node.title==='produce')!.config.text).toBe('新正文 {{reviewBase}}{{reviewNote}}')
    await updatedService.close();expect(f.reopen().get(updated.id,f.freshCaller()).state).toBe('published')
    expect(f.generate).not.toHaveBeenCalled();expect(updated.childAttempts).toBe(0)
    expect(updated.context!.effort).toBe('max')
  })
  it.each(['body','provenance'])('blocks a restored review module with tampered %s despite an updated candidate digest',async field=>{
    const f=fixture({reviewModule:true}),created=await f.service.start(reviewRequest(),f.caller)
    expect(created.state,JSON.stringify(created.diagnostics)).toBe('published');await f.service.close()
    const path=join(f.directory,'planning','tasks.json'),stored=JSON.parse(readFileSync(path,'utf8')),held=stored.tasks.find((task:any)=>task.id===created.id)
    if(field==='body')allNodes(held.candidate).find(node=>node.title==='commit')!.config.inputs!.content='bypass'
    else held.moduleProvenance.nodeIds.pop()
    held.candidateDigest=planningDigest(held.candidate)
    held.state='ready';delete held.commit;delete held.receipt
    writeFileSync(path,JSON.stringify(stored))
    const restored=f.reopen().get(created.id,f.freshCaller())
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')).toBe(true)
    expect(f.generate).not.toHaveBeenCalled();expect(f.publish).toHaveBeenCalledOnce()
  })
  it('still delegates extra business topology outside the module to the existing revise sub-agent',async()=>{
    let current:PlanningTask['candidate']
    const f=fixture({reviewModule:true,run:async input=>{
      const view=planningEditView({...templateContext(),workflow:current!,operation:'revise'})
      const key=(title:string)=>'n'+view.nodes.find(row=>row.title===title)!.ref.slice(1)
      return f.submit(input,{submission:{mode:'edit',addNodes:[{key:'extra',kind:'template',title:'额外业务',config:{text:'独立业务节点'}}],removeLinks:[{source:key('wasApproved'),target:key('success'),port:'true'}],addLinks:[{key:'business',source:key('wasApproved'),target:'extra',port:'true'},{key:'finish',source:'extra',target:key('success')}],coverage:{R1:['extra']}}})
    }})
    const created=await f.service.start(reviewRequest(),f.caller)
    expect(created.state).toBe('published');expect(f.generate).not.toHaveBeenCalled()
    current={...structuredClone(created.candidate!),revision:1}
    const before=structuredClone(current.nodes.find(node=>node.kind==='loop'))
    f.options.context=async request=>({...templateContext(),tools:reviewTools(),workflow:structuredClone(current!),operation:request.operation,targetNodeIds:[],model:{provider:'fixture',model:'no-model'},effort:'max'})
    const service=f.reopen(),updated=await service.start({requestId:'extra-business',operation:'revise',instruction:'保留审核写入模块，仅在通过分支添加额外业务模板',targetWorkflowId:current.id,expectedRevision:1},f.freshCaller())
    expect(updated.state,JSON.stringify(updated.diagnostics)).toBe('published')
    expect(f.generate).toHaveBeenCalledOnce();expect(updated.candidate!.nodes.find(node=>node.title==='额外业务')).toBeDefined()
    expect(updated.candidate!.nodes.find(node=>node.kind==='loop')).toEqual(before)
  })

  it('passes only unresolved fields to the compiler while preserving prior decisions through publication', async () => {
    const f = fixture(), task = await f.service.start(partial(), f.caller)
    expect(task.state, JSON.stringify(task.diagnostics)).toBe('published')
    expect(f.generate).toHaveBeenCalledOnce(); expect(task.childAttempts).toBe(1)
    const prompt = JSON.parse(f.generate.mock.calls[0]![0].prompt)
    expect(prompt.handoff.unresolved).toEqual([{ nodeId: ids.text, fields: ['text'], question: 'Fill only this greeting' }])
    expect(prompt.graph.nodes.find((node: any) => node.key === 'n2')).toMatchObject({ title: 'Already decided title', config: { text: 'Original text' } })
    expect(task.candidate!.nodes.find(node => node.id === ids.text)).toMatchObject({ title: 'Already decided title', config: { text: 'Filled by fixture', inputs: { untouched: 'keep' } } })
    expect(task.candidate!.edges).toEqual(f.base.edges)
    expect(f.reopen().get(task.id, f.caller).candidateDigest).toBe(task.candidateDigest)
  })

  it('updates a trusted module instance using parameters only, without another planning child', async()=>{
    const f=fixture(),original=moduleRequest(),created=await f.service.start(original,f.caller)
    expect(created.state).toBe('published')
    const current={...structuredClone(created.candidate!),revision:1}
    f.options.context=async request=>({...templateContext(),workflow:structuredClone(current),operation:request.operation,targetNodeIds:request.targetNodeIds??[],model:{provider:'fixture',model:'no-model'},effort:'max'})
    const input=moduleRequest();if(input.handoff?.mode!=='module')throw Error('module fixture')
    input.handoff.module.parameters.title='Changed parameter'
    const updated=await f.service.start({...input,requestId:'module-update',operation:'revise',targetWorkflowId:current.id,expectedRevision:1},f.caller)
    expect(updated.state,JSON.stringify(updated.diagnostics)).toBe('published')
    expect(updated.receipt?.kind).toBe('proposed');expect(f.generate).not.toHaveBeenCalled()
    expect(updated.candidate!.nodes.find(node=>node.kind==='code')!.config.code).toBe(current.nodes.find(node=>node.kind==='code')!.config.code)
    expect(updated.candidate!.nodes.find(node=>node.kind==='code')!.config.inputs!.specification).toMatchObject({title:'Changed parameter'})
    expect(updated.moduleProvenance!.implementationDigest).toBe(created.moduleProvenance!.implementationDigest)
  })

  it('rejects a model attempt to roll back a decided field without falling back to full replanning', async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => f.submit(input, { submission: { mode: 'edit', updates: { n2: { title: 'Model reversed the decision', set: { text: 'allowed text' } } }, coverage: { R1: ['n2'] } } }) })
    const task = await f.service.start(partial(), f.caller)
    expect(['failed', 'blocked', 'conflict']).toContain(task.state); expect(f.generate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled()
    expect(task.candidate).toBeUndefined(); expect(f.base.nodes[1]!.title).toBe('Original title')
  })

  it('rechecks authority before publishing a direct edit and never invokes a fallback model', async () => {
    let allowed = true
    const f = fixture({ permission: () => allowed })
    f.options.readiness = async candidate => { allowed = false; return { workflowId: candidate.id, revision: candidate.revision, canRun: true, issues: [] } }
    const task = await f.service.start(direct(), f.caller)
    expect(task.state).toBe('blocked'); expect(f.publish).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled()
  })
})

describe('planning background service acceptance, persistence and lifecycle', () => {
  it('returns the same active identity promptly, survives call abort and emits completion once', async () => {
    const gate = deferred<void>(), begun = deferred<void>()
    let f!: ReturnType<typeof fixture>
    f = fixture({ run: async input => { begun.resolve(); await Promise.race([gate.promise, untilAbort(input.signal)]); input.signal.throwIfAborted(); return f.submit(input, { submission: { mode: 'edit', updates: { n2: { set: { text: 'Completed after acceptance' } } }, coverage: { R1: ['n2'] } } }) } })
    const accepted = await f.service.start(revise(), f.caller, { background: true })
    expect(accepted.state).toBe('queued'); expect(accepted.delivery?.mode).toBe('background'); expect(accepted.receipt).toBeUndefined()
    await begun.promise
    const duplicate = await f.service.start(revise(), f.freshCaller(), { background: true })
    expect(duplicate.id).toBe(accepted.id); expect(f.generate).toHaveBeenCalledOnce()
    f.call.abort(new Error('tool call ended'))
    gate.resolve()
    const completed = await f.waitFor(accepted.id, task => task.state === 'published')
    expect(completed.receipt?.kind).toBe('proposed'); expect(f.generate).toHaveBeenCalledOnce()
    expect(f.updates.filter(task => task.id === accepted.id && task.state === 'published')).toHaveLength(1)
  })

  it('rejects requestId conflicts and cross-workspace reads while an original background task remains active', async () => {
    const begun = deferred<void>(), f = fixture({ run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(revise(), f.caller, { background: true }); await begun.promise
    await expect(f.service.start(revise({ instruction: 'Conflicting request' }), f.freshCaller(), { background: true })).rejects.toThrow('REQUEST_ID_CONFLICT')
    expect(() => f.service.get(accepted.id, { ...f.freshCaller(), workspaceId: 'other' })).toThrow()
    expect((await f.service.cancel(accepted.id, f.freshCaller())).state).toBe('cancelled'); expect(f.generate).toHaveBeenCalledOnce()
  })

  it('cancels on exact parent disposal and releases its lifecycle observer', async () => {
    const begun = deferred<void>(), f = fixture({ run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(revise(), f.caller, { background: true }); await begun.promise
    f.dispose()
    const cancelled = await f.waitFor(accepted.id, task => task.state === 'cancelled')
    expect(cancelled.diagnostics.at(-1)?.message).toContain('主对话 Agent 已关闭')
    await f.service.close(); expect(f.disposed.size).toBe(0)
  })

  it('cancels a queued task without starting its child or disrupting the running task', async () => {
    const begun = deferred<void>(), f = fixture({ run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const running = await f.service.start(revise(), f.caller, { background: true }); await begun.promise
    const queued = await f.service.start(revise({ requestId: 'queued-request' }), f.freshCaller(), { background: true })
    expect((await f.service.cancel(queued.id, f.freshCaller())).state).toBe('cancelled')
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.service.get(running.id, f.freshCaller()).state).toBe('authoring')
    expect((await f.service.cancel(running.id, f.freshCaller())).state).toBe('cancelled')
  })

  it('retains timeout classification and partial accounting under the background deadline', async () => {
    vi.useFakeTimers()
    const begun = deferred<void>(), f = fixture({ run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(revise(), f.caller, { background: true }); await begun.promise
    await vi.advanceTimersByTimeAsync(1_200_000)
    const failed = await f.waitFor(accepted.id, task => task.state === 'failed')
    expect(failed.diagnostics.at(-1)?.code).toBe('PLANNING_DEADLINE_EXCEEDED')
    expect(failed.unknownUsageCalls).toBe(1); expect(failed.pendingUsageCalls).toBe(0); expect(f.publish).not.toHaveBeenCalled()
  })

  it('Host close drains in-flight work and never reports a generated or published candidate', async () => {
    const begun = deferred<void>(), f = fixture({ run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const accepted = await f.service.start(revise(), f.caller, { background: true }); await begun.promise
    await f.service.close()
    const task = f.service.get(accepted.id, f.freshCaller())
    expect(['cancelled', 'interrupted']).toContain(task.state); expect(task.candidate).toBeUndefined(); expect(f.publish).not.toHaveBeenCalled(); expect(f.disposed.size).toBe(0)
    await expect(f.service.start(revise({ requestId: 'after-close' }), f.freshCaller(), { background: true })).rejects.toThrow('Host 已关闭')
  })

  it('ordinary preview persists only a compact acceptance envelope; restart retains ID, interrupts and never replays source/history', async () => {
    const value: Omit<ConversationEvidence, 'digest'> = { version: 1, sessionId: 'parent-session', fromSeq: 1, throughSeq: 2, records: [
      { id: 'e1', seq: 1, kind: 'user', text: 'PRIVATE-SOURCE-HISTORY-DO-NOT-PERSIST', status: 'statement', truncated: false },
      { id: 'e2', seq: 2, kind: 'assistant', text: 'PRIVATE-ASSISTANT-HISTORY-DO-NOT-PERSIST', status: 'statement', truncated: false },
    ], warnings: [] }
    const conversation = { ...value, digest: conversationEvidenceDigest(value) }
    const begun = deferred<void>(), f = fixture({ conversation, run: async input => { begun.resolve(); return untilAbort(input.signal) } })
    const request: PlanningRequest = { requestId: 'preview-source-request', operation: 'create', preview: true, instruction: 'PRIVATE-PREVIEW-TEXT-DO-NOT-PERSIST', source: { kind: 'current-conversation', fromSeq: 1, throughSeq: 2 } }
    const accepted = await f.service.start(request, f.caller, { background: true }); await begun.promise
    const path = join(f.directory, 'planning', 'background.json'), raw = readFileSync(path, 'utf8'), envelope = JSON.parse(raw).tasks[0]
    expect(raw).not.toContain(request.instruction); expect(envelope).toMatchObject({ id: accepted.id, taskId: accepted.id, requestId: request.requestId, sessionId: f.caller.sessionId, workspaceId: f.caller.workspaceId })
    expect(raw).not.toContain('PRIVATE-SOURCE-HISTORY'); expect(raw).not.toContain('PRIVATE-ASSISTANT-HISTORY')
    for (const field of ['request', 'source', 'context', 'history', 'candidate', 'prompt']) expect(envelope).not.toHaveProperty(field)
    const taskPath = join(f.directory, 'planning', 'tasks.json')
    expect(existsSync(taskPath) ? JSON.parse(readFileSync(taskPath, 'utf8')).tasks : []).toEqual([])
    await f.service.close()
    const restarted = f.reopen(), recovered = restarted.get(accepted.id, f.freshCaller())
    expect(recovered).toMatchObject({ id: accepted.id, state: 'interrupted', preview: true, delivery: { recovered: true } })
    expect(recovered.request.instruction).not.toContain(request.instruction); expect(recovered.context).toBeUndefined()
    const same = await restarted.start(request, f.freshCaller(), { background: true })
    expect(same.id).toBe(accepted.id); expect(same.state).toBe('interrupted'); expect(f.generate).toHaveBeenCalledOnce()
    await expect(restarted.start({ ...request, instruction: 'changed after restart' }, f.freshCaller(), { background: true })).rejects.toThrow('REQUEST_ID_CONFLICT')
  })

  it('does not require a background runtime for synchronous determined work', async () => {
    const f = fixture({ runtime: false })
    expect((await f.service.start(direct(), f.caller)).state).toBe('published')
    await expect(f.service.start(revise({ requestId: 'background-without-runtime' }), f.caller, { background: true })).rejects.toThrow('受管理的后台任务生命周期')
    expect(f.generate).not.toHaveBeenCalled()
  })
})

const explicitPartial=(requirement:'changed'|'present'='changed'):PlanningRequest=>{
  const value=partial()
  if(value.handoff?.mode!=='partial')throw Error('Expected partial')
  return {...value,handoff:{...value.handoff,version:2,completion:[{nodeId:ids.text,field:'text',require:requirement}]}}
}

describe('service explicit completion authority and publication',()=>{
  it('deduplicates the full initial payload after no-draft clarification without losing the answer or resetting allowance',async()=>{
    let f!:ReturnType<typeof fixture>,calls=0
    const summaries:ReturnType<typeof planningPayloadSummary>[]=[],prompts:any[]=[]
    f=fixture({run:async input=>{
      const continuation=input.compiler!.continuation?.()
      expect(input.promptContractSource).toBe('host-template-initial-v1')
      expect(JSON.stringify(input.compiler!.schema)).not.toContain('complete-field')
      const admitted=deduplicatedPlanningPrompt(input.prompt,input.promptContractSource,input.compiler!.instructions,TEMPLATE_QUERY_GUIDANCE)
      const parsed=JSON.parse(admitted);prompts.push(parsed)
      expect(parsed).not.toHaveProperty('continuation')
      expect(parsed.handoff.completion).toEqual((explicitPartial().handoff as any).completion)
      const system=input.compiler!.instructions+'\n'+TEMPLATE_QUERY_GUIDANCE
      summaries.push(planningPayloadSummary({provider:'fixture',model:'no-model',messages:[{role:'system',content:[{type:'text',text:system}]},{role:'user',content:[{type:'text',text:admitted}]}]},admitted,{rules:input.compiler!.instructions,templateAccess:TEMPLATE_QUERY_GUIDANCE}))
      if(++calls===1){expect(continuation).toBeUndefined();return f.submit(input,clarification)}
      expect(continuation).toMatchObject({kind:'initial-clarification',hasDraft:false,submissions:1,remainingSubmissions:2})
      expect(parsed.answers).toEqual([{questionId:'format',answer:'Human selected greeting'}])
      return f.submit(input,{submission:{mode:'edit',updates:{n2:{values:{text:'Human selected greeting'}}},coverage:{R1:['n2']}}})
    }})
    f.options.compilerMode='template-fill'
    const waiting=await f.service.start(explicitPartial(),f.caller)
    expect(waiting.state).toBe('awaiting_input');expect(waiting.compilerDraft?.checkpoint).not.toHaveProperty('document')
    const completed=await f.service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'Human selected greeting'}],f.freshCaller())
    expect(completed.id).toBe(waiting.id);expect(completed.state).toBe('published')
    expect(completed.compilerDraft?.checkpoint).toMatchObject({submissions:2,maxSubmissions:3})
    expect(completed.candidate!.nodes[1]).toMatchObject({title:'Already decided title',config:{text:'Human selected greeting',inputs:{untouched:'keep'}}})
    expect(f.context).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledTimes(2)
    expect(prompts[0].answers).toEqual([])
    expect(summaries.map(s=>[s.compilerRulesCopies,s.templateAccessCopies])).toEqual([[1,1],[1,1]])
    expect(summaries[1]!.prompt.sharedPrefixDigest).toBe(summaries[0]!.prompt.sharedPrefixDigest)
  })

  it.each(['compact-repair','template-fill'] as const)('retains v2 %s obligations through a real compiler draft → question → answer → local repair',async mode=>{
    let f!:ReturnType<typeof fixture>,calls=0
    const container=mode==='template-fill'?'values':'set'
    f=fixture({run:async input=>{
      if(++calls===1){
        input.beforeSubmission?.()
        const failure=input.compiler!.submit(mode==='template-fill'?{submission:{mode:'edit',updates:{n2:{values:{text:'Original text'}}},coverage:{R1:['n2']}}}:{submission:{mode:'edit',updates:{},coverage:{R1:['n2']}}})
        expect(failure.ok).toBe(false)
        if(!failure.ok)expect(failure.feedback.allowedPaths).toEqual([mode==='template-fill'?'/updates/n2/values/text':'/updates/n2'])
        input.beforeStep?.(100,undefined,{turn:1,step:2})
        return f.submit(input,{submission:{mode:'needs-input',questions:[{id:'choice',question:'Choose the greeting'}]}})
      }
      const prompt=JSON.parse(input.prompt)
      expect(prompt.handoff.completion).toEqual((explicitPartial().handoff as any).completion)
      expect(prompt.continuation).toMatchObject({hasDraft:true,submissions:2,remainingSubmissions:1})
      expect(prompt.continuation.unresolved).toEqual([mode==='template-fill'?'/updates/n2/values/text':'/updates/n2'])
      expect(input.promptContractSource).toBeUndefined()
      return f.submit(input,{submission:{mode:'repair',draftRevision:1,patches:[mode==='template-fill'?{op:'replace',path:'/updates/n2/values/text',value:'Human selected greeting'}:{op:'add',path:'/updates/n2',value:{[container]:{text:'Human selected greeting'}}}]}})
    }})
    f.options.compilerMode=mode
    const waiting=await f.service.start(explicitPartial(),f.caller)
    expect(waiting.state).toBe('awaiting_input');expect(f.publish).not.toHaveBeenCalled()
    const completed=await f.service.answer(waiting.id,waiting.revision,[{questionId:'choice',answer:'Human selected greeting'}],f.freshCaller())
    expect(completed.state).toBe('published');expect(completed.compilerDraft?.checkpoint).toMatchObject({submissions:3,maxSubmissions:3})
    expect(completed.candidate!.nodes[1]).toMatchObject({title:'Already decided title',config:{text:'Human selected greeting',inputs:{untouched:'keep'}}})
    expect(f.generate).toHaveBeenCalledTimes(2);expect(f.context).toHaveBeenCalledOnce();expect(f.publish).toHaveBeenCalledOnce()
    const duplicate=await f.service.start(explicitPartial(),f.freshCaller());expect(duplicate.id).toBe(completed.id)
    expect(f.generate).toHaveBeenCalledTimes(2);expect(f.publish).toHaveBeenCalledOnce()
  })
  it.each([1,2] as const)('preserves v%s no-op semantics for v1 and explicit present including persisted receipt replay',async version=>{
    let f!:ReturnType<typeof fixture>
    f=fixture({run:async input=>f.submit(input,{submission:{mode:'edit',updates:{},coverage:{R1:['n2']}}})})
    const request=version===1?partial():explicitPartial('present'),completed=await f.service.start(request,f.caller)
    expect(completed.state).toBe('published');expect(completed.candidate!.nodes[1]!.config.text).toBe('Original text')
    await f.service.close()
    const reopened=f.reopen(),historical=reopened.get(completed.id,f.freshCaller())
    expect(historical.state).toBe('published');expect(historical.receipt).toEqual(completed.receipt)
    expect((await reopened.start(request,f.freshCaller())).id).toBe(completed.id)
    expect(f.generate).toHaveBeenCalledOnce();expect(f.publish).toHaveBeenCalledOnce()
  })
  it('keeps determined v1 no-op edits and duplicate request receipts free of child calls',async()=>{
    const f=fixture(),request=direct()
    if(request.handoff?.mode!=='edit')throw Error('edit expected')
    request.handoff.changes=[{op:'set-config',nodeId:ids.text,field:'text',value:'Original text'}]
    const completed=await f.service.start(request,f.caller)
    expect(completed.state).toBe('published');expect(completed.candidate!.nodes[1]!.config.text).toBe('Original text')
    expect((await f.service.start(request,f.freshCaller())).receipt).toEqual(completed.receipt)
    expect(f.generate).not.toHaveBeenCalled();expect(f.publish).toHaveBeenCalledOnce()
  })
  it('rejects completion scope/contract claims before a child invocation and never upgrades a read selection into permission',async()=>{
    for(const condition of ['scope','fixed','field'] as const){
      const f=fixture(),request=explicitPartial()
      if(condition==='scope')request.targetNodeIds=[ids.output]
      else if(condition==='fixed')f.base.nodes[1]!.fixed=true
      else if(request.handoff?.version===2){request.handoff.unresolved[0]!.fields=['unknown'];request.handoff.completion[0]!.field='unknown'}
      const rejected=await f.service.start(request,f.caller)
      expect(['failed','blocked','conflict']).toContain(rejected.state);expect(f.generate).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
    }
  })
  it('rechecks the original completion baseline at publication even when a candidate has a matching new digest',async()=>{
    const f=fixture(),ready=await f.service.start({...explicitPartial(),preview:true},f.caller)
    expect(ready.state).toBe('ready');expect(f.publish).not.toHaveBeenCalled()
    const held=(f.service as any).tasks.get(ready.id) as PlanningTask
    held.candidate!.nodes[1]!.config.text='Original text';held.candidateDigest=planningDigest(held.candidate)
    const rejected=await f.service.publish(held.id,held.revision,held.candidateDigest,f.freshCaller())
    expect(rejected.state).toBe('failed');expect(rejected.diagnostics.some(issue=>issue.message.includes('显式完成义务'))).toBe(true)
    expect(f.publish).not.toHaveBeenCalled();expect(f.generate).toHaveBeenCalledOnce()
  })
  it('blocks a restored incomplete uncommitted v2 candidate without invoking a child or publisher',async()=>{
    const f=fixture(),completed=await f.service.start(explicitPartial(),f.caller)
    expect(completed.state).toBe('published');await f.service.close()
    const path=join(f.directory,'planning','tasks.json'),stored=JSON.parse(readFileSync(path,'utf8')),held=stored.tasks.find((task:any)=>task.id===completed.id)
    held.candidate.nodes[1].config.text='Original text';held.candidateDigest=planningDigest(held.candidate)
    held.state='ready';delete held.commit;delete held.receipt
    writeFileSync(path,JSON.stringify(stored))
    const reopened=f.reopen(),restored=reopened.get(completed.id,f.freshCaller())
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')).toBe(true)
    expect(restored.receipt).toBeUndefined();expect(f.generate).toHaveBeenCalledOnce();expect(f.publish).toHaveBeenCalledOnce()
  })
})
