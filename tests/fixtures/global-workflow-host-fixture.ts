// Actual Host registration and runtime, with offline catalogs/Agent only.
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow, newId, type Workflow, type WorkflowRun } from '../../src/shared/types.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-global-host-')),ownerPath=join(directory,'owner'),callerPath=join(directory,'caller')
mkdirSync(ownerPath);mkdirSync(callerPath)
const ctx=new Context(),definitions=new Map<string,any>(),nativeCalls:any[]=[],secretLookups:any[]=[],secretManagement:any[]=[]
const agent=(id:string,path:string):any=>({id,ctx,session:{id,header:{cwd:path},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}})
const owner=agent('owner-session',ownerPath),caller=agent('caller-session',callerPath),agents=[owner,caller]
let modelCalls=0,questionCalls=0
const provisions=[
  ctx.provide('agents',{get:(id:string)=>agents.find(agent=>agent.id===id),list:()=>agents,roots:()=>agents,isOwnedBy:()=>false,withInitiator:(_agent:unknown,operation:()=>unknown)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'owner',title:'Owner',path:ownerPath,sessionIds:[owner.id]},{id:'caller',title:'Caller',path:callerPath,sessionIds:[caller.id]}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){modelCalls++;throw new Error('Model calls are forbidden')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[{name:'caller_only',description:'Offline caller tool',parameters:{type:'object',properties:{}}}],get:()=>({}),execute:async(request:any)=>{nativeCalls.push(request);return {isError:false,value:'caller tool',content:[{type:'text',text:'caller tool'}]}}}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{assert.equal(request.agent,caller);questionCalls++;throw Error('Fully specified shared workflow actions must not open a budget interview')}}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:join(directory,'state'),planningCompiler:'compact-repair'});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows')!,internals=service as any
const tool=async(name:string,args:any,agent=caller)=>JSON.parse(await definitions.get(name).execute(args,{agent,signal:new AbortController().signal}))
const save=async(flow:Workflow)=>JSON.parse(await service.save(JSON.stringify(flow),0)) as Workflow
const graph=(workspace:string,title:string)=>makeWorkflow(workspace,title,true)
const runToEnd=async(run:WorkflowRun)=>{for(let index=0;index<1000;index++){const latest=JSON.parse(await service.run(run.id)) as WorkflowRun;if(latest.status!=='running')return latest;await new Promise(resolve=>setTimeout(resolve,5))}throw new Error('Offline run did not settle')}
try{
  const global=await save({...graph('owner','Same title'),scope:'global'}),privateFlow=await save(graph('owner','Private owner flow')),local=await save(graph('caller','Same title'))
  const listed=await tool('visible_workflow_list',{})
  assert.equal(listed.workspaceId,'caller');assert.deepEqual(new Set(listed.workflows.map((flow:Workflow)=>flow.id)),new Set([global.id,local.id]))
  assert.equal((await tool('visible_workflow_get',{id:global.id})).workspaceId,'owner')
  await assert.rejects(tool('visible_workflow_get',{id:privateFlow.id}),/当前对话工作区或全局/)
  await assert.rejects(tool('visible_workflow_save',{json:JSON.stringify({...graph('caller','Forbidden promotion'),scope:'global'}),expected_revision:0}),/显式修改作用范围/)
  await assert.rejects(tool('visible_workflow_save',{json:JSON.stringify({...global,scope:'workspace'}),expected_revision:global.revision}),/显式修改作用范围/)
  const {scope:_,...withoutScope}=global
  const proposal=await tool('visible_workflow_save',{json:JSON.stringify({...withoutScope,title:'Global proposal'}),expected_revision:global.revision})
  assert.equal(proposal.candidate.scope,'global');assert.equal(proposal.candidate.workspaceId,'owner')
  assert.equal(JSON.parse(await service.get(global.id)).title,global.title)

  internals.planner.options.driver.generate=async(input:PlanningAgentInput)=>{
    const prompt=fixturePlanningPrompt(input),projected=structuredClone(prompt.graph);projected.title='Planned shared title'
    return {steps:1,usage:{totalTokens:1},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(projected),summary:'Offline scope test',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:[projected.nodes.at(-1).id],note:'Title only'}]})}
  }
  const accepted=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'global-revise',operation:'revise',instruction:'Change shared title',targetWorkflowId:global.id,expectedRevision:global.revision})})
  assert.equal(accepted.delivery?.mode,'background');assert.equal(accepted.state,'queued');assert.equal(accepted.receipt,undefined)
  await internals.planner.active.get(accepted.taskId)?.done
  const planned=await tool('visible_workflow_plan_get',{task_id:accepted.taskId,include_candidates:true})
  assert.equal(planned.state,'published',JSON.stringify(planned));assert.equal(planned.receipt.kind,'proposed')
  assert.equal(questionCalls,0,'shared definition edits and planning do not ask for a budget')
  assert.equal(JSON.parse(await service.get(global.id)).scope,'global')

  const invoked=await tool('visible_workflow_run',{id:global.id,inputs_json:'{"text":"shared exact ID"}'})
  const completed=await runToEnd(invoked)
  assert.equal(completed.status,'success',completed.error);assert.equal(completed.workflowId,global.id);assert.equal(completed.workspaceId,'caller');assert.equal(completed.graph.workspaceId,'caller')
  assert.equal(JSON.parse(await service.get(global.id)).workspaceId,'owner')
  assert.equal((await tool('visible_workflow_status',{run_id:completed.id})).id,completed.id)
  await assert.rejects(tool('visible_workflow_status',{run_id:completed.id},owner),/不属于当前工作区/)

  const nativeGraph=graph('owner','Global caller permission'),nativeId=newId()
  nativeGraph.scope='global';nativeGraph.nodes.splice(1,1,{id:nativeId,number:'a-2',kind:'tool',title:'Native caller tool',x:300,y:0,fixed:false,config:{toolId:'native:caller_only',inputs:{}}})
  nativeGraph.nodes.at(-1)!.config.text=`{{${nativeId}.text}}`;nativeGraph.edges=[{id:newId(),source:nativeGraph.nodes[0]!.id,target:nativeId},{id:newId(),source:nativeId,target:nativeGraph.nodes.at(-1)!.id}]
  const nativeSaved=await save(nativeGraph),nativeRun=await runToEnd(await tool('visible_workflow_run',{id:nativeSaved.id,inputs_json:'{"text":"native"}'}))
  assert.equal(nativeRun.status,'success',nativeRun.error);assert.equal(nativeCalls.length,1);assert.equal(nativeCalls[0].agent,caller)

  const parent=graph('caller','Local calls global'),nestedId=newId()
  parent.nodes.splice(1,1,{id:nestedId,number:'a-2',kind:'tool',title:'Global child',x:300,y:0,fixed:false,config:{toolId:`workflow:${global.id}`,inputs:{text:'{{input.text}}'}}})
  parent.nodes.at(-1)!.config.text=`{{${nestedId}.text}}`;parent.edges=[{id:newId(),source:parent.nodes[0]!.id,target:nestedId},{id:newId(),source:nestedId,target:parent.nodes.at(-1)!.id}]
  const parentSaved=await save(parent),nestedRun=await runToEnd(await tool('visible_workflow_run',{id:parentSaved.id,inputs_json:'{"text":"nested"}'}))
  assert.equal(nestedRun.status,'success',nestedRun.error);assert.equal(nestedRun.dependencySnapshots?.[global.id]?.workspaceId,'caller')

  const secretGraph={...graph('owner','Global secret isolation'),scope:'global' as const,environmentVariables:[{id:'secret-declaration',name:'KEY',type:'secret' as const,required:true}]}
  const secretSaved=await save(secretGraph)
  internals.secretBroker.status=async(scope:any)=>{secretLookups.push(scope);return {state:scope.workspaceId==='owner'?'configured':'missing',authorization:'authorized'}}
  internals.secretBroker.manage=async(scope:any)=>{secretManagement.push(scope)}
  const secretReadiness=JSON.parse(await service.inspectReadiness(JSON.stringify(secretSaved),caller.id))
  assert.equal(secretReadiness.canRun,false);assert.ok(secretReadiness.issues.some((issue:any)=>issue.kind==='secret'));assert.ok(secretLookups.every(scope=>scope.workspaceId==='caller'))
  await service.openSecretManager(secretSaved.id,'secret-declaration',caller.id)
  assert.deepEqual(secretManagement,[{workspaceId:'caller',workflowId:secretSaved.id,variableId:'secret-declaration',nodeId:'environment'}])
  await assert.rejects(service.openSecretManager(secretSaved.id,'secret-declaration','unknown-session'))
  assert.equal(secretManagement.length,1)

  const dependent=structuredClone(parent);dependent.id=newId();dependent.workspaceId='owner';dependent.scope='global';dependent.nodes.find(node=>node.id===nestedId)!.config.toolId=`workflow:${privateFlow.id}`
  const dependentSaved=await save(dependent),denied=JSON.parse(await service.inspectReadiness(JSON.stringify(dependentSaved),caller.id))
  assert.equal(denied.canRun,false);assert.ok(denied.issues.some((issue:any)=>issue.kind==='workflow'))
  await assert.rejects(tool('visible_workflow_run',{id:dependentSaved.id,inputs_json:'{"text":"denied"}'}))
  const existingReadiness=internals.readinessFor.bind(service),runCount=JSON.parse(await service.list('')).runs.length
  internals.readinessFor=async(flow:Workflow,...rest:any[])=>{
    const report=await existingReadiness(flow,...rest)
    if(flow.id===global.id){const latest=JSON.parse(await service.get(global.id));await service.save(JSON.stringify({...latest,scope:'workspace'}),latest.revision)}
    return report
  }
  await assert.rejects(tool('visible_workflow_run',{id:global.id,inputs_json:'{"text":"scope revoked during readiness"}'}),/当前对话工作区或全局/)
  assert.equal(JSON.parse(await service.list('')).runs.length,runCount)
  assert.equal(questionCalls,0)
  assert.equal(modelCalls,0)
  console.log(JSON.stringify({ok:true,exactId:true,globalReadPlanRun:true,callerResourceBoundary:true,privateDependenciesDenied:true,explicitScopeOnly:true,noBudgetQuestions:true,modelCalls}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
