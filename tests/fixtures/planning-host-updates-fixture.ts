// Exercise only the production Remote method and journal, without constructing
// a Host, calling a model, executing a workflow, or changing an installed profile.
import assert from 'node:assert/strict'
import VisibleWorkflowService from '../../src/host/index.ts'
import { PlanningUIState } from '../../src/host/planning/ui-state.ts'
import type { PlanningTask } from '../../src/host/planning/service.ts'

function fixture(){
  const host=Object.create(VisibleWorkflowService.prototype) as any
  const owner={id:'main',session:{id:'main'}},child={id:'child',session:{id:'child'}}
  let live:typeof owner|undefined=owner,workspace='workspace'
  const agents={get:(id:string)=>id==='main'?live:id==='child'?child:undefined,list:()=>live?[live,child]:[],roots:()=>live?[live]:[],isOwnedBy:(id:string,parent:unknown)=>id==='child'&&parent===live}
  const state=new PlanningUIState()
  Object.defineProperty(host,'ctx',{value:{agents}})
  host.planningUI=state;host.agentWorkspace=()=>workspace
  const event=()=>state.record({id:'task',sessionId:'main',workspaceId:'workspace',revision:1,state:'queued',updatedAt:'2026-10-19T10:00:00Z',request:{},events:[{state:'queued',at:'2026-10-19T10:00:00Z',message:'queued'}]} as PlanningTask)
  return {host,state,owner,event,epoch:state.updates('workspace','main',0).epoch,close:()=>{live=undefined},replace:()=>{live={...owner}},move:()=>{workspace='other'}}
}
{
  const f=fixture()
  assert.deepEqual(JSON.parse(await f.host.planningUpdates('missing',0,'')),{epoch:'unavailable',cursor:0,items:[]})
  // A root conversation with no resolvable workspace is quiet, not an error.
  const unowned=f.host.agentWorkspace;f.host.agentWorkspace=()=>{throw new Error('此对话尚未归属有效工作区，请先选择工作区')}
  assert.deepEqual(JSON.parse(await f.host.planningUpdates('main',0,f.epoch)),{epoch:'unavailable',cursor:0,items:[]})
  f.host.agentWorkspace=unowned
  await assert.rejects(f.host.planningUpdates('child',0,f.epoch,20_000),/主对话发起/)
  assert.deepEqual(JSON.parse(await f.host.planningUpdates('main',0,f.epoch)),{epoch:f.epoch,cursor:0,items:[]})
  const waiting=f.host.planningUpdates('main',0,f.epoch,20_000);f.event()
  assert.equal(JSON.parse(await waiting).progress[0].state,'queued');f.state.dispose()
}
for(const mutation of ['close','replace','move'] as const){
  const f=fixture(),waiting=f.host.planningUpdates('main',0,f.epoch,20_000)
  const rejected=assert.rejects(waiting,/主对话|工作区/)
  f[mutation]();f.event();await rejected;f.state.dispose()
}
{
  const f=fixture(),waiting=f.host.planningUpdates('main',0,f.epoch,20_000)
  const rejected=assert.rejects(waiting,/已关闭/);f.state.dispose();await rejected
}
console.log(JSON.stringify({ok:true,unownedQuiet:true,childDenied:true,legacyImmediate:true,eventWake:true,closedOwnerDenied:true,replacedOwnerDenied:true,movedWorkspaceDenied:true,disposedWaitDenied:true,modelCalls:0}))
