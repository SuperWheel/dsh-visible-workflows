import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeWorkflow, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import type { PlanningContext, PlannerOutput, PlanningRequest } from '../src/shared/planning-types.ts'
import type { ConversationEvidence, TaskProcedure } from '../src/shared/retrospective.ts'
import type { OptimizationOutput } from '../src/shared/planning-optimization.ts'
import { planningCandidateIssues, projectWorkflow } from '../src/shared/planning-projection.ts'
import { parsePlanningRequest } from '../src/shared/planning-schema.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { WorkflowPlanningService, planningDigest, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { PlanningAgentError, PlanningAgentCleanupError, type PlanningAgentInput } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './fixtures/planning-edits.ts'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{vi.useRealTimers();for(const clean of cleanups.splice(0))await clean()})
const node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']):WorkflowNode=>({id,kind,title:id,number:'',x:0,y:0,fixed:false,config})
function flow():Workflow{
  const nodes=[node('start','input',{fields:[{name:'name',label:'姓名',required:true}]}),node('greet','llm',{prompt:'按固定格式回复：你好 {{input.name}}'}),node('punctuate','llm',{prompt:'在 {{greet.text}} 末尾添加感叹号'}),node('out','output',{text:'{{punctuate.text}}',outputName:'result'})]
  return {...makeWorkflow('workspace','固定问候'),nodes,edges:nodes.slice(1).map((n,i)=>({id:`planning-edge-${i+1}`,source:nodes[i]!.id,target:n.id}))}
}
function evidence():ConversationEvidence{
  const base:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'root',fromSeq:1,throughSeq:5,warnings:[],records:[
    {id:'e1',seq:1,kind:'user',text:'按固定格式生成问候并加感叹号',status:'statement',truncated:false},
    {id:'e2',seq:2,kind:'tool-call',text:'{"name":"Ada"}',status:'reported-success',truncated:false,callId:'call-1',toolName:'completed-example'},
    {id:'e3',seq:3,kind:'tool-result',text:'{"text":"你好 Ada"}',status:'reported-success',truncated:false,callId:'call-1',toolName:'completed-example'},
    {id:'e4',seq:4,kind:'tool-call',text:'{"text":"你好 Ada"}',status:'reported-success',truncated:false,callId:'call-2',toolName:'completed-example'},
    {id:'e5',seq:5,kind:'tool-result',text:'{"text":"你好 Ada!"}',status:'reported-success',truncated:false,callId:'call-2',toolName:'completed-example'},
  ]}
  return {...base,digest:conversationEvidenceDigest(base)}
}
const procedure:TaskProcedure={goal:'生成固定格式问候',parameters:[{name:'name',description:'姓名'}],rules:['问候和感叹号不可省略'],steps:[{id:'S1',title:'格式化',instruction:'按固定格式处理',dependsOn:[],evidenceRefs:['e1','e2','e3','e4','e5'],requiresReview:false}],excluded:[],reviewItems:[]}
const request=(changes:Partial<PlanningRequest>={}):PlanningRequest=>({requestId:'v002-test',operation:'create',instruction:'从已完成任务生成问候流程并减少模型调用',preview:true,source:{kind:'current-conversation'},...changes})
const ref=(pointer:string,evidenceId='e3')=>({evidenceId,pointer})
function optimized(input:PlanningAgentInput):OptimizationOutput{
  const prompt=fixturePlanningPrompt(input,flow()),graph=prompt.graph
  const target=graph.nodes.find((n:WorkflowNode)=>n.kind==='llm')
  if(!target)return {outcome:'unchanged',graphJson:'',summary:'已经是确定性流程',replacements:[],regressionCases:[]}
  target.kind='template';target.config={text:target.id==='greet'?'你好 {{input.name}}':'{{greet.text}}!'}
  return {outcome:'candidate',graphJson:JSON.stringify(graph),summary:`将 ${target.id} 改为模板`,replacements:[{nodeId:target.id,reason:'规则明确的文本格式化'}],regressionCases:[{id:`case-${target.id}`,nodeId:target.id,workflowInputs:ref('','e2'),...(target.id==='punctuate'?{upstreamOutputs:{greet:ref('')}}:{}),expected:ref('',target.id==='greet'?'e3':'e5')}]}
}
function fixture(config:{optimize?:(input:PlanningAgentInput,round:number)=>Promise<unknown>;evidence?:ConversationEvidence;baseline?:Workflow;authorize?:()=>void}={}){
  const directory=mkdtempSync(join(tmpdir(),'planning-v002-')),baseline=config.baseline??flow(),source=config.evidence??evidence()
  const controller=new AbortController(),caller:PlanningCaller={parent:{id:'root'} as Agent,sessionId:'root',workspaceId:'workspace',signal:controller.signal}
  const receipts=new Map<string,PlanningReceipt>();let rounds=0
  const driver={generate:vi.fn(async(input:PlanningAgentInput)=>{
    input.onTask?.(`child-${driver.generate.mock.calls.length}`);input.beforeStep?.(100,undefined)
    let output:unknown
    if(input.purpose==='distill')output={outcome:'procedure',procedureJson:JSON.stringify(procedure),summary:'已提炼',questions:[]}
    else if(input.purpose==='optimize')output=config.optimize?await config.optimize(input,++rounds):optimized(input)
    else output={outcome:'candidate',graphJson:JSON.stringify(projectWorkflow(baseline)),summary:'原始候选',questions:[],assumptions:[],requirementCoverage:[{requirementId:'R1',nodeIds:baseline.nodes.map(n=>n.id),note:'原始要求'},{requirementId:'S1',nodeIds:['greet','punctuate'],note:'对应执行步骤'}]} satisfies PlannerOutput
    return {output:fixturePlanningEdits(input,output,baseline),steps:1,usage:{totalTokens:100_000}}
  })}
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,driver,admission:new ModelAdmission(2,2),
    context:async():Promise<PlanningContext>=>({workflow:{...structuredClone(baseline),nodes:structuredClone([baseline.nodes[0]!,baseline.nodes.at(-1)!]),edges:[{id:'scaffold',source:baseline.nodes[0]!.id,target:baseline.nodes.at(-1)!.id}]},operation:'create',targetNodeIds:[],nodeIds:baseline.nodes.map(n=>n.id),subagentIds:[],environmentIds:[],tools:[],model:{provider:'offline',model:'fixture'},conversation:source}),
    authorize:()=>config.authorize?.(),readiness:async candidate=>({workflowId:candidate.id,revision:candidate.revision,canRun:true,issues:[]}),
    publish:vi.fn(async(candidate,_task,_caller,commit)=>{receipts.set(commit.key,{...commit,workflowId:candidate.id,revision:1,kind:'created'})}),receipt:key=>receipts.get(key),
  }
  const services:WorkflowPlanningService[]=[],open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service},service=open()
  cleanups.push(async()=>{await Promise.all(services.map(s=>s.close()));rmSync(directory,{recursive:true,force:true})})
  return {service,caller,controller,driver,directory,baseline,open,options,source,file:join(directory,'planning/tasks.json')}
}

describe('v0.0.2 retrospective optimizer integration with real Graphon replay',()=>{
  it('keeps an over-target first candidate, continues optimization and returns the measured comparison',async()=>{
    const f=fixture(),task=await f.service.start(request({optimizationTarget:{maxModelCalls:0,maxAgentCalls:0}}),f.caller)
    expect(task.state).toBe('ready');expect(task.engineVersion).toBe('0.0.2');expect(task.spentTokens,JSON.stringify(task.optimization)).toBe(400_000)
    expect(task.optimization?.baseline.stats.modelNodes).toBe(2)
    expect(task.optimization?.attempts.map(a=>[a.accepted,a.targetEvaluation?.status])).toEqual([[true,'over_target'],[true,'within_target']])
    expect(task.optimization?.selected.stats.modelNodes).toBe(0);expect(task.optimization?.stopReason).toBe('target_met')
    expect(task.optimization?.attempts.every(a=>a.regression?.scope==='node-transform'&&a.regression.passedRecorded===1)).toBe(true)
    // Each Graphon replay and readiness recheck has its own measured span.
    const spans=task.compilerMetrics?.filter(metric=>metric.phase.startsWith('span:'))??[]
    expect(spans.filter(metric=>metric.phase==='span:graphon-regression')).toHaveLength(2)
    expect(spans.filter(metric=>metric.phase==='span:optimization-readiness')).toHaveLength(2)
    expect(spans.some(metric=>metric.phase==='span:optimization'&&metric.durationMs!>=0)).toBe(true)
    expect(task.optimization?.baseline.candidate.nodes.filter(n=>n.kind==='llm')).toHaveLength(2)
    expect(task.candidate?.nodes.filter(n=>n.kind==='template')).toHaveLength(2)
    expect(task.candidate?.edges).toEqual(f.baseline.edges);expect(task.sourceMap).toHaveLength(1)
    const prompts=f.driver.generate.mock.calls.filter(([input])=>input.purpose==='optimize').map(([input])=>JSON.parse(input.prompt))
    expect(prompts[0].sourceMap[0].nodeIds).toEqual(['@3','@4'])
    expect(prompts[1].attempts[0].replacements[0].node).toBe('@3')
    expect(prompts[1].attempts[0].regression.cases[0].node).toBe('@3')
    expect(prompts[1].baseDigest).not.toBe(prompts[0].baseDigest)
    expect(task.sourceMap?.[0]?.nodeIds).toEqual(['greet','punctuate'])
    expect(task.diagnostics).toEqual([]);expect(existsSync(f.file)).toBe(false);expect(f.options.publish).not.toHaveBeenCalled()
    expect((await f.service.start(request({optimizationTarget:{maxModelCalls:0,maxAgentCalls:0}}),f.caller)).id).toBe(task.id)
    expect(f.driver.generate).toHaveBeenCalledTimes(4)
  })
  it('optimizes without a target and retains both candidates when subsequent replay fails',async()=>{
    const f=fixture({optimize:async(input,round)=>{const result=optimized(input);if(round===2){const graph=JSON.parse(result.graphJson);graph.nodes.find((n:WorkflowNode)=>n.id==='punctuate').config.text='wrong';result.graphJson=JSON.stringify(graph)}return result}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.selection).toBe('optimized')
    expect(task.optimization?.attempts.map(a=>a.accepted)).toEqual([true,false])
    expect(task.optimization?.selected.stats.modelNodes).toBe(1);expect(task.optimization?.attempts[1]?.regression?.status).toBe('failed')
    expect(task.optimization?.attempts[1]?.candidate).toBeDefined();expect(task.optimization?.baseline.candidate).toBeDefined()
  })
  it('retains an over-target baseline after two invalid replacements instead of failing planning',async()=>{
    const f=fixture({optimize:async input=>{const result=optimized(input);result.regressionCases=[];return result}})
    const task=await f.service.start(request({optimizationTarget:{maxModelCalls:0}}),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.selected.targetEvaluation.status).toBe('over_target')
    expect(task.optimization?.attempts).toHaveLength(2);expect(task.optimization?.stopReason).toBe('round_limit')
    expect(task.candidate).toEqual(task.optimization?.baseline.candidate)
  })
  it('does not spend an optimization call when no node is one phase one may replace (Desktop r53 B)',async()=>{
    const baseline=flow();for(const n of baseline.nodes)if(n.kind==='llm')n.config.verification={minTextLength:2}
    const f=fixture({baseline}),task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.stopReason).toBe('no_replaceable_node')
    expect(task.optimization?.baseline.stats.modelNodes).toBe(2);expect(task.optimization?.attempts).toEqual([])
    expect(f.driver.generate.mock.calls.map(([input])=>input.purpose)).toEqual(['distill','author'])
  })
  it('does not spend an optimization call when the recorded result is incomplete',async()=>{
    const source=evidence();for(const record of source.records.slice(1))record.status='unknown';source.digest=conversationEvidenceDigest(source)
    // A valid procedure must exclude uncertain data rather than laundering it.
    const f=fixture({evidence:source})
    f.driver.generate.mockImplementation(async input=>{
      input.beforeStep?.(100,undefined)
      const p=structuredClone(procedure);p.steps[0]!.evidenceRefs=['e1'];p.excluded=[{evidenceRefs:['e2','e3','e4','e5'],reason:'结果未知，不作已验证样本'}]
      return {output:fixturePlanningEdits(input,input.purpose==='distill'?{outcome:'procedure',procedureJson:JSON.stringify(p),summary:'仅提炼需求',questions:[]}:{outcome:'candidate',graphJson:JSON.stringify(projectWorkflow(f.baseline)),summary:'原始候选',questions:[],assumptions:[],requirementCoverage:[{requirementId:'R1',nodeIds:['greet']},{requirementId:'S1',nodeIds:['greet','punctuate']}]},f.baseline),steps:1,usage:{totalTokens:100_000}}
    })
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.stopReason).toBe('missing_replay_evidence')
    expect(f.driver.generate.mock.calls.map(([input])=>input.purpose)).toEqual(['distill','author'])
  })
  it('rejects unrelated expected evidence and changes to graph structure',async()=>{
    const f=fixture({optimize:async(input,round)=>{const result=optimized(input);if(round===1)result.regressionCases[0]!.expected=ref('','e99');else{const graph=JSON.parse(result.graphJson);graph.edges.pop();result.graphJson=JSON.stringify(graph)}return result}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.attempts[0]?.diagnostics.some(d=>d.code==='REGRESSION_PROVENANCE_MISMATCH')).toBe(true)
    expect(task.optimization?.attempts[1]?.accepted).toBe(false)
  })
  it('does not accept a nested object as the complete historical node output',async()=>{
    const source=evidence();source.records[2]!.text='{"text":"你好 Ada","json":{"text":"你好 Ada"}}';source.digest=conversationEvidenceDigest(source)
    const f=fixture({evidence:source,optimize:async input=>{const result=optimized(input);result.regressionCases[0]!.expected=ref('/json');return result}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.attempts.every(item=>item.regression?.status==='skipped')).toBe(true)
  })
  it('replays previously replaced ancestors rather than hiding them behind recorded constants',async()=>{
    const source=evidence();source.records[3]!.text='{"name":"Bob"}';source.digest=conversationEvidenceDigest(source)
    const f=fixture({evidence:source,optimize:async input=>{const result=optimized(input);if(result.replacements[0]?.nodeId==='punctuate')result.regressionCases[0]!.workflowInputs=ref('','e4');return result}})
    const task=await f.service.start(request({optimizationTarget:{maxModelCalls:0}}),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.attempts.map(item=>item.accepted)).toEqual([true,false])
    expect(task.optimization?.attempts[1]?.regression?.status).toBe('failed')
    expect(task.optimization?.selected.stats.modelNodes).toBe(1)
    expect(task.optimization?.selected.targetEvaluation.status).toBe('over_target')
  })
  it.each(['PLANNING_STEP_LIMIT','PLANNING_IDLE_TIMEOUT','PLANNING_OUTPUT_INCOMPLETE'])('preserves ready candidate on optimization %s',async code=>{
    const f=fixture({optimize:async()=>{throw new PlanningAgentError(code,'优化阶段保护')}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.candidate).toEqual(task.optimization?.baseline.candidate)
    expect(task.optimization?.attempts[0]?.diagnostics[0]?.code).toBe(code)
    expect(task.optimization?.stopReason).toBe('optimization_interrupted_candidate_retained')
  })
  it('retains baseline after the internal optimization deadline but honors explicit cancellation',async()=>{
    vi.useFakeTimers()
    let started!:()=>void;const startedPromise=new Promise<void>(resolve=>{started=resolve})
    const f=fixture({optimize:async input=>{started();return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}))}})
    const work=f.service.start(request(),f.caller);await startedPromise
    await vi.advanceTimersByTimeAsync(1_200_001)
    const task=await work
    expect(task.state).toBe('ready');expect(task.optimization?.stopReason).toBe('optimization_deadline_candidate_retained')
    expect(task.candidate).toBeDefined();expect(f.options.publish).not.toHaveBeenCalled()
    vi.useRealTimers()
    const cancelled=fixture({optimize:async()=>{cancelled.controller.abort(new Error('用户取消'));throw cancelled.controller.signal.reason}})
    const stopped=await cancelled.service.start(request(),cancelled.caller)
    expect(stopped.state).toBe('cancelled');expect(stopped.candidate).toBeDefined()
  })
  it('does not turn authority or child-cleanup failures into a ready candidate',async()=>{
    const denied=fixture({optimize:async()=>{throw new Error('FORBIDDEN 权限已撤销')}})
    expect((await denied.service.start(request(),denied.caller)).state).toBe('blocked')
    const cleanup=fixture({optimize:async()=>{throw new PlanningAgentCleanupError(new Error('dispose failed'))}})
    expect((await cleanup.service.start(request(),cleanup.caller)).state).toBe('blocked')
  })
  it('rechecks authority before retaining a candidate after the optimizer returns unchanged',async()=>{
    let revoked=false
    const f=fixture({authorize:()=>{if(revoked)throw new Error('FORBIDDEN 权限已撤销')},optimize:async()=>{revoked=true;return {outcome:'unchanged',graphJson:'',summary:'无更多替换',replacements:[],regressionCases:[]}}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('blocked');expect(task.candidate).toBeDefined()
    expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('persists the selected comparison only on explicit publication and verifies it on restart',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    expect(existsSync(f.file)).toBe(false)
    const published=await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    expect(published.state).toBe('published');expect(existsSync(f.file)).toBe(true)
    const restored=f.open().get(task.id,f.caller)
    expect(restored.optimization).toEqual(task.optimization);expect(restored.engineVersion).toBe('0.0.2')
    expect(f.driver.generate).toHaveBeenCalledTimes(4)
    const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.tasks[0].optimization.selected.stats.modelNodes=99
    writeFileSync(f.file,JSON.stringify(raw));expect(()=>f.open()).toThrow('优化报告摘要')
  })
  it('bounds malformed-candidate diagnostics and keeps the valid baseline',async()=>{
    const f=fixture({optimize:async input=>{const result=optimized(input),graph=JSON.parse(result.graphJson);graph.nodes.find((n:WorkflowNode)=>n.id==='greet').config.text=Array.from({length:1001},(_,i)=>`{{missing-${i}.text}}`).join(' ');result.graphJson=JSON.stringify(graph);return result}})
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('ready');expect(task.optimization?.selection).toBe('baseline')
    expect(task.optimization?.attempts.every(a=>a.diagnostics.length<=1000)).toBe(true)
  })
  it.each(['published','ready'] as const)('reads historical optimization contracts for a %s candidate without invalidating its evidence',async state=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    const raw=JSON.parse(readFileSync(f.file,'utf8')),saved=raw.tasks[0] as PlanningTask
    for(const candidate of [saved.candidate!,saved.optimization!.baseline.candidate,...saved.optimization!.attempts.filter(attempt=>attempt.accepted).map(attempt=>attempt.candidate!)]){
      candidate.nodes.find(node=>node.id==='out')!.config.text='{{punctuate.text | upper}}'
      expect(planningCandidateIssues(candidate,saved.context!)).toContainEqual(expect.objectContaining({code:'TEMPLATE_SYNTAX_UNSUPPORTED'}))
    }
    saved.candidateDigest=planningDigest(saved.candidate);saved.optimizationDigest=planningDigest(saved.optimization)
    saved.commit={key:planningDigest([saved.id,saved.candidateDigest,saved.request.operation,saved.provenanceDigest]),digest:saved.candidateDigest}
    saved.receipt={...saved.receipt!,...saved.commit}
    if(state==='ready'){saved.state='ready';delete saved.commit;delete saved.receipt}
    f.options.receipt=()=>saved.receipt
    writeFileSync(f.file,JSON.stringify(raw))
    const restored=f.open().get(task.id,f.caller)
    expect(restored.state).toBe(state==='published'?'published':'blocked')
    expect(restored.optimization).toEqual(saved.optimization);expect(restored.candidateDigest).toBe(saved.candidateDigest)
    expect(restored.diagnostics).toContainEqual(expect.objectContaining({code:'STORED_CANDIDATE_CONTRACT_CHANGED',message:expect.stringContaining('TEMPLATE_SYNTAX_UNSUPPORTED')}))
    if(state==='ready')await expect(f.open().publish(restored.id,restored.revision,restored.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
    expect(f.driver.generate).toHaveBeenCalledTimes(4);expect(f.options.publish).toHaveBeenCalledOnce()
  })
  it('gives user cancellation and revoked authority priority after an internal deadline',async()=>{
    vi.useFakeTimers()
    for(const reason of ['cancel','authority'] as const){
      let notify!:()=>void,revoked=false;const started=new Promise<void>(resolve=>{notify=resolve})
      const f=fixture({authorize:()=>{if(revoked)throw new Error('FORBIDDEN 权限撤销')},optimize:async input=>{
        notify();return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>{
          if(reason==='cancel')f.controller.abort(new Error('用户取消'));else revoked=true
          reject(input.signal.reason)
        },{once:true}))
      }})
      const pending=f.service.start(request(),f.caller);await started;await vi.advanceTimersByTimeAsync(1_200_001)
      const task=await pending;expect(task.state).toBe(reason==='cancel'?'cancelled':'blocked');expect(task.candidate).toBeDefined()
    }
  })
  it('rejects accepted recovery records whose reproducible sample references were removed',async()=>{
    const f=fixture(),task=await f.service.start(request(),f.caller)
    await f.service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    const raw=JSON.parse(readFileSync(f.file,'utf8')),saved=raw.tasks[0]
    delete saved.optimization.attempts[0].regressionCases;saved.optimizationDigest=planningDigest(saved.optimization)
    writeFileSync(f.file,JSON.stringify(raw));expect(()=>f.open()).toThrow('样本引用')
  })
  it('accepts design targets only on retrospective previews and does not mutate runtime policy',async()=>{
    expect(()=>parsePlanningRequest({requestId:'normal',operation:'create',instruction:'x',optimizationTarget:{maxModelCalls:0}})).toThrow('任务提炼')
    const baseline=flow();baseline.executionPolicy={tokenBudget:1,maxAgentTasks:1}
    const f=fixture({baseline}),task=await f.service.start(request({optimizationTarget:{maxModelCalls:0}}),f.caller)
    expect(task.state).toBe('ready');expect(task.candidate?.executionPolicy).toEqual(baseline.executionPolicy)
    expect(task.spentTokens).toBeGreaterThan(baseline.executionPolicy.tokenBudget!)
    expect(task.optimizationDigest).toBe(planningDigest(task.optimization))
  })
})
