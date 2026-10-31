// Real Cordis Host/tools/planner/journal; explicit compiler doubles only.
// No model, Desktop, profile, business run or network.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import {makeWorkflow} from '../../src/shared/types.ts'

const directory=mkdtempSync(join(tmpdir(),'planning-task-join-host-')),ctx=new Context(),definitions=new Map<string,any>()
const notices:any[]=[],owner:any={id:'root',ctx,session:{id:'root',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline'}})},options:{provider:'fixture',model:'offline'},inbox:{nextStep:[],nextTurn:[]},steer:(message:any)=>notices.push(message)}
const foreign:any={...owner,id:'foreign',session:{...owner.session,id:'foreign'}},agents=[owner,foreign]
const provisions=[
  ctx.provide('agents',{get:(id:string)=>agents.find(a=>a.id===id),list:()=>agents,roots:()=>agents,isOwnedBy:()=>false,withInitiator:async(_agent:any,work:()=>Promise<unknown>)=>work()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:directory,title:'Join fixture',sessionIds:agents.map(a=>a.id)}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:()=>[],resolveModelInfo:async()=>({})}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'});await fiber
assert.equal(fiber.state,2)
const host=fiber.ctx.get('visibleWorkflows')! as any,planner=host.planner
let finish!:()=>void,started!:()=>void,driverCalls=0
const begun=new Promise<void>(resolve=>started=resolve),hold=new Promise<void>(resolve=>finish=resolve)
planner.options.driver.generate=async(input:any)=>{
  driverCalls++;started();await hold
  const value=input.compiler.submit({submission:{mode:'edit',updates:{n2:{set:{text:'Human selected text'}}},coverage:{R1:['n2']}}})
  assert.equal(value.ok,true,JSON.stringify(value));return {output:value.value,steps:1,usage:{totalTokens:5}}
}
const tool=async(name:string,args:any,agent=owner,signal=new AbortController().signal)=>JSON.parse(await definitions.get(name).execute(args,{agent,signal}))
try{
  const flow=JSON.parse(await host.save(JSON.stringify(makeWorkflow('workspace','Join target',true)),0))
  // makeWorkflow starts with a template and output; select the editable template.
  const target=flow.nodes.find((node:any)=>node.kind==='template')
  assert(target)
  host.planningJoin.begin(owner,1)
  const accepted=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'join-task',operation:'revise',instruction:'Fill only the text',targetWorkflowId:flow.id,expectedRevision:flow.revision,preview:true,targetNodeIds:[target.id],handoff:{version:2,mode:'partial',changes:[],unresolved:[{nodeId:target.id,fields:['text'],question:'Use the selected text'}],completion:[{nodeId:target.id,field:'text',require:'changed'}]}})})
  assert.equal(accepted.state,'queued');await begun
  const immediate=await tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:0})
  assert.equal(immediate.wait.outcome,'waiting');assert.equal(immediate.candidate,undefined)
  await assert.rejects(tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:0},foreign),/不属于当前主对话/)
  const control=new AbortController(),cancelled=tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:60_000},owner,control.signal)
  const rejection=assert.rejects(cancelled,/cancel only the wait/);control.abort(new Error('cancel only the wait'));await rejection
  assert.equal(planner.isActive(accepted.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal})),true)
  assert.equal(host.planningUI.waiterCount,0)
  // Exercise the registered official serial hook, not a synthetic final result.
  let stopped=false
  const stop=ctx.serial('agent/turn-stopping',{agent:owner,turn:1,signal:new AbortController().signal}).then(()=>{stopped=true})
  await Promise.resolve();assert.equal(stopped,false);assert.equal(notices.length,0)
  finish();await stop
  assert.equal(notices.length,1)
  assert.equal(notices[0].source.kind,'visible-workflow-join')
  const noticeText=notices[0].content[0].text
  assert.match(noticeText,/"state":"ready"/);assert.match(noticeText,/不把 waiting 或失败写成成功/)
  await ctx.serial('agent/turn-stopping',{agent:owner,turn:1,signal:new AbortController().signal})
  assert.equal(notices.length,1,'same revision terminal notice is delivered once')
  const ready=await tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:0})
  assert.equal(ready.wait.outcome,'ready');assert.equal(ready.preview,true);assert.equal(ready.joinActive,undefined)
  assert.equal(ready.receipt,undefined);assert.equal(driverCalls,1)
  assert.deepEqual(JSON.parse(await host.get(flow.id)),flow,'waiting never publishes or saves a candidate')
  assert.deepEqual(JSON.parse(await host.proposals(flow.id)),[])
  assert.equal(host.planningUI.waiterCount,0)
  console.log(JSON.stringify({ok:true,fastAcceptance:true,waitingNotSuccess:true,foreignDenied:true,cancelWaitDoesNotCancelTask:true,turnStopHeldUntilReady:true,actualHostNotice:true,noticeDeduplicated:true,noPublication:true,modelRequests:0,driverCalls}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
