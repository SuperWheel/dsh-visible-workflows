// Production Cordis Host/tools/storage. Budget APIs and interviews are removed;
// no provider, SDK stream, Desktop, profile or network is used.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import {makeWorkflow,type Workflow} from '../../src/shared/types.ts'
import {planningDigest} from '../../src/host/planning/service.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-budget-revision-')),ctx=new Context(),definitions=new Map<string,any>()
const root=(id:string):any=>({id,ctx,session:{id,header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline'}})},options:{provider:'fixture',model:'offline'}})
const main=root('original-root'),other=root('new-root'),agents=[main,other],questions:any[]=[]
const legacyFile=join(directory,'creation-budgets','retired.json'),legacyBytes='legacy budget records remain untouched\n'
mkdirSync(join(directory,'creation-budgets'));writeFileSync(legacyFile,legacyBytes)
let driverCalls=0
const provisions=[
  ctx.provide('agents',{get:(id:string)=>agents.find(a=>a.id===id),list:()=>agents,roots:()=>agents,isOwnedBy:()=>false,withInitiator:async(_agent:any,work:()=>Promise<unknown>)=>work()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:directory,title:'Budget regression',sessionIds:agents.map(a=>a.id)}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:()=>[],resolveModelInfo:()=>{throw Error('No model resolution expected')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{questions.push(request);throw Error('Retired budget interview must never be called')}}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner
planner.options.driver.generate=async()=>{driverCalls++;throw Error('Deterministic title revision must not call a model')}
const tool=async(name:string,args:any)=>JSON.parse(await definitions.get(name).execute(args,{agent:other,signal:new AbortController().signal}))
const originalAt='2026-10-19T14:41:17.725Z'
const baseline=async(mode:'limited'|'unlimited',policy:Workflow['executionPolicy'])=>{
  const value=makeWorkflow('workspace','Existing human-authorized flow',true)
  value.budgetDecision={mode,decidedAt:originalAt}
  if(policy!==undefined)value.executionPolicy=policy
  else delete value.executionPolicy
  const saved=JSON.parse(await service.save(JSON.stringify(value),0)) as Workflow
  assert.equal(Object.hasOwn(saved,'executionPolicy'),policy!==undefined)
  return saved
}
const titlePreview=async(flow:Workflow,requestId:string)=>{
  const accepted=await tool('visible_workflow_edit',{request_id:requestId,workflow_id:flow.id,expected_revision:flow.revision,instruction:'Only change this node title',preview:true,target_node_ids:[flow.nodes[0]!.id],changes:[{op:'set-title',nodeId:flow.nodes[0]!.id,value:'New reviewed title'}]})
  await planner.active.get(accepted.taskId)?.done
  const task=await tool('visible_workflow_plan_get',{task_id:accepted.taskId,include_candidates:true})
  assert.equal(task.state,'ready',JSON.stringify(task));assert.equal(task.usage.childAttempts,0)
  assert.equal(task.candidate.budgetDecision.decidedAt,originalAt)
  const expected=structuredClone(flow);expected.nodes[0]!.title='New reviewed title'
  assert.deepEqual(task.candidate,expected,'preview changes only the requested title')
  return task
}
try{
  assert.equal(definitions.has('visible_workflow_prepare'),false)
  assert.equal(definitions.has('visible_workflow_budget'),false)
  assert.equal(typeof (service as any).increaseBudget,'undefined')
  for(const {label,mode,policy} of [
    {label:'unlimited-absent',mode:'unlimited',policy:undefined},
    {label:'unlimited-empty',mode:'unlimited',policy:{}},
    {label:'unlimited-safety',mode:'unlimited',policy:{maxConcurrentAgents:2}},
    {label:'limited-safety',mode:'limited',policy:{tokenBudget:1,perTaskTokens:1,maxAgentTasks:1,maxConcurrentAgents:2}},
  ] as const){
    const flow=await baseline(mode,policy)
    const task=await titlePreview(flow,'removed-budget-'+label)
    const published=await tool('visible_workflow_plan_publish',{task_id:task.taskId,revision:task.revision,candidate_digest:task.candidateDigest})
    assert.equal(published.state,'published')
    const proposal=JSON.parse(await service.proposals(flow.id)).find((p:any)=>p.id===published.receipt.proposalId)
    assert.deepEqual(proposal.candidate,task.candidate,'publication keeps the exact reviewed title candidate and legacy metadata')
    assert.equal(Object.hasOwn(proposal.candidate,'executionPolicy'),policy!==undefined)
    assert.equal(planningDigest(proposal.candidate),task.candidateDigest)
    assert.deepEqual(JSON.parse(await service.get(flow.id)),flow,'proposal does not save the graph')
    await service.resolveProposal(proposal.id,'reject',flow.revision)
    assert.deepEqual(JSON.parse(await service.get(flow.id)),flow,'reject preserves the legacy graph')
  }
  const created=makeWorkflow('workspace','New graph without budget',true)
  created.budgetDecision={mode:'limited',decidedAt:originalAt}
  created.executionPolicy={tokenBudget:1,perTaskTokens:1,maxAgentTasks:1,maxConcurrentAgents:2,maxRepairAttempts:1}
  const saved=await tool('visible_workflow_save',{json:JSON.stringify(created),expected_revision:0})
  assert.equal(saved.id,created.id)
  assert.equal(Object.hasOwn(saved,'budgetDecision'),false)
  assert.deepEqual(saved.executionPolicy,{maxConcurrentAgents:2,maxRepairAttempts:1})
  assert.equal(questions.length,0)
  assert.equal(readFileSync(legacyFile,'utf8'),legacyBytes)
  assert.equal(existsSync(join(directory,'creation-budgets','retired.json')),true)
  assert.equal(driverCalls,0)
  console.log(JSON.stringify({ok:true,noBudgetTools:true,noBudgetQuestions:true,exactLegacyCandidate:true,legacyRecordsUntouched:true,newGraphHasNoQuota:true,executionSafetyPreserved:true,driverCalls}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
