// Production Cordis Remote save/start, with inert catalogs and no model calls.
import {Context} from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import {makeWorkflow,type Workflow,type WorkflowRun} from '../../src/shared/types.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-subagent-binding-')),ctx=new Context()
const agent=(id:string,parent?:string):any=>({id,ctx,session:{id,header:{cwd:directory,...(parent?{origin:'subagent',parentSession:parent}:{})},requestHeader:()=>undefined},options:{provider:'p',model:'m',reasoningEffort:'none'}})
const main=agent('main'),child=agent('child','main'),other=agent('other'),agents=[main,child,other]
let readonly=false
const provisions=[
  ctx.provide('agents',{get:(id:string)=>agents.find(agent=>agent.id===id),list:()=>agents,roots:()=>[main,other],isOwnedBy:(id:string,owner:any)=>id==='child'&&owner===main}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'w',title:'Test',path:directory,sessionIds:['main','other']}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'p',name:'P'}],listModels:async()=>[{id:'m',name:'M'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}})}),
  ctx.provide('tools',{register:()=>()=>{},schemas:()=>[]}),ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
  ctx.provide('planMode',{get:()=>({active:readonly})}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory});await fiber
assert.equal(fiber.state,2);const service=fiber.ctx.get('visibleWorkflows')!
const graph=()=>{const flow=makeWorkflow('w','binding',true);flow.nodes[1]!.kind='agent';flow.nodes[1]!.config={prompt:'{{input.text}}',model:{provider:'p',model:'m'},effort:'none',tools:[],maxSteps:2,subagentId:'worker'};flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}];return flow}
try{
  const pending=graph();delete pending.subAgents;delete pending.nodes[1]!.config.subagentId
  const pendingSaved=JSON.parse(await service.save(JSON.stringify(pending),0)) as Workflow
  assert.equal(pendingSaved.subAgents,undefined);assert.equal(pendingSaved.nodes[1]!.config.subagentId,undefined)
  await assert.rejects(service.start(pending.id,'{}','main'),/请选择或创建此节点的子 Agent/)
  assert.deepEqual(JSON.parse(await service.get(pending.id)),pendingSaved,'an unconfigured node stays editable without creating an identity')
  const flow=graph(),saved=JSON.parse(await service.save(JSON.stringify(flow),0)) as Workflow
  assert.ok(saved.nodes[1]!.config.subagentId,'save preserves the explicit current identity')
  assert.equal(saved.subAgents![0]!.sessionId,undefined)
  const run=JSON.parse(await service.start(flow.id,'{}','child')) as WorkflowRun
  assert.equal(run.status,'waiting');assert.equal(run.systemVariables!.session_id,'main')
  const rebound=JSON.parse(await service.get(flow.id)) as Workflow
  assert.equal(rebound.subAgents![0]!.sessionId,'main');assert.equal(rebound.revision,saved.revision+1)
  assert.equal(run.sourceRevision,rebound.revision);assert.equal(run.executions[1]!.subagentDefinitionId,rebound.subAgents![0]!.id)
  await service.cancel(run.id)
  await assert.rejects(service.start(flow.id,'{}','other'),/其他主对话/)
  const denied=graph(),unbound=JSON.parse(await service.save(JSON.stringify(denied),0)) as Workflow
  readonly=true;await assert.rejects(service.start(denied.id,'{}','main'),/规划模式/);readonly=false
  assert.deepEqual(JSON.parse(await service.get(denied.id)),unbound,'denied start must not persist identity binding')
  console.log(JSON.stringify({ok:true,mainBindingPersisted:true,sourceRevisionMatches:true,foreignSessionRejected:true,deniedStartUnchanged:true}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
