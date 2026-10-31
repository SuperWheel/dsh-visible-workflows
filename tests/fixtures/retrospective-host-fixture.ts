import { PlanningStore } from '../../src/host/planning/store.ts'
// The real Cordis Host and registered tools consume synthetic Session events.
// Only history, model generation and Harness catalogs are offline doubles.
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'
import type { PlanningProjection } from '../../src/shared/planning-types.ts'
import type { TaskProcedure } from '../../src/shared/retrospective.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-retrospective-host-')),ctx=new Context(),definitions=new Map<string,any>()
const agent=(id:string,parent?:string):any=>({id,ctx,session:{id,header:{cwd:directory,...(parent?{origin:'subagent',parentSession:parent}:{})},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}})
const main=agent('main'),other=agent('other'),child=agent('child','main'),agents=[main,other,child]
let mainLive=true,externalCalls=0,budgetQuestions=0,observed=0,disposed=0,historyReads=0,observedId='main',revokeAfterObserve=false
const designQuestions:any[]=[]
const prompts:{purpose:string|undefined;prompt:any}[]=[],guide:string[]=[]
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'&&!mainLive?undefined:agents.find(item=>item.id===id),list:()=>agents,roots:()=>[main,other],isOwnedBy:(id:string,owner:any)=>id==='child'&&owner===main,withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Retrospective fixture',path:directory,sessionIds:['main','other']}]}),
  ctx.provide('llm',{
    listProviders:()=>[{id:'fixture',name:'Offline fixture'}],listModels:async()=>[{id:'offline',name:'Offline model'}],
    resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){externalCalls++;throw new Error('No external model call is permitted')},
  }),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:(section:any)=>{guide.push(section.text);return()=>{}}}),ctx.provide('typert',{}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{
    if(request.questions[0]?.id==='scope'){designQuestions.push(request);assert.equal(request.agent,main);return {answers:[{id:'scope',selected:['是']}]}}
    budgetQuestions++;throw new Error('Preview must never ask execution budget')
  }}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner
const message=(role:string,text:string,source:any)=>({id:`${role}-${text.length}`,role,source,content:[{type:'text',text}]})
const events:any[]=[
  {type:'turn/start',data:{turn:0}},
  {type:'user/message',data:message('user','请把本次材料归纳为报告；下次材料可替换。',{kind:'user'})},
  {type:'assistant/message',data:{turn:0,step:0,message:message('assistant','已生成报告，关键结论已列出。',{kind:'model',provider:'fixture',model:'offline'}),stream:[]}},
  {type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
  {type:'turn/start',data:{turn:1}},
  {type:'user/message',data:message('user','把刚刚任务生成工作流，仅预览。CURRENT_REQUEST_SENTINEL',{kind:'user'})},
].map((event,seq)=>({...event,seq,time:seq+1,...(['user/message','assistant/message'].includes(event.type)?{surfaceOp:'append'}:{})}))
const query={observeSession:async(id:string,options:any)=>{
  observed++;assert.equal(id,'main','Host must read only the current verified root');assert.equal(options.projectionMode,'none');options.signal?.throwIfAborted()
  if(revokeAfterObserve)mainLive=false
  return {header:{id:observedId,cwd:directory,origin:'user',depth:0},inheritedEventCount:0,cursor:events.length-1,get events(){historyReads++;return structuredClone(events)},[Symbol.dispose](){disposed++}}
}}
planner.options.driver.generate=async(input:PlanningAgentInput)=>{
  input.signal.throwIfAborted();input.beforeStep?.(30,100);input.onTask?.(`offline-retro-${prompts.length+1}`)
  const prompt=fixturePlanningPrompt(input);prompts.push({purpose:input.purpose,prompt})
  if(input.purpose==='distill'){
    assert.ok(prompt.conversation.records.length);assert.ok(!input.prompt.includes('CURRENT_REQUEST_SENTINEL'))
    if(prompt.requirement.text==='clarify'&&!prompt.answers.length)return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'needs-input',procedureJson:'',summary:'请确认范围',questions:[{id:'scope',question:'要提炼的是报告生成任务吗？',options:['是']}]})}
    const procedure:TaskProcedure={goal:'对替换材料生成报告',parameters:[{name:'text',description:'每次提供的新材料'}],rules:['引用当次输入'],steps:[{id:'S1',title:'生成报告',instruction:'根据新的输入材料生成报告，保留核对结论。',dependsOn:[],evidenceRefs:prompt.conversation.records.map((record:any)=>record.id),requiresReview:false}],excluded:[],reviewItems:['本次仅有对话陈述，尚未验证对不同材料的执行效果。']}
    return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'procedure',procedureJson:JSON.stringify(procedure),summary:'已提炼报告方法',questions:[]})}
  }
  const graph=structuredClone(prompt.graph) as PlanningProjection;graph.title='从本次任务生成的报告工作流'
  assert.ok(prompt.procedure);assert.equal(prompt.conversation,undefined,'Authoring must consume the method without repeating raw history')
  return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(graph),summary:'任务方法预览',assumptions:[],questions:[],requirementCoverage:['R1',...prompt.procedure.steps.map((step:any)=>step.id)].map(requirementId=>({requirementId,nodeIds:[graph.nodes.at(-1)!.id],note:'离线结构覆盖验收'}))})}
}
let backgroundAdmissions=0
const tool=async(name:string,args:unknown,caller=main)=>{
  const result=JSON.parse(await definitions.get(name).execute(args,{agent:caller,signal:new AbortController().signal}))
  if(['visible_workflow_plan','visible_workflow_from_conversation','visible_workflow_plan_answer'].includes(name)&&result.delivery?.mode==='background'){
    if(result.state==='queued'){backgroundAdmissions++;assert.equal(result.delivery.protocolVersion,1);assert.equal(result.receipt,undefined);assert.equal(result.candidate,undefined)}
    await planner.active.get(result.taskId)?.done
    return JSON.parse(await definitions.get('visible_workflow_plan_get').execute({task_id:result.taskId,include_candidates:true},{agent:caller,signal:new AbortController().signal}))
  }
  return result
}
const retro=(input:Record<string,unknown>,caller=main)=>tool('visible_workflow_from_conversation',{request_json:JSON.stringify(input)},caller)
const snapshot=()=>{const files:Record<string,string>={};const visit=(folder:string)=>{for(const item of readdirSync(folder,{withFileTypes:true})){const file=join(folder,item.name);if(item.isDirectory())visit(file);else if(item.isFile())files[relative(directory,file)]=readFileSync(file).toString('base64')}};visit(directory);return files}
const assertPreviewIdentityOnly=(before:Record<string,string>)=>{
  const after=snapshot(),metadata='planning/background.json'
  for(const name of new Set([...Object.keys(before),...Object.keys(after)]))if(name!==metadata&&name!=='planning/background.journal')assert.equal(after[name],before[name],`preview changed business artifact ${name}`)
  const envelope=new PlanningStore<{id:string;preview:boolean}>(directory,()=>true,'background.json').readRaw()
  assert.equal(envelope.version,1)
  const allowed=new Set(['protocolVersion','taskId','requestId','requestDigest','sessionId','workspaceId','acceptedAt','state','interruptedAt','reason','id','preview'])
  // Inspect both snapshots and journal rows: allowing the log must never allow
  // private source/context payloads to escape the compact recovery envelope.
  const journal=after['planning/background.journal']?Buffer.from(after['planning/background.journal'],'base64').toString('utf8').trim().split('\n').slice(1).map(line=>JSON.parse(line)):[]
  for(const task of [...envelope.tasks,...journal])for(const key of Object.keys(task as object))assert.ok(allowed.has(key),`background metadata contains forbidden business payload field ${key}`)
  assert.ok(!/"(?:request|source|history|candidate|context|output)"/.test(JSON.stringify([envelope,journal])))
}
let removeQuery:(()=>void)|undefined
try{
  assert.ok(definitions.has('visible_workflow_from_conversation'));assert.ok(guide.some(text=>text.includes('visible_workflow_from_conversation')))
  const before=snapshot(),missing=await retro({requestId:'missing-query',instruction:'将本次报告方法生成工作流'})
  assert.equal(missing.state,'failed');assert.match(JSON.stringify(missing.diagnostics),/CONVERSATION_QUERY_UNAVAILABLE/);assert.equal(prompts.length,0)
  removeQuery=ctx.provide('sessionQuery',query as any)
  const result=await retro({requestId:'retro-1',instruction:'将本次报告方法生成可替换输入的工作流'})
  assert.equal(result.state,'ready',JSON.stringify(result));assert.equal(result.preview,true);assert.ok(result.candidate);assert.equal(result.receipt,undefined)
  assert.deepEqual(prompts.map(item=>item.purpose),['distill','author']);assert.equal(result.source.throughSeq,3);assert.equal(result.source.recordCount,2)
  assert.equal(result.source.records,undefined);assert.equal(result.context,undefined);assert.equal(result.procedure.parameters[0].name,'text')
  assert.deepEqual(result.sourceMap,[{stepId:'S1',nodeIds:[result.candidate.nodes.at(-1).id],evidenceRefs:['e1','e2']}]);assert.match(result.provenanceDigest,/^[a-f0-9]{64}$/)
  assert.equal(result.usage.childAttempts,2);assert.equal(result.usage.spentTokens,20);assert.equal(observed,1);assert.equal(disposed,1)
  assert.equal(budgetQuestions,0);assertPreviewIdentityOnly(before)
  const repeated=await retro({requestId:'retro-1',instruction:'将本次报告方法生成可替换输入的工作流'})
  assert.equal(repeated.taskId,result.taskId);assert.equal(prompts.length,2);assert.equal(observed,1,'Idempotent retry must reuse the same frozen cut')
  assert.deepEqual((await tool('visible_workflow_plan_get',{task_id:result.taskId})).sourceMap,result.sourceMap)
  assert.equal(result.engineVersion,'0.0.2');assert.equal(result.optimization.stopReason,'already_deterministic')
  assert.equal((await tool('visible_workflow_plan_get',{task_id:result.taskId})).optimization.baseline.candidate,undefined,'Default chat response omits duplicate graphs')
  const comparison=await tool('visible_workflow_plan_get',{task_id:result.taskId,include_candidates:true})
  assert.deepEqual(comparison.optimization.baseline.candidate,result.candidate)
  await assert.rejects(tool('visible_workflow_plan_get',{task_id:result.taskId},other),/不属于当前主对话/)
  await assert.rejects(retro({requestId:'other-session',instruction:'复用',sessionId:'other'}),/sessionId/)
  await assert.rejects(retro({requestId:'child',instruction:'复用'},child),/主对话发起/)
  await assert.rejects(tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'bypass-preview',instruction:'复用',operation:'create',preview:false,source:{kind:'current-conversation'}})}))
  const beforeRejected=prompts.length,currentTurn=await retro({requestId:'current-turn',instruction:'复用',throughSeq:5})
  assert.equal(currentTurn.state,'failed');assert.equal(prompts.length,beforeRejected)
  observedId='other'
  const different=await retro({requestId:'bad-observation',instruction:'复用'})
  assert.equal(different.state,'failed');assert.equal(prompts.length,beforeRejected);observedId='main'
  revokeAfterObserve=true
  const readsBeforeRevocation=historyReads
  await assert.rejects(retro({requestId:'owner-lost',instruction:'复用'}),/主对话|权限/)
  assert.equal(prompts.length,beforeRejected)
  assert.equal(historyReads,readsBeforeRevocation,'Loss of the live owner during observe must prevent history materialization')
  mainLive=true;revokeAfterObserve=false
  const generic=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'generic-source',instruction:'复用',operation:'create',preview:true,source:{kind:'current-conversation'}})})
  assert.equal(generic.state,'ready');assert.ok(generic.sourceMap)
  const target=await retro({requestId:'target-preview',instruction:'复用',optimizationTarget:{maxModelCalls:0,maxAgentCalls:0}})
  assert.equal(target.state,'ready');assert.equal(target.optimization.selected.targetEvaluation.status,'within_target')
  const cutReads=observed,answered=await retro({requestId:'clarify-retro',instruction:'clarify'})
  assert.equal(designQuestions.length,1,'the background continuation uses the Host native question callback')
  assert.equal(answered.state,'ready',JSON.stringify(answered));assert.equal(observed,cutReads+1,'Clarification keeps its one original evidence cut')
  const cancelled=await tool('visible_workflow_plan_cancel',{task_id:answered.taskId})
  assert.equal(cancelled.state,'cancelled');assert.equal(disposed,observed)
  assertPreviewIdentityOnly(before);const library=JSON.parse(await service.list('workspace'));assert.equal(library.runs.length,0);assert.equal(library.workflows.length,0)
  assert.ok(backgroundAdmissions>0)
  assert.equal(externalCalls,0);assert.equal(budgetQuestions,0)
  console.log(JSON.stringify({ok:true,registeredTool:true,eventToProcedureToPreview:true,sourceMapping:true,currentTurnExcluded:true,crossSessionDenied:true,ownerLossDenied:true,queryUnavailableExplained:true,genericRouteGuarded:true,idempotent:true,clarificationAndCancel:true,previewWrites:0,workflowRuns:0,externalCalls:0,budgetQuestions:0}))
}finally{removeQuery?.();await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
