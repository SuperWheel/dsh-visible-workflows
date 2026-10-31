import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workflow, WorkflowNode } from '../src/shared/types.ts'
import type { PlanningContext, PlanningRequest } from '../src/shared/planning-types.ts'
import type { ConversationEvidence, TaskProcedure } from '../src/shared/retrospective.ts'
import { exportWorkflowJson, parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { WorkflowPlanningService, planningDigest, type PlanningCaller } from '../src/host/planning/service.ts'
import type { PlanningAgentInput } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { fixturePlanningEdits, fixturePlanningPrompt, fixtureSubmit } from './fixtures/planning-edits.ts'
import { arrangeNodes } from '../src/shared/canvas-layout.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean() })
const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode => ({
  id, kind, config, title: id, number: id, x: 10, y: 20, fixed: false,
})
function flow(): Workflow {
  return {
    id: 'edit-flow', workspaceId: 'workspace', title: '可信标题', description: '不得随优化重写', revision: 3,
    createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', notes: [],
    nodes: [node('start', 'input', { fields: [{ name: 'name', label: '姓名', type: 'text', required: true }] }), node('work', 'template', { text: '你好 {{input.name}}' }), node('out', 'output', { text: '{{work.text}}', outputName: 'result' })],
    edges: [{ id: 's-w', source: 'start', target: 'work' }, { id: 'w-o', source: 'work', target: 'out' }],
    executionPolicy: { tokenBudget: 99 }, budgetDecision: { mode: 'limited', decidedAt: '2026-10-18T00:00:00.000Z' },
    editor: { viewport: { x: 30, y: 40, scale: 0.9 }, annotations: [{ id: 'note', number: 1, nodeIds: ['work'], text: '保留批注' }] },
    environmentVariables: [{ id: 'credential', name: 'API_KEY', type: 'secret', required: true, revision: 2 }],
  }
}
const baselines=new WeakMap<PlanningAgentInput,Workflow>()
type View = { nodes: { title: string; ref: string; config:any }[]; [key:string]:any }
const view = (input: PlanningAgentInput): View => {
  const prompt=JSON.parse(input.prompt)
  if(input.purpose==='optimize')return prompt
  const baseline=baselines.get(input)!,rows=input.graphContext??baseline.nodes.map((node,index)=>({...node,key:node.kind==='input'?'start':node.kind==='output'?'result':'n'+(index+1)}))
  return {...prompt,nodes:rows.map((node:any)=>({...node,ref:node.key}))}
}
const ref = (input: PlanningAgentInput, id: string): string => view(input).nodes.find(item => item.title === id)!.ref
function patch(input: PlanningAgentInput, edits: any[], coverage = ['work']):any {
  const key=(value:string)=>value.startsWith('+')?value.slice(1):value
  const rewrite=(value:any):any=>typeof value==='string'?value.replace(/\{\{\+/g,'{{'):Array.isArray(value)?value.map(rewrite):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)])):value
  const submission:any={mode:'edit',updates:{},addNodes:[],removeNodes:[],addLinks:[],removeLinks:[],summary:'局部修改，Host 组装',coverage:{R1:coverage.map(id=>id.startsWith('+')?key(id):ref(input,id))}}
  for(const [index,edit] of edits.entries()){
    if(edit.op==='update-node')submission.updates[key(edit.node)]={...(edit.kind?{kind:edit.kind}:{}),...(edit.configSet?{set:rewrite(edit.configSet)}:{}),...(edit.configUnset?{unset:edit.configUnset}:{}),...(edit.title?{title:edit.title}:{})}
    else if(edit.op==='add-node')submission.addNodes.push({key:edit.key,kind:edit.kind,title:edit.title,config:rewrite(edit.config),...(edit.scope?{scope:edit.scope.map(key)}:{})})
    else if(edit.op==='remove-node')submission.removeNodes.push(key(edit.node))
    else if(edit.op==='connect')submission.addLinks.push({key:'link'+index,source:key(edit.source),target:key(edit.target),...(edit.port?{port:edit.port}:{})})
    else if(edit.op==='disconnect')submission.removeLinks.push({source:key(edit.source),target:key(edit.target),...(edit.port?{port:edit.port}:{})})
    else if(edit.op==='update-environment')submission.updateEnvironment={[edit.variable.replace('@e','e')]:{value:edit.value}}
    else throw Error('Unknown fixture change')
  }
  if(view(input).operation==='create'){
    if(edits.length)throw Error('CREATE fixture supplies complete nodes')
    const graph=fixturePlanningPrompt(input,baselines.get(input)).graph
    const value:any={outcome:'candidate',graphJson:JSON.stringify(graph),summary:submission.summary,assumptions:[],questions:[],requirementCoverage:Object.entries(submission.coverage).map(([requirementId,nodeIds])=>({requirementId,nodeIds}))}
    return {fixtureProjection:value}
  }
  return {submission}
}
function evidence(): ConversationEvidence {
  const source: Omit<ConversationEvidence, 'digest'> = { version: 1, sessionId: 'root', fromSeq: 1, throughSeq: 3, warnings: [], records: [
    { id: 'e1', seq: 1, kind: 'user', text: '生成固定格式问候，保留人工检查', status: 'statement', truncated: false },
    { id: 'e2', seq: 2, kind: 'tool-call', text: '{"name":"Ada"}', status: 'reported-success', truncated: false, callId: 'done', toolName: 'completed-example' },
    { id: 'e3', seq: 3, kind: 'tool-result', text: '{"text":"你好 Ada"}', status: 'reported-success', truncated: false, callId: 'done', toolName: 'completed-example' },
  ] }
  return { ...source, digest: conversationEvidenceDigest(source) }
}
const procedure: TaskProcedure = { goal: '生成固定问候', parameters: [{ name: 'name', description: '姓名' }], rules: ['保持人工确认'],
  steps: [{ id: 'S1', title: '生成问候', instruction: '输出你好加姓名', dependsOn: [], evidenceRefs: ['e1', 'e2', 'e3'], requiresReview: true }], excluded: [], reviewItems: ['确认问候格式'],
}
type Run = (input: PlanningAgentInput, attempt: number) => unknown | Promise<unknown>
function fixture(config: { baseline?: Workflow; run: Run; conversation?: ConversationEvidence } ) {
  const directory = mkdtempSync(join(tmpdir(), 'planning-edits-integration-')), baseline = parseWorkflow(config.baseline ?? flow())
  const caller: PlanningCaller = { parent: { id: 'root' } as Agent, sessionId: 'root', workspaceId: 'workspace', signal: new AbortController().signal }
  const receipts = new Map<string, PlanningReceipt>(), services: WorkflowPlanningService[] = []
  let attempts = 0
  const generate = vi.fn(async (input: PlanningAgentInput) => {
    input.onTask?.(`edit-child-${++attempts}`); input.beforeStep?.(50, undefined)
    baselines.set(input,baseline)
    const value:any=await config.run(input,attempts)
    const output=value.fixtureProjection?fixturePlanningEdits(input,value.fixtureProjection,baseline):value.submission?fixtureSubmit(input,value):fixturePlanningEdits(input,value,baseline)
    return {output,steps:1,usage:{totalTokens:200}}
  })
  const options: ConstructorParameters<typeof WorkflowPlanningService>[0] = {
    directory, driver: { generate }, admission: new ModelAdmission(2, 2),
    context: async (request): Promise<PlanningContext> => ({ workflow:request.operation==='create'?{...structuredClone(baseline),revision:0,editor:{...baseline.editor,annotations:[]},nodes:structuredClone([baseline.nodes[0]!,baseline.nodes.at(-1)!]),edges:[{id:'scaffold',source:baseline.nodes[0]!.id,target:baseline.nodes.at(-1)!.id}]}:structuredClone(baseline), operation: request.operation, targetNodeIds: request.targetNodeIds ?? [],
      nodeIds: [...baseline.nodes.slice(1,-1).map(node=>node.id),'allocated-one', 'allocated-two', 'allocated-three', 'allocated-four'], subagentIds: ['allocated-agent'], environmentIds: ['allocated-env'],
      tools: [], model: { provider: 'offline', model: 'fixture' }, ...(config.conversation ? { conversation: config.conversation } : {}),
    }),
    authorize: (task, owner) => { if (task.workspaceId !== owner.workspaceId || task.sessionId !== owner.sessionId) throw new Error('权限错误') },
    readiness: async candidate => ({ workflowId: candidate.id, revision: candidate.revision, canRun: true, issues: [] }),
    publish: vi.fn(async (candidate, task, _caller, commit) => { receipts.set(commit.key, { ...commit, workflowId: candidate.id, revision: candidate.revision,
      kind: task.request.operation === 'create' ? 'created' : 'proposed', ...(task.request.operation === 'revise' ? { proposalId: 'local-proposal' } : {}) }) }),
    receipt: key => receipts.get(key),
  }
  const open = () => { const service = new WorkflowPlanningService(options); services.push(service); return service }, service = open()
  cleanups.push(async () => { await Promise.all(services.map(item => item.close())); rmSync(directory, { recursive: true, force: true }) })
  const request = (changes: Partial<PlanningRequest> = {}): PlanningRequest => ({ requestId: 'edit-test', operation: 'revise', instruction: '改进问候，保留其他内容', targetWorkflowId: baseline.id, expectedRevision: baseline.revision, preview: true, ...changes })
  return { service, open, caller, options, generate, baseline, directory, request }
}

describe('local edit intents through the planning service and current JSON', () => {
  it('assembles standard Workflow, preserves authority/Secret declarations, and publishes a canonical receipt', async () => {
    const f = fixture({ run: input => patch(input, [{ op: 'update-node', node: ref(input, 'work'), configSet: { text: '欢迎 {{input.name}}' } }]) })
    const original = structuredClone(f.baseline), task = await f.service.start(f.request(), f.caller)
    expect(task.state).toBe('ready'); expect(task.candidate!.nodes[1]!.config.text).toBe('欢迎 {{input.name}}')
    for (const key of ['id', 'workspaceId', 'revision', 'createdAt', 'executionPolicy', 'budgetDecision', 'editor', 'environmentVariables'] as const) expect(task.candidate![key]).toEqual(original[key])
    expect(f.baseline).toEqual(original); expect(existsSync(join(f.directory, 'planning/tasks.json'))).toBe(false)
    expect(task.output).toHaveProperty('graphJson'); expect(task.output).not.toHaveProperty('edits')
    expect(parseWorkflowPackage(exportWorkflowJson(task.candidate!)).formatVersion).toBe(2)
    const published = await f.service.publish(task.id, task.revision, task.candidateDigest!, f.caller)
    expect(published.state).toBe('published'); expect(published.receipt?.kind).toBe('proposed')
    const persisted = JSON.parse(readFileSync(join(f.directory, 'planning/tasks.json'), 'utf8')).tasks[0]
    expect(persisted.output.graphJson).toBeTruthy(); expect(persisted.output.edits).toBeUndefined()
    const count = f.generate.mock.calls.length, restored = f.open().get(task.id, f.caller)
    expect(restored.state).toBe('published'); expect(restored.candidateDigest).toBe(task.candidateDigest)
    expect(f.generate).toHaveBeenCalledTimes(count)
  })

  it('allocates aliases, rewires only exact reference tokens and maps coverage to stable identities', async () => {
    const f = fixture({ run: input => patch(input, [
      { op: 'add-node', key: 'copy', kind: 'template', title: '复制', config: { text: `literal @1 +copy; {{${ref(input, 'work')}.text}}` } },
      { op: 'disconnect', source: ref(input, 'work'), target: ref(input, 'out') },
      { op: 'connect', source: ref(input, 'work'), target: '+copy' },
      { op: 'connect', source: '+copy', target: ref(input, 'out') },
      { op: 'update-node', node: ref(input, 'out'), configSet: { text: '{{+copy.text}}' } },
    ], ['+copy']) })
    const task = await f.service.start(f.request(), f.caller)
    expect(task.state).toBe('ready')
    const added = task.candidate!.nodes.find(item => !f.baseline.nodes.some(old => old.id === item.id))!
    expect(added.id).toBe('allocated-one'); expect(added.config.text).toBe('literal @1 +copy; {{work.text}}')
    expect(task.candidate!.nodes.find(item => item.id === 'out')!.config.text).toBe('{{allocated-one.text}}')
    expect(task.output!.requirementCoverage[0]!.nodeIds).toEqual([added.id])
    expect(task.candidateDigest).toBe(planningDigest(task.candidate))
  })

  it('does not reinterpret literal business-map values whose keys resemble structural selectors', async () => {
    const f = fixture({ run: input => patch(input, [{ op: 'update-node', node: ref(input, 'work'), configSet: {
      inputs: { variable: '@1', subagentId: 'literal-agent', secretVariableId: 'literal-secret', code: `{{${ref(input, 'start')}.name}}` },
      text: '{{variable}} {{subagentId}} {{secretVariableId}} {{code}}',
    } }]) })
    const task = await f.service.start(f.request(), f.caller)
    expect(task.state).toBe('ready')
    expect(task.candidate!.nodes[1]!.config.inputs).toEqual({ variable: '@1', subagentId: 'literal-agent', secretVariableId: 'literal-secret', code: '{{start.name}}' })
  })

  it('infers nested update scope without moving or dropping the container',async()=>{
    const baseline=flow()
    baseline.nodes[1]=node('work','loop',{maxIterations:1,body:{nodes:[node('inner-start','input',{fields:[]}),node('inner-work','template',{text:'before'}),node('inner-out','output',{text:'{{inner-work.text}}'})],edges:[{id:'inner-1',source:'inner-start',target:'inner-work'},{id:'inner-2',source:'inner-work',target:'inner-out'}]}})
    baseline.nodes[2]!.config.text='done'
    const f=fixture({baseline,run:input=>patch(input,[{op:'update-node',node:ref(input,'inner-work'),configSet:{text:'after'}}],['inner-work'])})
    const task=await f.service.start(f.request({targetNodeIds:['inner-work']}),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready');expect(task.candidate!.nodes[1]!.config.body!.nodes[1]!.config.text).toBe('after')
    expect(task.candidate!.nodes[1]!.config.body!.edges).toEqual(f.baseline.nodes[1]!.config.body!.edges)
    expect(task.candidate!.nodes[1]!.config.maxIterations).toBe(1);expect(f.baseline.nodes[1]!.config.body!.nodes[1]!.config.text).toBe('before')
  })

  it('reopens a canonical awaiting-input record without replaying old edits or calling the model', async () => {
    const f = fixture({ run: input => ({submission:{mode:'needs-input',questions:[{id:'format',question:'输出何种格式？',options:['纯文本']}]}}) })
    const task = await f.service.start(f.request({ preview: false }), f.caller)
    expect(task.state).toBe('awaiting_input')
    const saved = JSON.parse(readFileSync(join(f.directory, 'planning/tasks.json'), 'utf8')).tasks[0]
    expect(saved.output.graphJson).toBe(''); expect(saved.output).not.toHaveProperty('baseDigest')
    const count = f.generate.mock.calls.length, reopened = f.open().get(task.id, f.caller)
    expect(reopened.state).toBe('awaiting_input'); expect(reopened.output!.questions[0]!.id).toBe('format')
    expect(f.generate).toHaveBeenCalledTimes(count); expect(f.options.publish).not.toHaveBeenCalled()
  })

  it.each([false,true])('resumes clarification using only a trusted draft (Host restarted=%s)',async restarted=>{
    const f=fixture({run:(input,attempt)=>{
      if(attempt===1){
        const initial=patch(input,[{op:'update-node',node:ref(input,'work'),configSet:{text:'中间草稿 {{missing.text}}'}}]);const first=input.compiler.submit(initial);if(first.ok)throw Error('Expected missing coverage')
        expect(first.feedback.issues[0]!.code).toBe('INVALID_REFERENCE')
        return {submission:{mode:'needs-input',questions:[{id:'format',question:'确认最终格式？'}]}}
      }
      const prompt=JSON.parse(input.prompt)
      expect(prompt.continuation.hasDraft).toBe(true);expect(input.compiler.checkpoint()!.document.updates.n2.set.text).toBe('中间草稿 {{missing.text}}')
      expect(prompt.answers).toEqual([{questionId:'format',answer:'使用最终格式'}])
      return {submission:{mode:'repair',draftRevision:prompt.continuation.draftRevision,patches:[{op:'replace',path:'/updates/n2/set/text',value:'最终格式 {{input.name}}'}]}}
    }})
    const waiting=await f.service.start(f.request({preview:false}),f.caller)
    expect(waiting.state,JSON.stringify(waiting.diagnostics)).toBe('awaiting_input');expect(waiting.compilerDraft!.checkpoint!.document).toMatchObject({updates:{n2:{set:{text:'中间草稿 {{missing.text}}'}}}})
    if(restarted)await f.service.close()
    const service=restarted?f.open():f.service
    const task=await service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'使用最终格式'}],f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.candidate!.nodes[1]!.config.text).toBe('最终格式 {{input.name}}')
    expect(task.output).not.toHaveProperty('edits');expect(task.output).not.toHaveProperty('baseDigest');expect(f.generate).toHaveBeenCalledTimes(2)
  })

  it('retains selected-node authority after an explicitly allowed deletion needs repair',async()=>{
    const f=fixture({run:input=>{
      const initial=patch(input,[{op:'remove-node',node:ref(input,'work')},{op:'connect',source:ref(input,'start'),target:ref(input,'out')},{op:'update-node',node:ref(input,'out'),configSet:{text:'完成'}}],['out'])
      initial.submission.coverage={}
      const first=input.compiler.submit(initial);if(first.ok)throw Error('Expected missing coverage')
      expect(input.compiler.snapshot().document).toMatchObject({removeNodes:['n2']})
      expect(JSON.parse(input.prompt).graph.targetKeys).toEqual(['n2','n3'])
      return {submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/coverage/R1',value:['n3']}]}}
    }})
    const task=await f.service.start(f.request({targetNodeIds:['work','out']}),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready');expect(f.generate).toHaveBeenCalledOnce();expect(task.candidateAttempts).toBe(2)
    expect(task.candidate!.nodes.map(item=>item.id)).toEqual(['start','out']);expect(task.candidate!.editor!.annotations![0]!.text).toBe('保留批注')
    expect(task.candidate!.editor!.annotations![0]!.nodeIds).toEqual([]);expect(f.baseline.nodes.map(item=>item.id)).toEqual(['start','work','out'])
  })

  it.each(['outside', 'fixed', 'remove-without-scope', 'secret-value', 'unsafe-key'])('does not publish forbidden intent: %s', async kind => {
    const baseline = flow(); if (kind === 'fixed') baseline.nodes[1]!.fixed = true
    const f = fixture({ baseline, run: input => {
      const target = kind === 'outside' ? 'out' : 'work'
      const edits = kind === 'remove-without-scope' ? [{ op: 'remove-node', node: ref(input, 'work') }]
        : kind === 'secret-value' ? [{ op: 'update-environment', variable: '@e1', value: 'never-bind-a-secret' }]
        : [{ op: 'update-node', node: ref(input, target), configSet: kind === 'unsafe-key' ? JSON.parse('{"__proto__":{"polluted":true}}') : { text: '越权' } }]
      return patch(input, edits)
    } })
    const before = structuredClone(f.baseline)
    const task = await f.service.start(f.request(kind === 'outside' ? { targetNodeIds: ['work'] } : {}), f.caller)
    expect(['ready', 'published']).not.toContain(task.state); expect(f.options.publish).not.toHaveBeenCalled()
    expect(f.baseline).toEqual(before); expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('cannot delete a fixed descendant by updating its container config', async () => {
    const baseline = flow(), inner = node('inner', 'input', { fields: [] }); inner.fixed = true
    baseline.nodes[1] = node('work', 'loop', { maxIterations: 1, body: { nodes: [inner, node('inner-out', 'output', { text: 'done' })], edges: [{ id: 'inner-e', source: 'inner', target: 'inner-out' }] } })
    baseline.nodes[2]!.config.text = 'done'
    const f = fixture({ baseline, run: input => patch(input, [{ op: 'update-node', node: ref(input, 'work'), kind: 'template', configSet: { text: 'bypass' }, configUnset: ['body', 'maxIterations'] }]) })
    const task = await f.service.start(f.request({ targetNodeIds: ['work'] }), f.caller)
    expect(['ready', 'published']).not.toContain(task.state); expect(f.options.publish).not.toHaveBeenCalled()
    expect(f.baseline.nodes[1]!.config.body!.nodes[0]!.fixed).toBe(true)
  })
})

describe('local optimizer edits through evidence, Graphon and candidate selection', () => {
  function retrospective(runOptimize: Run) {
    const baseline = flow(); baseline.nodes[1] = node('work', 'llm', { prompt: '你好 {{input.name}}' })
    baseline.nodes.splice(2, 0, {...node('review', 'human', { prompt: '确认问候格式' }),number:'a-3'})
    baseline.edges = [{ id: 'planning-edge-1', source: 'start', target: 'work' }, { id: 'planning-edge-2', source: 'work', target: 'review' }, { id: 'planning-edge-3', source: 'review', target: 'out' }]
    let optimizationRound = 0
    const f = fixture({ baseline, conversation: evidence(), run: (input, attempt) => {
      if (input.purpose === 'distill') return { outcome: 'procedure', procedureJson: JSON.stringify(procedure), summary: '提炼', questions: [] }
      if (input.purpose === 'optimize') return runOptimize(input, ++optimizationRound)
      const result = patch(input, []); result.fixtureProjection.requirementCoverage.push({requirementId:'S1',nodeIds:['work','review'],note:'保留人工检查'}); return result
    } })
    const request: PlanningRequest = { requestId: 'retrospective-edits', operation: 'create', instruction: '从完成任务提炼并减少调用，保留人工检查', preview: true, source: { kind: 'current-conversation' }, optimizationTarget: { maxModelCalls: 0, maxAgentCalls: 0 } }
    return { ...f, request }
  }

  it('preserves immutable metadata and human review while a verified replacement uses real Graphon', async () => {
    const f = retrospective((input, round) => round === 1 ? { protocolVersion: 1, baseDigest: view(input).baseDigest, outcome: 'candidate', summary: '确定性格式化', replacements: [{
      node: ref(input, 'work'), kind: 'template', config: { text: '你好 {{input.name}}' }, reason: '固定格式',
      evidenceCases: [{ id: 'recorded-case', workflowInputs: { evidenceId: 'e2', pointer: '' }, expected: { evidenceId: 'e3', pointer: '' } }],
    }] } : { protocolVersion: 1, baseDigest: view(input).baseDigest, outcome: 'unchanged', summary: '没有更多替换', replacements: [] })
    const task = await f.service.start(f.request, f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready'); expect(task.optimization?.selection).toBe('optimized')
    expect(task.optimization!.attempts[0]!.regression).toMatchObject({ scope: 'node-transform', passedRecorded: 1 })
    expect(task.candidate!.description).toBe(f.baseline.description)
    // This is CREATE: the human gate keeps its full definition, with Host-arranged coordinates.
    const reviewPosition = arrangeNodes(task.candidate!).find(item => item.id === 'review')!
    expect(task.candidate!.nodes.find(item => item.id === 'review')).toEqual({ ...f.baseline.nodes.find(item => item.id === 'review'), x: reviewPosition.x, y: reviewPosition.y })
    expect(task.candidate!.edges).toEqual(f.baseline.edges); expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('keeps the baseline when optimizer tries metadata changes or replacing a human gate', async () => {
    const f = retrospective((input, round) => ({ protocolVersion: 1, baseDigest: view(input).baseDigest, outcome: 'candidate', summary: '非法替换',
      ...(round === 1 ? { edits: [{ op: 'set-workflow', description: '越权描述' }] } : {}),
      replacements: [{ node: ref(input, round === 1 ? 'work' : 'review'), kind: 'template', config: { text: '你好 {{input.name}}' }, reason: '不应采用', evidenceCases: [{ id: 'sample', workflowInputs: { evidenceId: 'e2', pointer: '' }, expected: { evidenceId: 'e3', pointer: '' } }] }],
    }))
    const task = await f.service.start(f.request, f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready'); expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.attempts).toHaveLength(2); expect(task.optimization?.attempts.every(item => !item.accepted && !item.regression)).toBe(true)
    expect(task.candidate).toEqual(task.optimization?.baseline.candidate); expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('presents source mappings and rejected replacement history using current view refs only', async () => {
    const f = retrospective((input, round) => {
      const prompt = JSON.parse(input.prompt)
      expect(prompt.sourceMap[0].nodeIds).toEqual([ref(input, 'work'), ref(input, 'review')])
      expect(prompt.targetScope).toBe('workflow'); expect(prompt.targetNodeRefs).toEqual([])
      if (round === 1) return { protocolVersion: 1, baseDigest: prompt.baseDigest, outcome: 'candidate', replacements: [{ node: ref(input, 'review'), kind: 'template', config: { text: '不应删除人工检查' }, reason: '应被拒绝' }] }
      expect(prompt.attempts[0].replacements).toEqual([{ node: ref(input, 'review'), reason: '应被拒绝' }])
      expect(prompt.attempts[0].diagnostics.filter((item: any) => item.nodeId).every((item: any) => prompt.nodes.some((node: any) => node.ref === item.nodeId))).toBe(true)
      return { protocolVersion: 1, baseDigest: prompt.baseDigest, outcome: 'unchanged' }
    })
    const task = await f.service.start(f.request, f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready'); expect(task.optimization?.selection).toBe('baseline')
    expect(task.sourceMap?.[0]?.nodeIds).toEqual(['work', 'review'])
    expect(task.optimization!.attempts[0]!.replacements).toEqual([{ nodeId: 'review', reason: '应被拒绝' }])
  })
})
