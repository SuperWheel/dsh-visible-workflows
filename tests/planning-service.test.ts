import {moduleCheck} from './fixtures/planning-module-check.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeWorkflow, type Workflow, type WorkflowProposal } from '../src/shared/types.ts'
import type { PlanningContext, PlannerOutput, PlanningRequest } from '../src/shared/planning-types.ts'
import { WorkflowPlanningService, planningDigest, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { PlanningAgentCleanupError, PlanningAgentError, type PlanningAgentInput, type PlanningAgentResult } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { PlanningStore } from '../src/host/planning/store.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { CompilerError } from '../src/shared/planning-repair.ts'
import { submissionSchemaIssues } from '../src/shared/planning-submission-schema.ts'
import { parsePlanningRequest } from '../src/shared/planning-schema.ts'
import { parsePlanningEntry } from '../src/host/planning/entry.ts'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ConversationEvidence, RetrospectiveOutput, TaskProcedure } from '../src/shared/retrospective.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { fixturePlanningEdits, fixturePlanningPrompt, fixtureSubmit } from './fixtures/planning-edits.ts'
import { r28Filling,r28Repair,r28Corrected } from './fixtures/planning-compiler/r28.ts'
import { tools } from './fixtures/t18-tools.ts'
import { BUILTIN_TOOLS } from '../src/host/tool-catalog.ts'
import { designVerificationReceipt } from '../src/host/planning/command-brief.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
const waiting:PlannerOutput={outcome:'needs-input',graphJson:'',summary:'需要输入',assumptions:[],questions:[{id:'q1',question:'输出格式？',options:['文本','JSON']}],requirementCoverage:[]}
const request=(changes:Partial<PlanningRequest>={}):PlanningRequest=>({requestId:'request-1',operation:'create',instruction:'输入文字并输出结果',...changes})
function candidate(input:PlanningAgentInput):PlannerOutput{
  const prompt=fixturePlanningPrompt(input),graph=prompt.graph
  graph.title='已规划的工作流'
  return {outcome:'candidate',graphJson:JSON.stringify(graph),summary:'定义已生成，尚未执行',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:graph.nodes.map((node:{id:string})=>node.id),note:'节点定义覆盖要求'},...(prompt.procedure?.steps??[]).map((step:{id:string})=>({requirementId:step.id,nodeIds:[graph.nodes[1].id],note:'提炼步骤映射'}))]}
}
type Options=ConstructorParameters<typeof WorkflowPlanningService>[0]
function fixture(config:{run?:(input:PlanningAgentInput,attempt:number)=>Promise<PlanningAgentResult>;baseline?:Workflow;canRun?:boolean;conversation?:ConversationEvidence}={}){
  const directory=mkdtempSync(join(tmpdir(),'planning-service-'));directories.push(directory)
  const receipts=new Map<string,PlanningReceipt>(),controller=new AbortController(),parent={id:'parent-session'} as Agent
  const caller:PlanningCaller={parent,sessionId:'parent-session',workspaceId:'workspace',signal:controller.signal}
  const baseline=config.baseline??makeWorkflow(caller.workspaceId)
  let attempts=0
  const generate=vi.fn(async(input:PlanningAgentInput)=>{
    attempts++;input.onTask?.(`child-${attempts}`)
    if(config.run){const result=await config.run(input,attempts);return {...result,output:fixturePlanningEdits(input,result.output)}}
    input.beforeStep?.(20,undefined)
    return {output:fixturePlanningEdits(input,candidate(input)),steps:1,usage:{totalTokens:25}}
  })
  const options:Options={
    directory,driver:{generate},admission:new ModelAdmission(2,2),
    context:vi.fn(async(req,owner):Promise<PlanningContext>=>({workflow:{...structuredClone(baseline),...(req.targetWorkflowId?{id:req.targetWorkflowId}:{})},operation:req.operation,targetNodeIds:req.targetNodeIds??[],nodeIds:['new-node'],subagentIds:['new-agent'],environmentIds:['new-env'],tools:[],model:{provider:'test',model:'fake'},effort:'high',...(config.conversation?{conversation:config.conversation}:{})})),
    authorize:vi.fn((task,owner)=>{if(task.sessionId!==owner.sessionId||task.workspaceId!==owner.workspaceId)throw new Error('权限错误')}),
    readiness:vi.fn(async(flow)=>({workflowId:flow.id,revision:flow.revision,canRun:config.canRun??true,issues:[]})),
    publish:vi.fn(async(flow,task,_owner,commit)=>{receipts.set(commit.key,{...commit,workflowId:flow.id,revision:task.request.operation==='create'?1:flow.revision,kind:task.request.operation==='create'?'created':'proposed',...(task.request.operation==='revise'?{proposalId:'proposal-1'}:{})})}),
    receipt:key=>receipts.get(key),
  }
  const reopen=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  const service=reopen(),file=join(directory,'planning','tasks.json')
  // Snapshot plus its journal: the durable view a restart would read.
  const stored=()=>new PlanningStore(directory).readRaw() as {version:number;tasks:PlanningTask[]}
  const replace=(change:(task:PlanningTask)=>void)=>{const raw=stored();change(raw.tasks[0]!);writeFileSync(file,JSON.stringify(raw))}
  return {service,reopen,options,caller,controller,receipts,generate,directory,file,stored,replace,baseline}
}
function historicalHashCandidate(f:ReturnType<typeof fixture>,state:'ready'|'publishing'|'published',templateSyntax=false):PlanningTask{
  let historical!:PlanningTask
  f.replace(task=>{
    task.state=state
    task.candidate!.nodes[1]!.config.text=templateSyntax?'{{input.text | upper}}':`{{#${task.candidate!.nodes[0]!.id}.text#}}`
    task.candidateDigest=planningDigest(task.candidate)
    task.commit={key:planningDigest([task.id,task.candidateDigest,task.request.operation]),digest:task.candidateDigest}
    task.receipt={...task.receipt!,...task.commit}
    f.receipts.clear();f.receipts.set(task.commit.key,task.receipt)
    if(state==='ready'){delete task.commit;delete task.receipt;f.receipts.clear()}
    historical=structuredClone(task)
  })
  return historical
}
afterEach(async()=>{vi.useRealTimers();await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})

function evidence():ConversationEvidence{
  const value:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'parent-session',fromSeq:1,throughSeq:2,records:[{id:'e1',seq:1,kind:'user',text:'将报销明细按支付日期汇总',status:'statement',truncated:false},{id:'e2',seq:2,kind:'assistant',text:'已生成本次汇总，可换月份复用',status:'statement',truncated:false}],warnings:[]}
  return {...value,digest:conversationEvidenceDigest(value)}
}
const procedure=():TaskProcedure=>({goal:'汇总报销',parameters:[{name:'month',description:'本次月份'}],rules:['使用支付日期'],steps:[{id:'S1',title:'汇总',instruction:'按支付日期汇总本次输入',dependsOn:[],evidenceRefs:['e1','e2'],requiresReview:false}],excluded:[],reviewItems:[]})
const distilled=(value=procedure()):RetrospectiveOutput=>({outcome:'procedure',procedureJson:JSON.stringify(value),summary:'方法已提炼，尚未复跑',questions:[]})
const retrospectiveRequest=(changes:Partial<PlanningRequest>={}):PlanningRequest=>request({preview:true,source:{kind:'current-conversation',fromSeq:1,throughSeq:2},...changes})
const retrospectiveRun=async(input:PlanningAgentInput):Promise<PlanningAgentResult>=>{input.beforeStep?.(20,8192);return {output:input.purpose==='distill'?distilled():candidate(input),steps:1,usage:{totalTokens:20}}}

describe('current-conversation retrospective planning (offline)',()=>{
  it('accepts only strict current-conversation create previews',()=>{
    expect(parsePlanningRequest(retrospectiveRequest()).source?.kind).toBe('current-conversation')
    for(const value of [retrospectiveRequest({preview:false}),retrospectiveRequest({preview:undefined}),retrospectiveRequest({operation:'revise',targetWorkflowId:'flow',expectedRevision:1}),retrospectiveRequest({source:{kind:'current-conversation',fromSeq:3,throughSeq:2}}),{...retrospectiveRequest(),source:{kind:'current-conversation',sessionId:'other'}}])expect(()=>parsePlanningRequest(value)).toThrow()
  })
  it('distills once, passes only the compact procedure to authoring, and keeps preview provenance out of Workflow and disk',async()=>{
    const f=fixture({conversation:evidence(),run:retrospectiveRun}),task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('ready');expect(task.childAttempts).toBe(2);expect(task.distillationAttempts).toBe(1);expect(task.candidateAttempts).toBe(1)
    expect(task.steps).toBe(2);expect(task.spentTokens).toBe(40);expect(task.procedure).toEqual(procedure())
    expect(task.sourceMap).toEqual([{stepId:'S1',nodeIds:[task.candidate!.nodes[1]!.id],evidenceRefs:['e1','e2']}])
    expect(task.provenanceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.generate.mock.calls.map(([input])=>input.purpose)).toEqual(['distill','author'])
    const [first,second]=f.generate.mock.calls.map(([input])=>JSON.parse(input.prompt))
    expect(first.conversation.digest).toBe(evidence().digest);expect(second.procedure).toEqual(procedure());expect(second).not.toHaveProperty('conversation')
    expect(task.candidate).not.toHaveProperty('procedure');expect(task.candidate).not.toHaveProperty('sourceMap');expect(task.candidate).not.toHaveProperty('source')
    expect(f.options.publish).not.toHaveBeenCalled();expect(existsSync(join(f.directory,'planning'))).toBe(false)
    expect((await f.service.start(retrospectiveRequest(),f.caller)).id).toBe(task.id);expect(f.generate).toHaveBeenCalledTimes(2)
  })
  it('rejects missing, cross-session, range-mismatched and digest-tampered Host evidence before calling any child',async()=>{
    const foreign=evidence();foreign.sessionId='other';foreign.digest=conversationEvidenceDigest(foreign)
    const tampered=evidence();tampered.records[0]!.text='changed'
    for(const conversation of [undefined,foreign,tampered]){
      const f=fixture({conversation,run:retrospectiveRun}),task=await f.service.start(retrospectiveRequest(),f.caller)
      expect(task.state).toBe('failed');expect(f.generate).not.toHaveBeenCalled();expect(existsSync(f.file)).toBe(false)
    }
    const f=fixture({conversation:evidence(),run:retrospectiveRun})
    expect((await f.service.start(retrospectiveRequest({source:{kind:'current-conversation',fromSeq:0,throughSeq:2}}),f.caller)).state).toBe('failed')
    expect((await f.service.start(request({requestId:'ordinary',preview:true}),f.caller)).state).toBe('failed');expect(f.generate).not.toHaveBeenCalled()
  })
  it('repairs procedure references once and author coverage separately without sending raw evidence again',async()=>{
    const f=fixture({conversation:evidence()})
    const feedbacks:any[]=[]
    f.generate.mockImplementation(async input=>{
      input.beforeStep?.(20,undefined)
      let wire:any
      if(input.purpose==='distill'){
        const bad=procedure();bad.steps[0]!.evidenceRefs=['e404']
        const first=input.compiler.submit({submission:{mode:'distill',procedure:bad}});if(first.ok)throw Error('Expected invalid evidence')
        feedbacks.push(first.feedback)
        wire={submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/procedure/steps/0/evidenceRefs',value:['e1','e2']}]}}
      }else{
        const first=input.compiler.submit({submission:{mode:'create',title:'已规划的工作流',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
        if(first.ok)throw Error('Expected missing step coverage');feedbacks.push(first.feedback)
        wire={submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/coverage/S1',value:['result']}]}}
      }
      input.beforeStep?.(20,undefined)
      return {output:fixtureSubmit(input,wire),steps:2,usage:{totalTokens:40}}
    })
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready');expect(task.distillationAttempts).toBe(2);expect(task.candidateAttempts).toBe(2)
    expect(feedbacks[0].issues[0].code).toBe('INVALID_EVIDENCE_REFS');expect(feedbacks[1].issues[0].code).toBe('REQUIREMENT_COVERAGE')
    expect(f.generate).toHaveBeenCalledTimes(2);expect(JSON.parse(f.generate.mock.calls[1]![0].prompt)).not.toHaveProperty('conversation')
  })

  it('stops after two invalid distillations and never spends an author call',async()=>{
    const f=fixture({conversation:evidence()})
    f.generate.mockImplementation(async input=>{
      const first=input.compiler.submit({submission:{mode:'distill',procedure:{}}});if(first.ok)throw Error('Expected invalid procedure')
      return {output:fixtureSubmit(input,{submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/procedure/goal',value:'仍然缺少步骤'}]}}),steps:2,usage:{totalTokens:40}}
    })
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('failed');expect(task.distillationAttempts).toBe(2);expect(task.candidateAttempts).toBe(0);expect(f.generate).toHaveBeenCalledOnce()
    expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('shares the two question batches across distillation and authoring with one frozen evidence read',async()=>{
    const clarification:RetrospectiveOutput={outcome:'needs-input',procedureJson:'',summary:'范围需确认',questions:waiting.questions}
    const f=fixture({conversation:evidence(),run:async(input,attempt)=>({output:attempt===1?clarification:input.purpose==='distill'?distilled():waiting,steps:0,usage:{totalTokens:20}})})
    let task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('awaiting_input');expect(task.distillationAttempts).toBe(0)
    task=await f.service.answer(task.id,task.revision,[{questionId:'q1',answer:'文本'}],f.caller)
    expect(task.state).toBe('awaiting_input');expect(task.questionRounds).toBe(2);expect(task.procedure).toEqual(procedure())
    task=await f.service.answer(task.id,task.revision,[{questionId:'q1',answer:'文本'}],f.caller)
    expect(task.state).toBe('failed');expect(task.questionRounds).toBe(3);expect(f.generate.mock.calls.map(([input])=>input.purpose)).toEqual(['distill','distill','author','author'])
    expect(f.options.context).toHaveBeenCalledOnce();expect(existsSync(f.file)).toBe(false)
  })
  it('keeps missing usage unknown across both stages without imposing a hidden planning Token cap',async()=>{
    const f=fixture({conversation:evidence(),run:async input=>{
      input.beforeStep?.(40_000,8192)
      return {output:input.purpose==='distill'?distilled():candidate(input),steps:1}
    }})
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('ready');expect(task.diagnostics).toEqual([])
    expect(task.unknownUsageCalls).toBe(2);expect(task.observedInputBytes).toBe(80_000);expect(task.unknownTokens).toBe(0);expect(task.reservedTokens).toBe(0);expect(task.steps).toBe(2);expect(task.procedure).toEqual(procedure())
    expect(f.generate.mock.calls.map(([input])=>input.purpose)).toEqual(['distill','author']);expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('requires a real human node for review-marked steps and accepts a linked review repair',async()=>{
    const value=procedure();value.steps[0]!.requiresReview=true;value.reviewItems=['确认支付日期口径']
    const f=fixture({conversation:evidence()});let feedback:any
    f.generate.mockImplementation(async input=>{
      if(input.purpose==='distill')return {output:fixturePlanningEdits(input,distilled(value)),steps:0,usage:{totalTokens:20}}
      const initial={submission:{mode:'create',title:'人工核对',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result'],S1:['result']}}}
      const first=input.compiler.submit(initial);if(first.ok)throw Error('Expected review requirement');feedback=first.feedback
      const wire={submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/nodesByKey/review',value:{kind:'human',title:'确认口径',config:{prompt:value.reviewItems[0],fields:[],actions:[{id:'continue',label:'确认'}]}}},{op:'replace',path:'/chainsByKey/main/nodes',value:['start','review','result']},{op:'replace',path:'/coverage/S1',value:['review']}]}}
      return {output:fixtureSubmit(input,wire),steps:0,usage:{totalTokens:20}}
    })
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready');expect(task.candidateAttempts).toBe(2);expect(task.sourceMap![0]!.nodeIds).toContain('new-node')
    expect(feedback.issues[0].code).toBe('REVIEW_REQUIRED')
  })
  it('does not start authoring or persist anything when distillation is cancelled',async()=>{
    const f=fixture({conversation:evidence(),run:async input=>{input.beforeStep?.(20,8192);f.controller.abort(new Error('取消提炼'));return {output:distilled(),steps:1,usage:{totalTokens:20}}}})
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('cancelled');expect(task.procedure).toBeUndefined();expect(f.generate).toHaveBeenCalledOnce();expect(existsSync(f.file)).toBe(false)
  })
  it('rechecks live caller authority between distillation and authoring',async()=>{
    let authorized=true
    const f=fixture({conversation:evidence(),run:async()=>{authorized=false;return {output:distilled(),steps:0,usage:{totalTokens:20}}}})
    f.options.authorize=vi.fn(()=>{if(!authorized)throw new Error('FORBIDDEN：当前主对话不再活动')})
    const task=await f.service.start(retrospectiveRequest(),f.caller)
    expect(task.state).toBe('blocked');expect(task.childAttempts).toBe(1);expect(task.candidateAttempts).toBe(0)
    expect(f.generate).toHaveBeenCalledOnce();expect(existsSync(f.file)).toBe(false)
  })
  it('publishes only explicitly, binds provenance to the atomic receipt, and restores without another model call',async()=>{
    const f=fixture({conversation:evidence(),run:retrospectiveRun}),ready=await f.service.start(retrospectiveRequest(),f.caller)
    const task=await f.service.publish(ready.id,ready.revision,ready.candidateDigest!,f.caller)
    expect(task.state).toBe('published');expect(task.request.preview).toBe(true);expect(task.preview).toBe(false)
    expect(task.commit?.key).toBe(planningDigest([task.id,task.candidateDigest,'create',task.provenanceDigest]))
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.procedure).toEqual(procedure());expect(restored.sourceMap).toEqual(task.sourceMap);expect(restored.receipt).toEqual(task.receipt)
    expect(f.generate).toHaveBeenCalledTimes(2);expect(f.options.publish).toHaveBeenCalledOnce()
  })
  it('rejects persisted source, procedure and node mapping tampering without rewriting the record',async()=>{
    const changes:((task:PlanningTask)=>void)[]=[
      task=>{task.context!.conversation!.records[0]!.text='changed'},task=>{task.procedure!.rules=['different rule']},task=>{task.sourceMap![0]!.evidenceRefs=['e404']},task=>{task.sourceMap![0]!.nodeIds=['missing']},task=>{task.provenanceDigest='0'.repeat(64)},task=>{task.commit!.key=planningDigest([task.id,task.candidateDigest,'create'])},
    ]
    for(const change of changes){
      const f=fixture({conversation:evidence(),run:retrospectiveRun}),ready=await f.service.start(retrospectiveRequest(),f.caller)
      await f.service.publish(ready.id,ready.revision,ready.candidateDigest!,f.caller);f.replace(change)
      const before=readFileSync(f.file,'utf8');expect(()=>f.reopen()).toThrow();expect(readFileSync(f.file,'utf8')).toBe(before)
    }
  })
})

describe('planning service generation and publication (offline)',()=>{
  it('keeps model output defaults and eight catalog/authoring steps without a child 180-second total cutoff',async()=>{
    vi.useFakeTimers()
    let admitted!:PlanningAgentInput,started!:()=>void,finish!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{finish=resolve})
    const f=fixture({run:async input=>{admitted=input;input.beforeStep?.(80_000,undefined);started();await gate;return {output:candidate(input),steps:1,usage:{totalTokens:10_903}}}})
    const pending=f.service.start(request(),f.caller);await ready
    expect(admitted.maxSteps).toBe(8);expect(admitted).not.toHaveProperty('maxTokens')
    await vi.advanceTimersByTimeAsync(600_001)
    expect(admitted.signal.aborted).toBe(false)
    finish();expect((await pending).state).toBe('published')
  })

  it('distinguishes the total time guard from cancellation and execution budget failures',async()=>{
    vi.useFakeTimers()
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    const f=fixture({run:async input=>{input.beforeStep?.(20,undefined);started();await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));input.signal.throwIfAborted();throw new Error('unreachable')}})
    const pending=f.service.start(request(),f.caller);await ready
    await vi.advanceTimersByTimeAsync(1_200_000)
    const task=await pending
    expect(task.state).toBe('failed');expect(task.diagnostics.at(-1)?.code).toBe('PLANNING_DEADLINE_EXCEEDED');expect(task.unknownUsageCalls).toBe(1)
    expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('still bounds total steps and reports their exact cause without treating them as Token budget',async()=>{
    const f=fixture({run:async input=>{for(let i=0;i<25;i++)input.beforeStep?.(100_000,undefined);throw new Error('unreachable')}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed');expect(task.steps).toBe(24);expect(task.diagnostics.at(-1)?.code).toBe('PLANNING_STEP_LIMIT');expect(task.unknownUsageCalls).toBe(24)
    expect(f.options.publish).not.toHaveBeenCalled()
  })

  it.each(['PLANNING_IDLE_TIMEOUT','PLANNING_PROVIDER_QUOTA','PLANNING_CONTEXT_TOO_LARGE','PLANNING_OUTPUT_INCOMPLETE'])('retains a specific %s failure without another repair/model call',async failureCode=>{
    const f=fixture({run:async()=>{throw new PlanningAgentError(failureCode,'specific cause')}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed');expect(task.diagnostics.at(-1)?.code).toBe(failureCode);expect(f.generate).toHaveBeenCalledOnce()
  })

  it('leaves terminal pending usage and old mixed-unit history unchanged on restart',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    f.replace(value=>{value.pendingUsageCalls=2;value.unknownUsageCalls=1})
    const terminalBytes=readFileSync(f.file)
    const recovered=f.reopen().get(task.id,f.caller)
    expect(recovered).toMatchObject({usageAccountingVersion:2,pendingUsageCalls:2,unknownUsageCalls:1,unknownTokens:0})
    expect(readFileSync(f.file)).toEqual(terminalBytes)
    f.replace(value=>{delete (value as any).usageAccountingVersion;delete (value as any).pendingUsageCalls;delete (value as any).unknownUsageCalls;delete (value as any).observedInputBytes;value.reservedTokens=500;value.unknownTokens=1000})
    const historicalBytes=readFileSync(f.file)
    const legacy=f.reopen().get(task.id,f.caller)
    expect(legacy).toMatchObject({usageAccountingVersion:1,unknownTokens:1000,reservedTokens:500,unknownUsageCalls:0,pendingUsageCalls:0})
    expect(legacy.requestDigest).toBe(task.requestDigest);expect(legacy.candidateDigest).toBe(task.candidateDigest);expect(legacy.receipt).toEqual(task.receipt)
    expect(readFileSync(f.file)).toEqual(historicalBytes)
    f.reopen();expect(readFileSync(f.file)).toEqual(historicalBytes)
  })

  it('does not migrate a terminal legacy row when another active task needs restart interruption',async()=>{
    const f=fixture({run:async(input,attempt)=>{input.beforeStep?.(20,undefined);return {output:attempt===1?candidate(input):waiting,steps:1,usage:{totalTokens:20}}}})
    const terminal=await f.service.start(request(),f.caller)
    const active=await f.service.start(request({requestId:'another-task'}),f.caller)
    const raw=f.stored(),historical=raw.tasks.find(task=>task.id===terminal.id)!
    for(const key of ['usageAccountingVersion','observedInputBytes','unknownUsageCalls','pendingUsageCalls'])delete (historical as any)[key]
    historical.reservedTokens=500;historical.unknownTokens=1000
    raw.tasks.find(task=>task.id===active.id)!.state='authoring'
    writeFileSync(f.file,JSON.stringify(raw))
    const before=JSON.stringify(historical),restored=f.reopen()
    expect(restored.get(active.id,f.caller).state).toBe('interrupted')
    expect(JSON.stringify(f.stored().tasks.find(task=>task.id===terminal.id))).toBe(before)
  })

  it('settles the real first-call reservation before admitting the next step and never adds aggregate usage twice',async()=>{
    const f=fixture({run:async input=>{
      input.beforeStep?.(51_622,8192,{turn:1,step:1})
      input.onUsage?.({sequence:15,turn:1,step:1,usage:{totalTokens:10_849}})
      input.onUsage?.({sequence:15,turn:1,step:1,usage:{totalTokens:10_849}})
      expect(f.stored().tasks[0]).toMatchObject({spentTokens:10_849,reservedTokens:0,unknownTokens:0})
      input.beforeStep?.(40_000,8192,{turn:1,step:2})
      input.onUsage?.({sequence:22,turn:1,step:2,usage:{totalTokens:12_000}})
      return {output:candidate(input),steps:2,usage:{totalTokens:22_849}}
    }})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.steps).toBe(2);expect(task.spentTokens).toBe(22_849)
    expect(task.unknownTokens).toBe(0);expect(task.reservedTokens).toBe(0)
  })

  it.each(['error','cancel','cleanup'] as const)('retains settled native usage after %s and converts only the unreported reservation to unknown',async mode=>{
    const f=fixture({run:async input=>{
      input.beforeStep?.(51_622,8192,{turn:1,step:1})
      input.onUsage?.({sequence:15,turn:1,step:1,usage:{totalTokens:10_849}})
      input.beforeStep?.(200,8192,{turn:1,step:2})
      if(mode==='cancel')f.controller.abort(new Error('取消规划'))
      if(mode==='cleanup')throw new PlanningAgentCleanupError(new Error('teardown failed'))
      throw new Error('provider unavailable')
    }})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe(mode==='cancel'?'cancelled':mode==='cleanup'?'blocked':'failed')
    expect(task.spentTokens).toBe(10_849);expect(task.unknownTokens).toBe(0);expect(task.unknownUsageCalls).toBe(1);expect(task.pendingUsageCalls).toBe(0);expect(task.reservedTokens).toBe(0)
    expect(f.reopen().get(task.id,f.caller)).toMatchObject({spentTokens:10_849,unknownTokens:0,unknownUsageCalls:1,pendingUsageCalls:0,reservedTokens:0})
  })

  it('admits the real failure shape and later calls above 64000 without mixing bytes, Tokens or unknown usage',async()=>{
    const f=fixture({run:async input=>{
      input.beforeStep?.(51_622,8192,{turn:1,step:1})
      input.onUsage?.({sequence:15,turn:1,step:1,usage:{totalTokens:10_849}})
      input.beforeStep?.(80_000,undefined,{turn:1,step:2})
      input.onUsage?.({sequence:22,turn:1,step:2})
      input.beforeStep?.(150_000,undefined,{turn:1,step:3})
      input.onUsage?.({sequence:25,turn:1,step:3,usage:{totalTokens:70_000}})
      return {output:candidate(input),steps:3}
    }})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.diagnostics).toEqual([])
    expect(task.steps).toBe(3);expect(task.spentTokens).toBe(80_849);expect(task.observedInputBytes).toBe(281_622);expect(task.unknownUsageCalls).toBe(1);expect(task.unknownTokens).toBe(0);expect(task.reservedTokens).toBe(0)
  })

  it('does not treat zero, missing and invalid usage as interchangeable or dedupe distinct native attempts by step',async()=>{
    const f=fixture({run:async input=>{
      input.beforeStep?.(20,8192,{turn:1,step:1})
      input.onUsage?.({sequence:1,turn:1,step:1,usage:{totalTokens:0}})
      input.beforeStep?.(20,8192,{turn:1,step:2})
      input.onUsage?.({sequence:2,turn:1,step:2,usage:{totalTokens:Number.NaN}})
      input.onUsage?.({sequence:3,turn:1,step:2,usage:{totalTokens:9}})
      return {output:candidate(input),steps:2}
    }})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.spentTokens).toBe(9);expect(task.unknownTokens).toBe(0);expect(task.unknownUsageCalls).toBe(1);expect(task.reservedTokens).toBe(0)
  })

  it('persists only the current task contract, publishes once, and reuses the atomic receipt after restart',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.receipt?.kind).toBe('created')
    expect(task.request).not.toHaveProperty('targetWorkflowId');expect(task.requestDigest).toBe(planningDigest(request()))
    expect(task.steps).toBe(1);expect(task.spentTokens).toBe(25);expect(task.reservedTokens).toBe(0)
    expect(f.options.publish).toHaveBeenCalledOnce()
    const prompt=JSON.parse(f.generate.mock.calls[0]![0].prompt)
    expect(prompt.operation).toBe('create');expect(f.generate.mock.calls[0]![0].compiler).toBeDefined()
    expect(prompt.requiredCoverageIds).toEqual(['R1']);expect(prompt.semantics).toBeDefined()
    expect(prompt).not.toHaveProperty('graph');expect(prompt).not.toHaveProperty('previousCandidate')
    const next=f.reopen(),prior=await next.start(request(),f.caller)
    expect(prior.id).toBe(task.id);expect(prior.state).toBe('published');expect(f.generate).toHaveBeenCalledOnce()
    await expect(next.start(request({instruction:'different'}),f.caller)).rejects.toThrow('REQUEST_ID_CONFLICT')
  })

  it('preserves a requested new workflow identity and produces a proposal for an existing workflow',async()=>{
    const fresh=fixture(),created=await fresh.service.start(request({targetWorkflowId:'canvas-reserved',expectedRevision:0}),fresh.caller)
    expect(created.candidate?.id).toBe('canvas-reserved');expect(fresh.reopen().get(created.id,fresh.caller).state).toBe('published')
    const baseline=makeWorkflow('workspace');baseline.revision=7
    const f=fixture({baseline}),task=await f.service.start(request({operation:'revise',targetWorkflowId:baseline.id,expectedRevision:7}),f.caller)
    expect(task.state).toBe('published');expect(task.receipt).toMatchObject({kind:'proposed',proposalId:'proposal-1',revision:7})
    expect(task.candidate?.revision).toBe(7)
  })

  it('recovers a proposal baseline only for the exact committed candidate and publication receipt',async()=>{
    const baseline=makeWorkflow('workspace');baseline.revision=3
    const f=fixture({baseline}),task=await f.service.start(request({operation:'revise',targetWorkflowId:baseline.id,expectedRevision:3}),f.caller)
    const proposal:WorkflowProposal={id:task.receipt!.proposalId!,workflowId:baseline.id,baseRevision:3,candidate:task.candidate!,status:'pending',createdAt:task.updatedAt}
    expect(f.service.proposalBase(proposal)).toEqual(baseline)
    expect(f.service.proposalBase({...proposal,id:'another-proposal'})).toBeUndefined()
    expect(f.service.proposalBase({...proposal,baseRevision:4})).toBeUndefined()
    expect(f.service.proposalBase({...proposal,candidate:{...proposal.candidate,title:'Unlinked candidate'}})).toBeUndefined()
    f.receipts.clear();expect(f.service.proposalBase(proposal)).toBeUndefined()
  })

  it('keeps preview, clarification and preview cancellation entirely in memory',async()=>{
    const f=fixture(),task=await f.service.start(request({preview:true}),f.caller)
    expect(task.state).toBe('ready');expect(task.preview).toBe(true);expect(f.options.publish).not.toHaveBeenCalled()
    expect(existsSync(join(f.directory,'planning'))).toBe(false)
    expect((await f.service.cancel(task.id,f.caller)).state).toBe('cancelled')
    expect(existsSync(join(f.directory,'planning'))).toBe(false)
    const questions=fixture({run:async input=>{input.beforeStep?.(20,8192);return {output:waiting,steps:1}}})
    expect((await questions.service.start(request({preview:true}),questions.caller)).state).toBe('awaiting_input')
    expect(existsSync(join(questions.directory,'planning'))).toBe(false)
  })

  it('publishes an explicit preview only with its current revision and candidate digest',async()=>{
    const f=fixture(),task=await f.service.start(request({preview:true}),f.caller)
    await expect(f.service.publish(task.id,task.revision-1,task.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
    await expect(f.service.publish(task.id,task.revision,'bad-digest',f.caller)).rejects.toThrow('版本已变化')
    const published=await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    expect(published.state).toBe('published');expect(published.preview).toBe(false);expect(existsSync(f.file)).toBe(true)
    expect((await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)).state).toBe('published')
    expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it('uses question batch revision and exact question IDs before continuing the same frozen context',async()=>{
    const f=fixture({run:async(input,attempt)=>{input.beforeStep?.(20,8192);return {output:attempt===1?waiting:candidate(input),steps:1,usage:{totalTokens:20}}}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('awaiting_input')
    for(const answers of [[],[{questionId:'wrong',answer:'文本'}],[{questionId:'q1',answer:''}],[{questionId:'q1',answer:'文本',extra:true}]])await expect(f.service.answer(task.id,task.revision,answers,f.caller)).rejects.toThrow()
    await expect(f.service.answer(task.id,task.revision-1,[{questionId:'q1',answer:'文本'}],f.caller)).rejects.toThrow('问题批次')
    const answered=await f.service.answer(task.id,task.revision,[{questionId:'q1',answer:'文本'}],f.caller)
    expect(answered.id).toBe(task.id);expect(answered.state).toBe('published');expect(answered.answers).toEqual([{questionId:'q1',answer:'文本'}])
    expect(f.options.context).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledTimes(2)
    expect(JSON.parse(f.generate.mock.calls[1]![0].prompt).answers).toEqual(answered.answers)
    await expect(f.service.answer(task.id,task.revision,[{questionId:'q1',answer:'JSON'}],f.caller)).rejects.toMatchObject({code:'PLANNING_NOT_AWAITING_INPUT',retryable:false})
  })

  it('stops after two clarification rounds without looping model requests',async()=>{
    const f=fixture({run:async input=>{input.beforeStep?.(20,8192);return {output:waiting,steps:1,usage:{totalTokens:20}}}})
    let task=await f.service.start(request(),f.caller)
    for(let round=0;round<2;round++)task=await f.service.answer(task.id,task.revision,[{questionId:'q1',answer:'文本'}],f.caller)
    expect(task.state).toBe('failed');expect(task.questionRounds).toBe(3);expect(f.generate).toHaveBeenCalledTimes(3)
    expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('repairs invalid envelopes and JSON at most three total attempts, retaining diagnostics in the same session',async()=>{
    const f=fixture();const feedbacks:any[]=[]
    f.generate.mockImplementation(async input=>{
      for(let attempt=0;attempt<2;attempt++){
        input.beforeStep?.(20,undefined)
        const rejected=input.compiler.rejectWire(attempt?{submission:'bad json'}:{},[{code:'COMPILER_TOOL_SCHEMA_INVALID',message:attempt?'参数不是 JSON 对象':'缺少 submission',allowedPaths:[]}])
        if(rejected.ok)throw Error('Expected invalid wire');feedbacks.push(rejected.feedback)
      }
      input.beforeStep?.(20,undefined)
      input.compiler.rejectWire({},[{code:'COMPILER_TOOL_SCHEMA_INVALID',message:'仍缺少 submission',allowedPaths:[]}])
      throw new PlanningAgentError('PLANNING_REPAIR_LIMIT','本阶段提交次数已达上限；最后诊断已保存')
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed');expect(task.candidateAttempts).toBe(3);expect(f.generate).toHaveBeenCalledOnce()
    expect(feedbacks[1].issues[0].code).toBe('COMPILER_TOOL_SCHEMA_INVALID');expect(task.diagnostics.some(issue=>issue.code==='PLANNING_REPAIR_LIMIT')).toBe(true)
    expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('repairs graph diagnostics and requirement coverage before saving',async()=>{
    const f=fixture();let feedback:any
    f.generate.mockImplementation(async input=>{
      const first=input.compiler.submit({submission:{mode:'create',title:'覆盖修正',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{}}})
      if(first.ok)throw Error('Expected missing coverage');feedback=first.feedback
      return {output:fixtureSubmit(input,{submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/coverage/R1',value:['result']}]}}),steps:2,usage:{totalTokens:40}}
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.candidateAttempts).toBe(2)
    expect(feedback.issues[0].code).toBe('REQUIREMENT_COVERAGE');expect(f.generate).toHaveBeenCalledOnce()
  })

  it('repairs coverage against the materialized draft without resubmitting the changed node',async()=>{
    const f=fixture();let before:any,after:any
    f.generate.mockImplementation(async input=>{
      const first=input.compiler.submit({submission:{mode:'create',title:'保留草稿',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'保留已物化的修改',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{}}})
      if(first.ok)throw Error('Expected missing coverage');before=input.compiler.snapshot().document
      const output=fixtureSubmit(input,{submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/coverage/R1',value:['result']}]}});after=input.compiler.snapshot().document
      return {steps:2,output}
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.candidate!.nodes.at(-1)!.config.text).toBe('保留已物化的修改')
    expect(after.nodesByKey).toEqual(before.nodesByKey);expect(task.candidateAttempts).toBe(2);expect(f.generate).toHaveBeenCalledOnce()
    expect(task.output).toHaveProperty('graphJson');expect(task.output).not.toHaveProperty('edits')
  })

  it('keeps invalid bare names unchanged until an explicit repair uses a current compiler key',async()=>{
    const f=fixture();let feedback:any,draft:any
    f.generate.mockImplementation(async input=>{
      const first=input.compiler.submit({submission:{mode:'create',title:'引用修正',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{greet.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
      if(first.ok)throw Error('Expected unknown reference');feedback=first.feedback;draft=input.compiler.snapshot().document
      return {steps:2,output:fixtureSubmit(input,{submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/nodesByKey/result/config/text',value:'{{start.text}}'}]}})}
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.candidateAttempts).toBe(2)
    expect(draft.nodesByKey.result.config.text).toBe('{{greet.text}}');expect(feedback.issues[0].code).toBe('INVALID_REFERENCE')
    expect(task.candidate!.nodes.at(-1)!.config.text).toBe(`{{${task.candidate!.nodes[0]!.id}.text}}`)
  })

  it('repairs hash-wrapped references instead of publishing them or treating syntax as permission denial',async()=>{
    const f=fixture();let feedback:any
    f.generate.mockImplementation(async input=>{
      const first=input.compiler.submit({submission:{mode:'create',title:'引用语法',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'输入文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{#start.text#}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
      if(first.ok)throw Error('Expected invalid syntax');feedback=first.feedback
      return {steps:2,output:fixtureSubmit(input,{submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/nodesByKey/result/config/text',value:'{{start.text}}'}]}})}
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.candidateAttempts).toBe(2)
    expect(feedback.issues[0].code).toBe('INVALID_REFERENCE');expect(f.options.publish).toHaveBeenCalledTimes(1)
    expect(task.candidate!.nodes.at(-1)!.config.text).not.toContain('{{#')
  })

  it('blocks forbidden fixed-node changes and does not spend repair attempts trying to remove protection',async()=>{
    const baseline=makeWorkflow('workspace');baseline.revision=1;baseline.nodes[1]!.fixed=true
    const f=fixture({baseline,run:async input=>{input.beforeStep?.(20,8192);const next=candidate(input),graph=JSON.parse(next.graphJson);graph.nodes[1].config.text='changed';next.graphJson=JSON.stringify(graph);return {output:next,steps:1,usage:{totalTokens:20}}}})
    const task=await f.service.start(request({operation:'revise',targetWorkflowId:baseline.id,expectedRevision:1}),f.caller)
    expect(task.state).toBe('blocked');expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('can save a valid editable graph with missing local configuration, without claiming execution',async()=>{
    const f=fixture({canRun:false}),task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.readiness?.canRun).toBe(false)
    expect(task.events.at(-1)?.message).toContain('尚未执行')
  })

  it('re-stamps an uncommitted candidate digested in legacy key order instead of failing boot (r30)',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    const reorder=(flow:Workflow)=>Object.fromEntries(Object.entries(flow).reverse()) as Workflow
    f.replace(raw=>{raw.state='failed';delete raw.commit;delete raw.receipt;raw.candidate=reorder(raw.candidate!);raw.candidateDigest=planningDigest(raw.candidate)})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.candidateDigest).toBe(planningDigest(restored.candidate));expect(restored.candidateDigest).toBe(task.candidateDigest)
    f.replace(raw=>{raw.candidate=reorder(raw.candidate!);raw.candidateDigest='0'.repeat(64)})
    expect(()=>f.reopen()).toThrow('摘要')
  })
  it('does not turn provider or readiness failures into candidate-repair model calls',async()=>{
    const provider=fixture({run:async()=>{throw new Error('provider unavailable')}})
    expect((await provider.service.start(request(),provider.caller)).state).toBe('failed');expect(provider.generate).toHaveBeenCalledOnce()
    const readiness=fixture();readiness.options.readiness=vi.fn(async()=>{throw new Error('readiness unavailable')})
    expect((await readiness.service.start(request(),readiness.caller)).state).toBe('failed');expect(readiness.generate).toHaveBeenCalledOnce()
    expect(readiness.options.publish).not.toHaveBeenCalled()
  })

  it('allows unknown usage while retaining the finite candidate repair boundary',async()=>{
    const f=fixture()
    f.generate.mockImplementation(async input=>{
      for(let attempt=0;attempt<3;attempt++){
        input.beforeStep?.(20_000,undefined)
        input.compiler.rejectWire({},[{code:'COMPILER_TOOL_SCHEMA_INVALID',message:'缺少 submission',allowedPaths:[]}])
      }
      throw new PlanningAgentError('PLANNING_REPAIR_LIMIT','本阶段提交次数已达上限')
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed');expect(task.diagnostics.at(-1)?.code).toBe('PLANNING_REPAIR_LIMIT')
    expect(task.unknownTokens).toBe(0);expect(task.unknownUsageCalls).toBe(3);expect(task.observedInputBytes).toBe(60_000);expect(task.reservedTokens).toBe(0);expect(task.steps).toBe(3)
    expect(f.generate).toHaveBeenCalledOnce();expect(task.candidateAttempts).toBe(3)
    expect(f.reopen().get(task.id,f.caller).unknownTokens).toBe(task.unknownTokens)
  })

  it('deduplicates concurrent request IDs into a single task and child call',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    const f=fixture({run:async input=>{input.beforeStep?.(20,8192);await gate;return {output:candidate(input),steps:1,usage:{totalTokens:20}}}})
    const first=f.service.start(request(),f.caller),second=f.service.start(request(),f.caller)
    release();const [a,b]=await Promise.all([first,second])
    expect(a.id).toBe(b.id);expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
    await expect(f.service.start(request({instruction:'different'}),f.caller)).rejects.toThrow('REQUEST_ID_CONFLICT')
  })

  it('admits at most two planner children globally and one per workspace before shared model admission',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    let active=0,maximum=0;const byWorkspace=new Map<string,number>(),workspaceMaximum=new Map<string,number>()
    const f=fixture({run:async input=>{
      const workspace=input.parent.id;active++;maximum=Math.max(maximum,active)
      byWorkspace.set(workspace,(byWorkspace.get(workspace)??0)+1);workspaceMaximum.set(workspace,Math.max(workspaceMaximum.get(workspace)??0,byWorkspace.get(workspace)!))
      try{await Promise.race([gate,new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}))]);input.signal.throwIfAborted();return {output:candidate(input),steps:0,usage:{totalTokens:20}}}
      finally{active--;byWorkspace.set(workspace,byWorkspace.get(workspace)!-1)}
    }})
    f.options.admission=new ModelAdmission(8,8)
    const originalContext=f.options.context
    f.options.context=async(req,owner)=>{const context=await originalContext(req,owner);context.workflow.workspaceId=owner.workspaceId;return context}
    const calls=['a','a','b','c'].map((workspace,index)=>f.service.start(request({requestId:`parallel-${index}`,preview:true}),{...f.caller,parent:{id:workspace} as Agent,workspaceId:workspace}))
    await vi.waitFor(()=>expect(active).toBe(2))
    expect(f.generate).toHaveBeenCalledTimes(2);expect([...byWorkspace.values()].every(count=>count<=1)).toBe(true)
    release();expect((await Promise.all(calls)).map(task=>task.state)).toEqual(['ready','ready','ready','ready'])
    expect(maximum).toBe(2);expect([...workspaceMaximum.values()]).toEqual([1,1,1])
  })

  it('rejects a seventh active workspace request without creating it or consuming a pending answer',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    const f=fixture({run:async(input,attempt)=>{
      if(attempt===1)return {output:waiting,steps:0,usage:{totalTokens:20}}
      await Promise.race([gate,new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}))]);input.signal.throwIfAborted()
      return {output:candidate(input),steps:0,usage:{totalTokens:20}}
    }})
    const waitingTask=await f.service.start(request({requestId:'waiting'}),f.caller)
    const calls=Array.from({length:6},(_,index)=>f.service.start(request({requestId:`queued-${index}`}),f.caller))
    await vi.waitFor(()=>expect(f.generate).toHaveBeenCalledTimes(2))
    await expect(f.service.start(request({requestId:'too-many'}),f.caller)).rejects.toThrow('PLANNER_BUSY')
    await expect(f.service.answer(waitingTask.id,waitingTask.revision,[{questionId:'q1',answer:'文本'}],f.caller)).rejects.toThrow('PLANNER_BUSY')
    expect(f.service.get(waitingTask.id,f.caller)).toEqual(waitingTask);expect(f.stored().tasks).toHaveLength(7)
    expect(f.stored().tasks.some(task=>task.request.requestId==='too-many')).toBe(false)
    release();expect((await Promise.all(calls)).every(task=>task.state==='published')).toBe(true)
    expect((await f.service.answer(waitingTask.id,waitingTask.revision,[{questionId:'q1',answer:'文本'}],f.caller)).state).toBe('published')
  })

  it('releases the planning slot when cancellation interrupts shared admission before a child starts',async()=>{
    const f=fixture();f.options.admission=new ModelAdmission(1,1)
    const held=await f.options.admission.acquire('business-run',1,f.caller.signal,f.caller.workspaceId)
    const acquisition=vi.spyOn(f.options.admission,'acquire')
    const pending=f.service.start(request(),f.caller)
    await vi.waitFor(()=>expect(acquisition).toHaveBeenCalledOnce())
    const id=f.stored().tasks[0]!.id
    expect((await f.service.cancel(id,f.caller)).state).toBe('cancelled');expect((await pending).childAttempts).toBe(0)
    expect(f.generate).not.toHaveBeenCalled();held()
    expect((await f.service.start(request({requestId:'after-cancel'}),f.caller)).state).toBe('published')
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it('waits for child cleanup before cancel returns and never publishes late candidate output',async()=>{
    let started!:()=>void,finish!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve}),cleanup=new Promise<void>(resolve=>{finish=resolve})
    const f=fixture({run:async input=>{input.beforeStep?.(20,8192);started();await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));await cleanup;return {output:candidate(input),steps:1,usage:{totalTokens:20}}}})
    const pending=f.service.start(request(),f.caller);await ready
    const id=f.stored().tasks[0]!.id;let returned=false
    const cancel=f.service.cancel(id,f.caller).then(value=>{returned=true;return value})
    await Promise.resolve();expect(returned).toBe(false);finish()
    expect((await cancel).state).toBe('cancelled');expect((await pending).state).toBe('cancelled');expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('gives cleanup failure priority over an aborted caller and persists blocked state',async()=>{
    const f=fixture({run:async input=>{input.beforeStep?.(20,8192);f.controller.abort(new Error('用户取消'));throw new PlanningAgentCleanupError(new Error('teardown'))}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('blocked');expect(task.diagnostics.at(-1)?.code).toBe('PLANNER_CLEANUP_FAILED')
    expect(task.unknownTokens).toBe(0);expect(task.unknownUsageCalls).toBe(1);expect(task.reservedTokens).toBe(0)
  })

  it('persists public-publish authorization failure while a read-only preview still creates no files',async()=>{
    const f=fixture(),task=await f.service.start(request({preview:true}),f.caller)
    f.options.authorize=vi.fn((_task,_caller,write)=>{if(write)throw new Error('当前为规划模式，只读')})
    const denied=await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    expect(denied.state).toBe('blocked');expect(f.service.get(task.id,f.caller).state).toBe('blocked')
    expect(existsSync(join(f.directory,'planning'))).toBe(false);expect(f.options.publish).not.toHaveBeenCalled()
  })

  it('does not retry a publication revision conflict through another candidate generation',async()=>{
    const f=fixture();f.options.publish=vi.fn(async()=>{throw new Error('REVISION_CONFLICT：版本变化')})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('conflict');expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
    expect(f.reopen().get(task.id,f.caller).state).toBe('conflict')
  })

  it('recovers an atomic receipt after publish throws, including cancellation after commit',async()=>{
    const f=fixture(),publish=f.options.publish
    f.options.publish=vi.fn(async(...args)=>{await publish(...args);f.controller.abort(new Error('用户取消'));throw new Error('post-commit failure')})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published');expect(task.receipt?.kind).toBe('created');expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it.each(['throw','missing'] as const)('blocks uncertain publication (%s) and never attempts a second publish',async mode=>{
    const f=fixture();f.options.publish=vi.fn(async()=>{if(mode==='throw')throw new Error('disk acknowledgement failed')})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('blocked');expect(task.diagnostics.at(-1)?.code).toBe('PUBLISH_UNCERTAIN')
    expect((await f.service.start(request(),f.caller)).state).toBe('blocked')
    expect(f.options.publish).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledOnce()
    await expect(f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
  })

  it('restores a publishing task from its canonical atomic receipt without rerunning the model or publication',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    f.replace(value=>{value.state='publishing';delete value.receipt;value.reservedTokens=500})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.receipt).toEqual(task.receipt);expect(restored.unknownTokens).toBe(0);expect(restored.reservedTokens).toBe(500)
    expect(f.reopen().get(task.id,f.caller)).toMatchObject({unknownTokens:0,reservedTokens:500})
    expect(f.options.publish).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledOnce()
  })

  it.each(['published','publishing'] as const)('restores a historical %s hash-reference candidate from its receipt without replaying publication',async state=>{
    const f=fixture(),task=await f.service.start(request(),f.caller),historical=historicalHashCandidate(f,state)
    const next=f.reopen(),restored=next.get(task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.candidate).toEqual(historical.candidate)
    expect(restored.candidateDigest).toBe(historical.candidateDigest);expect(restored.receipt).toEqual(historical.receipt)
    expect((await next.start(request(),f.caller)).id).toBe(task.id)
    expect((await next.publish(task.id,restored.revision,restored.candidateDigest!,f.caller)).receipt).toEqual(historical.receipt)
    expect(f.reopen().get(task.id,f.caller).receipt).toEqual(historical.receipt)
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it.each(['published','publishing','ready'] as const)('loads historical %s template syntax without invalidating commit evidence or replaying publication',async state=>{
    const f=fixture(),task=await f.service.start(request(),f.caller),historical=historicalHashCandidate(f,state,true)
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.candidate).toEqual(historical.candidate);expect(restored.candidateDigest).toBe(historical.candidateDigest)
    expect(restored.state).toBe(state==='ready'?'blocked':'published')
    if(state==='ready')expect(restored.diagnostics).toContainEqual(expect.objectContaining({code:'STORED_CANDIDATE_CONTRACT_CHANGED',message:expect.stringContaining('TEMPLATE_SYNTAX_UNSUPPORTED')}))
    else expect(restored.receipt).toEqual(historical.receipt)
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it('loads but blocks an uncommitted ready candidate rejected by the current reference contract',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller),historical=historicalHashCandidate(f,'ready')
    const next=f.reopen(),restored=next.get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics).toContainEqual(expect.objectContaining({code:'STORED_CANDIDATE_CONTRACT_CHANGED',message:expect.stringContaining('INVALID_REFERENCE')}))
    expect(restored.candidate).toEqual(historical.candidate);expect(restored.candidateDigest).toBe(historical.candidateDigest)
    await expect(next.publish(task.id,restored.revision,restored.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
    expect(f.reopen().get(task.id,f.caller).state).toBe('blocked')
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it.each(['published','publishing'] as const)('blocks a historical invalid %s candidate with no canonical receipt without replay',async state=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    historicalHashCandidate(f,state);f.receipts.clear()
    const next=f.reopen(),restored=next.get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.at(-1)?.code).toBe('PUBLISH_UNCERTAIN')
    await expect(next.publish(task.id,restored.revision,restored.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it('marks uncommitted active records interrupted and preserves inert historical estimates across restarts',async()=>{
    const f=fixture({run:async input=>{input.beforeStep?.(20,8192);return {output:waiting,steps:1,usage:{totalTokens:20}}}}),task=await f.service.start(request(),f.caller)
    f.replace(value=>{value.state='authoring';value.reservedTokens=1200;value.unknownTokens=300;value.pendingUsageCalls=2;value.unknownUsageCalls=1})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('interrupted');expect(restored.unknownTokens).toBe(300);expect(restored.reservedTokens).toBe(1200)
    expect(restored).toMatchObject({pendingUsageCalls:0,unknownUsageCalls:3})
    expect((await f.reopen().start(request(),f.caller)).state).toBe('interrupted');expect(f.generate).toHaveBeenCalledOnce()
  })

  it('rejects tampered request, candidate, scope, commit and receipt records without rewriting the original file',async()=>{
    const changes:((task:PlanningTask)=>void)[]=[
      value=>{value.request.instruction='tampered'},value=>{value.candidate!.title='tampered'},value=>{value.context!.workflow.workspaceId='other'},value=>{value.commit!.key='0'.repeat(64)},value=>{value.receipt!.workflowId='other'},value=>{value.preview=true},value=>{value.context!.targetNodeIds=['unrequested']},
    ]
    for(const change of changes){const f=fixture();await f.service.start(request(),f.caller);f.replace(change);const before=readFileSync(f.file,'utf8');expect(()=>f.reopen()).toThrow();expect(readFileSync(f.file,'utf8')).toBe(before)}
  })

  it('does not trust a saved published label when the canonical atomic receipt is missing',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller);f.receipts.clear()
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.at(-1)?.code).toBe('PUBLISH_UNCERTAIN')
    expect(f.options.publish).toHaveBeenCalledOnce()
  })

  it('requires the owning session and workspace for reads, answers, cancellation and publication',async()=>{
    const f=fixture(),task=await f.service.start(request({preview:true}),f.caller)
    const other={...f.caller,sessionId:'different'}
    expect(()=>f.service.get(task.id,other)).toThrow('不属于')
    await expect(f.service.cancel(task.id,other)).rejects.toThrow('不属于')
    await expect(f.service.publish(task.id,task.revision,task.candidateDigest!,other)).rejects.toThrow('不属于')
    await expect(f.service.answer(task.id,task.revision,[],other)).rejects.toThrow('不属于')
  })
})

describe('compact compiler integration with the R7 service',()=>{
  const wire=()=>({submission:{mode:'create',title:'编译测试',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
  it.each(['compact-repair','template-fill'] as const)('persists and restores the r28 draftless rejection and repair in %s',async mode=>{
    const f=fixture();f.options.compilerMode=mode
    const formWire=(value:any)=>{
      if(mode==='compact-repair'){value.submission.nodes=value.submission.forms.map(({template,values,...node}:any)=>({...node,kind:template,config:values}));delete value.submission.forms}
      return value
    }
    f.options.driver.generate=vi.fn(async input=>{
      const compiler=input.compiler!
      if(mode==='template-fill')(compiler as any).queryTemplates(['if'])
      const initial=formWire(r28Filling())
      if(mode==='compact-repair')delete initial.submission.title
      const issues=submissionSchemaIssues(compiler.nextSchema!,initial)
      expect(issues).toHaveLength(1)
      expect(compiler.rejectWire(initial,issues)).toMatchObject({ok:false,feedback:{draftRevision:0,remainingSubmissions:2}})
      expect(compiler.submit(r28Repair())).toMatchObject({ok:false,feedback:{issues:[{code:'PATCH_NO_DRAFT'}],remainingSubmissions:1}})
      const stored=f.stored().tasks[0]!
      expect(stored.state).toBe('repairing');expect(stored.candidateAttempts).toBe(2)
      expect(stored.compilerDraft).toMatchObject({revision:0,document:r28Repair().submission,issues:[{code:'PATCH_NO_DRAFT'}],checkpoint:{state:'clarification',revision:0,submissions:2,issues:[]}})
      expect(stored.compilerDraft!.checkpoint).not.toHaveProperty('document')
      expect(stored.events.at(-1)!.message).toContain('尚无可修复草稿')
      const snapshotDirectory=mkdtempSync(join(tmpdir(),'planning-r28-restart-'));directories.push(snapshotDirectory)
      cpSync(join(f.directory,'planning'),join(snapshotDirectory,'planning'),{recursive:true})
      const restarted=new WorkflowPlanningService({...f.options,directory:snapshotDirectory});services.push(restarted)
      expect(restarted.get(stored.id,f.caller)).toMatchObject({state:'interrupted',candidateAttempts:2,compilerDraft:{checkpoint:stored.compilerDraft!.checkpoint}})
      const fixed=compiler.submit(formWire(r28Corrected()));if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
      return {output:fixed.value,steps:3,usage:{totalTokens:30}}
    })
    const result=await f.service.start(request(),f.caller)
    expect(result.state,JSON.stringify(result.diagnostics)).toBe('published')
    expect(result.candidateAttempts).toBe(3);expect(f.options.publish).toHaveBeenCalledOnce()
    expect(f.reopen().get(result.id,f.caller).state).toBe('published')
  })
  it.each(['compact-repair','template-fill'] as const)('passes entry request.title into the %s planner schema and Host check',async mode=>{
    const title='T23 基线：成绩分级统计',f=fixture();f.options.compilerMode=mode
    f.options.driver.generate=vi.fn(async input=>{
      const compiler=input.compiler!,schema=compiler.nextSchema!
      assertObjectJsonSchema(schema)
      expect(schema.properties!.submission!.oneOf![0]!.properties!.title).toEqual({type:'string',const:title})
      expect(compiler.instructions).toContain('CREATE 工作流级 title 必填')
      const value:any=wire()
      if(mode==='template-fill'){
        value.submission.forms=value.submission.nodes.map(({kind,config,...node}:any)=>({...node,template:kind,values:config}));delete value.submission.nodes
      }
      expect(validateJsonSchemaValue(schema,value).length).toBeGreaterThan(0)
      const rejected=compiler.submit(value)
      expect(rejected).toMatchObject({ok:false,feedback:{issues:[expect.objectContaining({code:'COMPILER_TOOL_SCHEMA_INVALID',path:'/title'})]}})
      const fixed=compiler.submit({submission:{mode:'repair',draftRevision:compiler.snapshot().revision,patches:[{op:'replace',path:'/title',value:title}]}})
      if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
      return {output:fixed.value,steps:2,usage:{totalTokens:30}}
    })
    const entry=parsePlanningEntry({...request({title}),moduleCheck,execution:{mode:'design-only'}},false)
    expect(entry.request.title).toBe(title)
    const task=await f.service.start(entry.request,f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.request.title).toBe(title);expect(task.candidate!.title).toBe(title)
    expect(task.request.moduleCheck).toEqual(moduleCheck)
    expect(f.reopen().get(task.id,f.caller).request.moduleCheck).toEqual(moduleCheck)
    for(const [input] of f.generate.mock.calls){expect(input.prompt).not.toContain('moduleCheck');expect(input.prompt).not.toContain(moduleCheck.notApplicable)}
    expect(f.options.publish).toHaveBeenCalledOnce()
  })
  it.each(['工具参数未通过 SDK 工具 Schema 校验，未接受候选','工具 Schema 拒绝（不是权限问题）'])('classifies commit rejection as failed, preserves its code and reloads old blocked tasks: %s',async message=>{
    const f=fixture({run:async()=>{throw new CompilerError('COMPILER_COMMIT_REJECTED',message,undefined,true)}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed')
    expect(task.diagnostics.at(-1)).toEqual({code:'COMPILER_COMMIT_REJECTED',message})
    expect(task.diagnostics.some(issue=>issue.code==='PERMISSION_BLOCKED')).toBe(false)
    expect(f.reopen().get(task.id,f.caller).state).toBe('failed')
    expect(f.options.publish).not.toHaveBeenCalled()
    f.replace(stored=>{stored.state='blocked';stored.diagnostics=[{code:'PERMISSION_BLOCKED',message:'编译通过但最终工具结果被拒绝，未接受候选'}]})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics[0]!.code).toBe('PERMISSION_BLOCKED')
  })
  it('persists wire rejection without a draft and reloads after an explicit corrected submission',async()=>{
    const f=fixture();f.options.compilerMode='compact-repair'
    f.options.driver.generate=vi.fn(async input=>{
      const initial:any=wire();delete initial.submission.title
      const issues=submissionSchemaIssues(input.compiler!.nextSchema!,initial)
      const rejected=input.compiler!.rejectWire(initial,issues)
      expect(rejected).toMatchObject({ok:false,feedback:{draftRevision:0,remainingSubmissions:2}})
      const stored=f.stored().tasks[0]!
      expect(stored.state).toBe('repairing');expect(stored.candidateAttempts).toBe(1)
      expect(stored.compilerDraft?.checkpoint).toMatchObject({state:'clarification',submissions:1,revision:0})
      expect(stored.compilerDraft?.checkpoint).not.toHaveProperty('document')
      const snapshotDirectory=mkdtempSync(join(tmpdir(),'planning-wire-restart-'));directories.push(snapshotDirectory)
      cpSync(join(f.directory,'planning'),join(snapshotDirectory,'planning'),{recursive:true})
      const restarted=new WorkflowPlanningService({...f.options,directory:snapshotDirectory});services.push(restarted)
      expect(restarted.get(stored.id,f.caller).state).toBe('interrupted')
      const fixed=input.compiler!.submit(wire());if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
      return {output:fixed.value,steps:2,usage:{totalTokens:30}}
    })
    const result=await f.service.start(request(),f.caller)
    expect(result.state,JSON.stringify(result.diagnostics)).toBe('published');expect(result.candidateAttempts).toBe(2)
    expect(f.reopen().get(result.id,f.caller).state).toBe('published')
    expect(f.options.publish).toHaveBeenCalledOnce()
  })
  it('persists invalid draft, repairs within one child, and publishes once',async()=>{
    const f=fixture();f.options.compilerMode='compact-repair'
    f.options.driver.generate=vi.fn(async input=>{
      expect(input.compiler).toBeDefined();input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const initial=wire();initial.submission.nodes[1]!.config.text='{{missing.text}}'
      const first=input.compiler!.submit(initial);if(first.ok)throw Error('expected invalid')
      const stored=f.stored().tasks[0]!
      expect(stored.state).toBe('repairing');expect(stored.compilerDraft?.document).toHaveProperty('nodesByKey')
      input.beforeStep?.(150,undefined);input.beforeSubmission?.()
      const fixed=input.compiler!.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/nodesByKey/result/config/text',value:'{{input.text}}'}]}})
      if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
      return {output:fixed.value,steps:2,usage:{totalTokens:30}}
    })
    const result=await f.service.start(request(),f.caller)
    expect(result.state).toBe('published');expect(result.childAttempts).toBe(1);expect(result.candidateAttempts).toBe(2)
    expect(result.steps).toBe(2);expect(result.spentTokens).toBe(30);expect(f.options.publish).toHaveBeenCalledOnce()
    expect(result.compilerMetrics?.map(m=>m.phase).filter(phase=>!phase.startsWith('span:'))).toEqual(['author:submit','author:patch'])
    expect(f.reopen().get(result.id,f.caller).state).toBe('published')
  })
  it('uses typed distillation, preserves provenance, and keeps current-conversation preview ephemeral',async()=>{
    const f=fixture({conversation:evidence()});f.options.compilerMode='compact-repair'
    f.options.driver.generate=vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const value:any=input.purpose==='distill'?{submission:{mode:'distill',procedure:procedure()}}:wire()
      if(input.purpose==='author')value.submission.coverage.S1=['result']
      const result=input.compiler!.submit(value);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:1,usage:{totalTokens:10}}
    })
    const result=await f.service.start(retrospectiveRequest(),f.caller)
    expect(result.state).toBe('ready');expect(result.distillationAttempts).toBe(1);expect(result.candidateAttempts).toBe(1)
    expect(result.sourceMap?.[0]?.evidenceRefs).toEqual(['e1','e2'])
    expect(result.optimization?.stopReason).toBe('already_deterministic');expect(existsSync(f.file)).toBe(false)
    expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('revoked authorization stops before the next submission and preserves the failed draft',async()=>{
    const f=fixture();f.options.compilerMode='compact-repair';let deny=false
    f.options.authorize=()=>{if(deny)throw Error('FORBIDDEN 权限撤销')}
    f.options.driver.generate=async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const initial=wire();initial.submission.nodes[1]!.config.text='{{missing.text}}';input.compiler!.submit(initial)
      deny=true;input.beforeSubmission?.();throw Error('unreachable')
    }
    const result=await f.service.start(request(),f.caller)
    expect(result.state).toBe('blocked');expect(result.candidateAttempts).toBe(1);expect(result.compilerDraft?.issues.length).toBeGreaterThan(0)
    expect(f.options.publish).not.toHaveBeenCalled()
  })
})

describe('template compiler task migration',()=>{
  const forms=()=>({submission:{mode:'create',title:'填写测试',forms:[{key:'start',template:'input',values:{fields:[{name:'text',label:'文本',required:true}]}},{key:'result',template:'output',values:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
  it('freezes templates, persists filling repairs, and reads them after switching the default back',async()=>{
    const f=fixture();f.options.compilerMode='template-fill'
    f.options.driver.generate=vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const prompt=JSON.parse(input.prompt)
      expect(prompt.templateCatalog.prefetched.entries.length).toBeGreaterThan(0)
      expect(prompt).not.toHaveProperty('semantics')
      expect(input.templateQuery?.(['output'])).toHaveProperty('entries')
      const initial=forms();initial.submission.forms[1]!.values.text='{{missing.text}}'
      const first=input.compiler!.submit(initial);if(first.ok)throw Error('expected invalid')
      const stored=f.stored().tasks[0]!
      expect(stored.templateBinding?.protocolVersion).toBe(1)
      expect(stored.compilerDraft).toMatchObject({format:'template-fill-v1',document:{formsByKey:{result:{template:'output'}}}})
      input.beforeStep?.(150,undefined);input.beforeSubmission?.()
      const fixed=input.compiler!.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/formsByKey/result/values/text',value:'{{input.text}}'}]}})
      if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
      return {output:fixed.value,steps:2,usage:{totalTokens:30}}
    })
    const result=await f.service.start(request(),f.caller)
    expect(result.state,JSON.stringify(result.diagnostics)).toBe('published');expect(result.candidateAttempts).toBe(2)
    expect(result.childAttempts).toBe(1);expect(f.options.publish).toHaveBeenCalledOnce()
    f.options.compilerMode='compact-repair'
    const recovered=f.reopen().get(result.id,f.caller)
    expect(recovered.compilerMode).toBe('template-fill');expect(recovered.templateBinding).toEqual(result.templateBinding)
    expect(f.options.publish).toHaveBeenCalledOnce()
    f.replace(task=>{task.templateBinding!.protocolVersion=2 as any})
    expect(()=>f.reopen()).toThrow()
  })
  it('keeps distillation and preview semantics while authoring with forms',async()=>{
    const f=fixture({conversation:evidence()});f.options.compilerMode='template-fill'
    f.options.driver.generate=vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const value:any=input.purpose==='distill'?{submission:{mode:'distill',procedure:procedure()}}:forms()
      if(input.purpose==='author')value.submission.coverage.S1=['result']
      const result=input.compiler!.submit(value);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:1,usage:{totalTokens:10}}
    })
    const result=await f.service.start(retrospectiveRequest(),f.caller)
    expect(result.state,JSON.stringify(result.diagnostics)).toBe('ready');expect(result.distillationAttempts).toBe(1)
    expect(result.sourceMap?.[0]?.evidenceRefs).toEqual(['e1','e2'])
    expect(existsSync(f.file)).toBe(false);expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('preserves old records without a draft format or template binding',async()=>{
    const f=fixture();const result=await f.service.start(request(),f.caller)
    expect(result.state).toBe('published')
    f.replace(task=>{delete task.compilerMode;delete task.compilerSelection;delete task.compilerDraft;delete task.compilerMetrics})
    f.options.compilerMode='template-fill'
    expect(f.reopen().get(result.id,f.caller).compilerMode).toBeUndefined()
  })
})

function rehearsalFixture(){
  const source=evidence();source.sessionId='trial-child';source.digest=conversationEvidenceDigest(source)
  const f=fixture({conversation:source,run:retrospectiveRun}),context=f.options.context
  f.options.context=async(req,caller)=>({...await context(req,caller),trialTask:{task:'汇总报销',inputs:[],artifacts:[{path:'result.txt',format:'text',requireChanged:false,checks:[{kind:'text-includes',value:'汇总'}]}],reviewItems:[]},trial:{trialId:'trial-rehearsal',rootSessionId:caller.sessionId,childSessionId:source.sessionId,workspaceId:caller.workspaceId,specDigest:'1'.repeat(64),verificationDigest:'2'.repeat(64),evidenceDigest:source.digest,receiptDigest:'3'.repeat(64)}})
  const req=request({preview:false,source:{kind:'verified-trial',trialId:'trial-rehearsal'}})
  return {...f,req}
}
describe('trial skeleton handoff (doc 26)',()=>{
  it('gives the template author a compiled draft with its templates prefetched and reports kept nodes on the receipt',async()=>{
    const call=(seq:number,toolName:string,args:unknown,result='ok')=>[
      {id:`e${seq}`,seq,kind:'tool-call' as const,text:JSON.stringify(args),status:'reported-success' as const,toolName,callId:`c${seq}`,truncated:false},
      {id:`e${seq+1}`,seq:seq+1,kind:'tool-result' as const,text:result,status:'reported-success' as const,toolName,callId:`c${seq}`,truncated:false}]
    const rows=[{name:'甲',amount:'10'},{name:'乙',amount:'20'}]
    const body:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'trial-child',fromSeq:1,throughSeq:6,warnings:[],records:[...call(1,'workflow_http_request',{url:'https://example.com/a',method:'GET'}),
      ...call(3,'workflow_html_select',{html:'x',items:'tr',fields:{name:{selector:'td',text:true},amount:{selector:'td+td',text:true}},limit:2},JSON.stringify({items:rows,count:2})),
      ...call(5,'write',{file_path:'result.txt',content:'汇总\n甲：10\n乙：20\n'})]}
    const source={...body,digest:conversationEvidenceDigest(body)},f=fixture({conversation:source}),context=f.options.context
    f.options.compilerMode='template-fill';f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    f.options.context=async(req,caller)=>({...await context(req,caller),tools:[...tools(),...BUILTIN_TOOLS],nodeIds:Array.from({length:40},(_,index)=>`skeleton-node-${index}`),trialTask:{task:'抓取并写入',inputs:[],artifacts:[{path:'result.txt',format:'text',requireChanged:false,checks:[{kind:'text-includes',value:'汇总'}]}],reviewItems:[]},trial:{trialId:'trial-skeleton',rootSessionId:caller.sessionId,childSessionId:source.sessionId,workspaceId:caller.workspaceId,specDigest:'1'.repeat(64),verificationDigest:'2'.repeat(64),evidenceDigest:source.digest,receiptDigest:'3'.repeat(64)}})
    const prompts:any[]=[]
    f.options.driver.generate=vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const prompt=JSON.parse(input.prompt);prompts.push(prompt)
      let value:any
      if(input.purpose==='distill')value={submission:{mode:'distill',procedure:{...procedure(),steps:[{...procedure().steps[0]!,evidenceRefs:['e1','e2','e3','e4','e5','e6']}]}}}
      else value={submission:prompt.trialSkeleton.draft}
      const result=input.compiler!.submit(value);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:1,usage:{totalTokens:10}}
    })
    const task=await f.service.start(request({preview:false,source:{kind:'verified-trial',trialId:'trial-skeleton'}}),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    const author=prompts.find(prompt=>prompt.trialSkeleton)
    expect(author.trialSkeleton).not.toHaveProperty('forms')
    expect(author.trialSkeleton.draft.forms.find((form:any)=>form.key==='render').values.text).toBe('汇总\n{% for item in select.items %}{{item.name | default("")}}：{{item.amount | default("")}}\n{% endfor %}')
    expect(author.templateCatalog.prefetched.entries.map((entry:any)=>entry.id)).toEqual(expect.arrayContaining(['http','code','template']))
    // T29: a complete draft is reviewed with what it uses, not the whole trial record.
    expect(author.instruction).toContain('本轮审核 Host 生成的草稿')
    expect(author).not.toHaveProperty('trialEvidence');expect(author.trialReport?.verification).toBeUndefined()
    expect(author.runtimeSemantics.nodes.map((node:any)=>node.kind)).toEqual(['template','code'])
    expect(author.templateCatalog.prefetched.entries.map((entry:any)=>entry.id).sort()).toEqual([...new Set(author.trialSkeleton.draft.forms.map((form:any)=>form.template))].sort())
    expect(designVerificationReceipt(task)?.trialSkeleton).toEqual({used:['fetch','select','save'],adjusted:[],meaning:expect.any(String)})
  })
  it('keeps a draft the Host compile rejected and hands the author only its issues to repair (user rule 2026-10-30)',async()=>{
    const call=(seq:number,toolName:string,args:unknown,result='ok')=>[
      {id:`e${seq}`,seq,kind:'tool-call' as const,text:JSON.stringify(args),status:'reported-success' as const,toolName,callId:`c${seq}`,truncated:false},
      {id:`e${seq+1}`,seq:seq+1,kind:'tool-result' as const,text:result,status:'reported-success' as const,toolName,callId:`c${seq}`,truncated:false}]
    const rows=[{name:'甲',amount:'10'},{name:'乙',amount:'20'}]
    const body:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'trial-child',fromSeq:1,throughSeq:6,warnings:[],records:[...call(1,'workflow_http_request',{url:'https://example.com/a',method:'TRACE'}),
      ...call(3,'workflow_html_select',{html:'x',items:'tr',fields:{name:{selector:'td',text:true},amount:{selector:'td+td',text:true}},limit:2},JSON.stringify({items:rows,count:2})),
      ...call(5,'write',{file_path:'result.txt',content:'汇总\n甲：10\n乙：20\n'})]}
    const source={...body,digest:conversationEvidenceDigest(body)},f=fixture({conversation:source}),context=f.options.context
    f.options.compilerMode='template-fill';f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    f.options.context=async(req,caller)=>({...await context(req,caller),tools:[...tools(),...BUILTIN_TOOLS],nodeIds:Array.from({length:40},(_,index)=>`skeleton-node-${index}`),trialTask:{task:'抓取并写入',inputs:[],artifacts:[{path:'result.txt',format:'text',requireChanged:false,checks:[{kind:'text-includes',value:'汇总'}]}],reviewItems:[]},trial:{trialId:'trial-skeleton',rootSessionId:caller.sessionId,childSessionId:source.sessionId,workspaceId:caller.workspaceId,specDigest:'1'.repeat(64),verificationDigest:'2'.repeat(64),evidenceDigest:source.digest,receiptDigest:'3'.repeat(64)}})
    const prompts:any[]=[]
    f.options.driver.generate=vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const prompt=JSON.parse(input.prompt);prompts.push(prompt)
      let value:any
      if(input.purpose==='distill')value={submission:{mode:'distill',procedure:{...procedure(),steps:[{...procedure().steps[0]!,evidenceRefs:['e1','e2','e3','e4','e5','e6']}]}}}
      else{
        // The author fixes only the reported node; every other node is submitted as drafted.
        const draft=structuredClone(prompt.trialSkeleton.draft);draft.forms.find((form:any)=>form.key==='fetch').values.method='GET'
        value={submission:draft}
      }
      const result=input.compiler!.submit(value);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:1,usage:{totalTokens:10}}
    })
    const task=await f.service.start(request({preview:false,source:{kind:'verified-trial',trialId:'trial-skeleton'}}),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    const author=prompts.find(prompt=>prompt.trialSkeleton)
    expect(author.instruction).toContain('先只改这几处');expect(author.trialSkeleton.instruction).toContain('draftIssues')
    expect(author.trialSkeleton.draftIssues).toEqual([expect.objectContaining({code:'INVALID_NODE_CONFIG',path:'/formsByKey/fetch/values'})])
    expect(author.trialSkeleton.draft.forms.map((form:any)=>form.key)).toEqual(expect.arrayContaining(['fetch','select','render']))
    expect(author.trialSkeleton).not.toHaveProperty('forms')
    expect(prompts.filter(prompt=>prompt.trialSkeleton)).toHaveLength(1)
  })
})

describe('Host post-save rehearsal run dispatch',()=>{
  it('journals one attempt after creation, records runId before waiting and never repeats on publish, duplicate start or restore',async()=>{
    const f=rehearsalFixture()
    f.options.runCreated=vi.fn(async(task,_caller,started)=>{
      expect(task.receipt?.kind).toBe('created')
      expect(f.stored().tasks[0]!.firstRun?.status).toBe('starting')
      started('run-first')
      expect(f.stored().tasks[0]!.firstRun?.runId).toBe('run-first')
    })
    const task=await f.service.start(f.req,f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.firstRun).toEqual({requestId:`trial-first-${task.id}`,status:'recorded',runId:'run-first'})
    await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    await f.service.start(f.req,f.caller)
    expect(f.reopen().get(task.id,f.caller).firstRun).toEqual(task.firstRun)
    expect(f.options.runCreated).toHaveBeenCalledOnce()
  })
  it('keeps the first run alive when the 20-minute planning deadline passes (r31)',async()=>{
    vi.useFakeTimers()
    const f=rehearsalFixture();let runSignal!:AbortSignal,release!:()=>void,dispatched!:()=>void
    const ready=new Promise<void>(resolve=>{dispatched=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
    f.options.runCreated=vi.fn(async(_task,caller,started)=>{runSignal=caller.signal;started('run-first');dispatched();await hold})
    const pending=f.service.start(f.req,f.caller);await ready
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(runSignal.aborted).toBe(false);release()
    const task=await pending
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.firstRun).toMatchObject({status:'recorded',runId:'run-first'})
  })
  it('retains the saved receipt on run admission failure and never silently retries',async()=>{
    const f=rehearsalFixture();f.options.runCreated=vi.fn(async()=>{throw new Error('缺少运行依赖')})
    const task=await f.service.start(f.req,f.caller)
    expect(task.state).toBe('published');expect(task.receipt?.kind).toBe('created')
    expect(task.firstRun).toMatchObject({status:'failed',error:'缺少运行依赖'})
    expect(task.diagnostics.at(-1)?.code).toBe('FIRST_RUN_FAILED')
    await f.reopen().publish(task.id,task.revision,task.candidateDigest!,f.caller)
    expect(f.options.runCreated).toHaveBeenCalledOnce()
  })
  it.each(['create','revise'] as const)('does not run ordinary %s receipts',async operation=>{
    const f=fixture({baseline:{...makeWorkflow('workspace'),revision:operation==='create'?0:1}});f.options.runCreated=vi.fn()
    const task=await f.service.start(request(operation==='revise'?{operation,targetWorkflowId:f.baseline.id,expectedRevision:f.baseline.revision}:{}),f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.receipt?.kind).toBe(operation==='revise'?'proposed':'created')
    expect(task.firstRun).toBeUndefined();expect(f.options.runCreated).not.toHaveBeenCalled()
  })
  it('keeps a crashed run dispatch interrupted and never redispatches',async()=>{
    const f=rehearsalFixture();f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    const task=await f.service.start(f.req,f.caller)
    await f.service.close()
    f.replace(row=>{row.firstRun!.status='starting';row.state='publishing'})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.firstRun).toMatchObject({status:'interrupted',runId:'run-first'})
    expect(f.options.runCreated).toHaveBeenCalledOnce()
  })
  it('leaves trial workflows saved before first runs existed unchanged on restore',async()=>{
    const f=rehearsalFixture();f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    const task=await f.service.start(f.req,f.caller)
    await f.service.close()
    f.replace(row=>{delete row.firstRun})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.firstRun).toBeUndefined()
    expect(f.options.runCreated).toHaveBeenCalledOnce()
  })
  it('marks a save interrupted before its first-run record without dispatching',async()=>{
    const f=rehearsalFixture();f.options.runCreated=vi.fn(async(_task,_caller,started)=>{started('run-first')})
    const task=await f.service.start(f.req,f.caller)
    await f.service.close()
    f.replace(row=>{delete row.firstRun;row.state='publishing'})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.firstRun).toMatchObject({status:'interrupted'});expect(f.options.runCreated).toHaveBeenCalledOnce()
  })
})
