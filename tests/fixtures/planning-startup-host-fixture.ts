import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import { WorkflowStorage } from '../../src/host/storage.ts'
import { PlanningStore } from '../../src/host/planning/store.ts'
import { storedReviewCandidate } from './stored-review-candidate.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-planning-startup-')),ctx=new Context(),definitions=new Map<string,any>(),commands=new Map<string,any>()
const task=storedReviewCandidate('published'),storage=new WorkflowStorage(directory)
storage.save(task.candidate!,0,'agent',task.commit);storage.close()
new PlanningStore(directory).write([task])
const main:any={id:'main',ctx,session:{id:'main',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline'}})},options:{provider:'fixture',model:'offline'}}
let modelCalls=0
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'?main:undefined,list:()=>[main],roots:()=>[main],isOwnedBy:()=>false}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Offline',path:directory,sessionIds:['main']}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:async()=>[],stream:async function*(){modelCalls++;throw new Error('Model calls are forbidden')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[],get:()=>undefined}),
  ctx.provide('commands',{register:(definition:any)=>{commands.set(definition.name,definition);return()=>{commands.delete(definition.name)}}}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'})
try{
  await fiber;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(fiber.state,2)
  const service=fiber.ctx.get('visibleWorkflows')!
  const restored=JSON.parse(await definitions.get('visible_workflow_plan_get').execute({task_id:task.id,include_candidates:true},{agent:main,signal:new AbortController().signal}))
  assert.equal(restored.state,'published');assert.deepEqual(restored.candidate,task.candidate)
  assert.ok(restored.diagnostics.some((issue:any)=>issue.code==='STORED_CANDIDATE_CONTRACT_CHANGED'))
  assert.ok(definitions.has('visible_workflow_list'));assert.ok(definitions.has('visible_workflow_plan'));assert.ok(definitions.has('visible_workflow_run'))
  assert.ok(commands.has('dsh-visible-workflows'))
  assert.equal(JSON.parse(await service.get(task.candidate!.id)).id,task.candidate!.id)
  assert.equal(modelCalls,0)
  console.log(JSON.stringify({active:true,published:true,toolsRegistered:true,commandRegistered:true,modelCalls}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
