import {moduleCheck} from './planning-module-check.ts'
// Actual Host, native command registry and SDK model-selection projection.
// Model I/O, Agent followup and human answers are offline doubles; no turn events are manufactured.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import VisibleWorkflowService from '../../src/host/index.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'

const require=createRequire(import.meta.url),sdk=createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const {default:Projections}=await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-session-projection')).href)
const {installModelSelectionProjection}=await import(pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller')),'types/model-selection-projection.js')).href)
const commandSDK=createRequire(require.resolve('@deepseek-ai/dsh-plan-mode'))
const {default:Commands}=await import(pathToFileURL(commandSDK.resolve('@deepseek-ai/dsh-commands')).href)
const directory=mkdtempSync(join(tmpdir(),'planning-model-source-')),ctx=new Context(),tools=new Map<string,any>(),events:any[]=[],calls:any[]=[],efforts:any[]=[],modelResolutions:any[]=[],followups:any[]=[]
let requestHeader:any,hostDefault:any,questionSwitch:string|undefined,defaultSwitch=false,stepSwitch=false
const session:any={id:'root',header:{id:'root',cwd:directory},inheritedEventCount:0,get seq(){return events.length},eventAt:(seq:number)=>events[seq],requestHeader:()=>requestHeader,snapshotEvents:(start=0,end=events.length)=>events.slice(start,end),append:(type:string,data:any)=>{const event={seq:events.length,type,data};events.push(event);ctx.emit('session/event',session,event);return event.seq}}
const parent:any={id:'root',ctx,session,followup:(message:any)=>followups.push(message),options:{provider:'cliworker-native',model:'worker/incorrect-default'}}
const select=(provider:string)=>session.append('model/selection',{provider,model:'model'})
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='root'?parent:undefined,roots:()=>[parent],list:()=>[parent],isOwnedBy:()=>false,withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Fixture',path:directory,sessionIds:['root']}]}),
  ctx.provide('agentDefaultModel',{currentSelection:()=>hostDefault}),
  ctx.provide('llm',{listProviders:()=>['selected','next','active'].map(id=>({id,name:id})),listModels:async()=>[{id:'model',name:'Model'}],resolveModelInfo:async(provider:string,model:string)=>{assert.notEqual(provider,'cliworker-native');modelResolutions.push({provider,model});return {reasoning:{efforts:[{id:'low'},{id:'high'}]}}},stream:async function*(){throw new Error('Real models are forbidden')}}),
  ctx.provide('tools',{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
  ctx.provide('userQuestions',{ask:async({questions}:any)=>{
    const id=questions[0].id
    if(questionSwitch===id){questionSwitch=undefined;select('next')}
    if(defaultSwitch&&id==='budget-mode'){defaultSwitch=false;hostDefault={provider:'next',model:'model',reasoningEffort:'high'}}
    return {answers:[{id,selected:[id==='workflow-target'?'新建工作流':'否，不设预算上限']}]}
  }}),
]
const projections=ctx.plugin(Projections);await projections;installModelSelectionProjection(ctx)
const commandsFiber=ctx.plugin(Commands);await commandsFiber
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair',commandEarlyHandoff:false});await fiber;assert.equal(fiber.state,2)
await new Promise(resolve=>setTimeout(resolve,0))
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner,commands=commandsFiber.ctx.get('commands') as any
planner.options.driver.generate=async(input:PlanningAgentInput)=>{
  if(stepSwitch){stepSwitch=false;select('next')}
  input.beforeStep?.(20,100);calls.push(structuredClone(input.model));efforts.push(input.effort)
  const data=fixturePlanningPrompt(input),graph=structuredClone(data.graph),id=data.nodeIds.find((value:string)=>!graph.nodes.some((node:any)=>node.id===value))
  graph.nodes.splice(1,0,{id,kind:'llm',title:'Model step',config:{prompt:'{{input.text}}',model:input.model}})
  graph.edges=[{source:graph.nodes[0].id,target:id},{source:id,target:graph.nodes.at(-1).id}]
  graph.nodes.at(-1).config.text=`{{${id}.text}}`
  return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(graph),summary:'Model fixture',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:[id],note:'Fixture'}]})}
}
const command=()=>commands.execute(parent,'/dsh-visible-workflows 生成文本处理工作流',[],new AbortController().signal)
let requestNumber=0
const plan=async()=>{
  const accepted=JSON.parse(await tools.get('visible_workflow_plan').execute({request_json:JSON.stringify({requestId:`active-tool-${++requestNumber}`,operation:'create',moduleCheck,instruction:'Create a model workflow',execution:{mode:'design-only'}})},{agent:parent,signal:new AbortController().signal}))
  assert.equal(accepted.state,'queued');assert.equal(accepted.delivery.protocolVersion,1);assert.equal(accepted.receipt,undefined)
  await planner.active.get(accepted.taskId)?.done
  return JSON.parse(await tools.get('visible_workflow_plan_get').execute({task_id:accepted.taskId,include_candidates:true},{agent:parent,signal:new AbortController().signal}))
}
const activate=(provider:string,effort?:string)=>{requestHeader={config:{provider,model:'model',...(effort?{reasoningEffort:effort}:{})}};session.append('request/header',{reason:'initial',header:requestHeader})}
try{
  // With T23 early handoff disabled, a slash command only queues the user's genuine input. Model selection is
  // deferred until the Host runs that followup and the Agent calls the tool.
  const empty=await command();assert.deepEqual(empty.result,{kind:'success'})
  assert.equal(followups.length,1);assert.equal(calls.length,0);assert.equal(modelResolutions.length,0)
  assert.deepEqual(followups[0].source,{kind:'user'})
  assert.equal(followups[0].content[0].text,'/dsh-visible-workflows 生成文本处理工作流')
  hostDefault={provider:'selected',model:'model',reasoningEffort:'low'}
  select('selected');activate('selected','low')
  const fresh=await plan();assert.equal(fresh.state,'published',JSON.stringify(fresh))
  assert.deepEqual(calls.at(-1),{provider:'selected',model:'model'});assert.equal(efforts.at(-1),'low')
  const freshFlow=JSON.parse(await service.get(fresh.receipt.workflowId)),freshModelNode=freshFlow.nodes.find((node:any)=>node.kind==='llm')
  assert.deepEqual(freshModelNode.config.model,{provider:'selected',model:'model'});assert.equal(freshModelNode.config.effort,'low')

  activate('active');select('selected')
  const beforeCommand=calls.length,resolutionsBefore=modelResolutions.length
  assert.deepEqual((await command()).result,{kind:'success'})
  assert.equal(calls.length,beforeCommand);assert.equal(modelResolutions.length,resolutionsBefore,'handoff cannot freeze a pending or stale model')
  stepSwitch=true
  const active=await plan();assert.equal(active.state,'published',JSON.stringify(active))
  assert.equal(calls.at(-1).provider,'active','tool execution keeps its active request even when next-turn selection changes')
  assert.equal(efforts.at(-1),undefined,'active request effort must not leak from a selected Host default')

  select('selected');questionSwitch='budget-mode';defaultSwitch=true
  const budget=await plan();assert.equal(budget.state,'published',JSON.stringify(budget))
  assert.equal(calls.at(-1).provider,'active','a pending selection and default change during a budget answer do not replace the active turn request')
  const budgetFlow=JSON.parse(await service.get(budget.receipt.workflowId))
  assert.deepEqual(budgetFlow.nodes.find((node:any)=>node.kind==='llm').config.model,{provider:'active',model:'model'})
  assert.equal(modelResolutions.some(item=>item.provider==='cliworker-native'),false)
  console.log(JSON.stringify({ok:true,commandDefersModel:true,activeToolHeader:true,frozenPublication:true,budgetKeepsActiveRequest:true,noConstructionFallback:true,externalCalls:0}))
}finally{await fiber.dispose();await commandsFiber.dispose();await projections.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
