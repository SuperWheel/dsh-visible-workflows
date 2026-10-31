// Production Host authorization + service reader/callback checks only. No Host
// construction, model request, business execution or installed profile mutation.
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import { WorkflowPlanningService,type PlanningCaller,type PlanningTask } from '../../src/host/planning/service.ts'
import { ModelAdmission } from '../../src/host/run-usage.ts'
import { PlanningUIState } from '../../src/host/planning/ui-state.ts'
import { parseWorkflow } from '../../src/shared/workflow-validation.ts'
import { templateContext } from './planning-compiler/template.ts'

const mutations=['deleted','moved','revision','digest'] as const
function fixture(){
  const host=Object.create(VisibleWorkflowService.prototype) as any
  let readOnly=true,modelReads=0,catalogReads=0
  const owner={id:'main',session:{id:'main'},ctx:{get:(name:string)=>name==='sandboxPolicy'?{resolve:()=>({mode:readOnly?'read-only':'workspace-write'})}:undefined}}
  const agents={get:(id:string)=>id===owner.id?owner:undefined,list:()=>[owner],roots:()=>[owner],isOwnedBy:()=>false}
  Object.defineProperty(host,'ctx',{value:{agents}})
  const context=templateContext();context.operation='revise';context.workflow.revision=1;context.workflow=parseWorkflow(context.workflow)
  let current:typeof context.workflow|undefined=structuredClone(context.workflow)
  host.agentWorkspace=()=>'workspace'
  host.storage={get:(id:string)=>{assert.equal(id,context.workflow.id);if(!current)throw Error('工作流不存在');return structuredClone(current)},workflows:()=>current?[current]:[],archived:()=>[]}
  host.planningUI=new PlanningUIState()
  host.planningModel=()=>{modelReads++;return context.model}
  host.catalog={list:()=>{catalogReads++;return context.tools}}
  const caller={parent:owner,sessionId:owner.id,workspaceId:'workspace',signal:new AbortController().signal} as unknown as PlanningCaller
  const task={id:'task',sessionId:owner.id,workspaceId:'workspace',preview:true,request:{requestId:'request',operation:'revise',targetWorkflowId:context.workflow.id,expectedRevision:1},context} as PlanningTask
  const mutate=(kind:typeof mutations[number])=>{
    if(kind==='deleted')current=undefined
    else if(kind==='moved')current!.workspaceId='other-workspace'
    else if(kind==='revision')current!.revision++
    else current!.nodes[0]!.title='Changed without revision'
  }
  return {host,context,caller,task,mutate,setWritable:()=>{readOnly=false},counts:()=>({modelReads,catalogReads})}
}
{
  const f=fixture()
  f.host.authorizePlanning(f.task,f.caller,false)
  assert.deepEqual(f.counts(),{modelReads:0,catalogReads:0})
  assert.throws(()=>f.host.authorizePlanning(f.task,f.caller,true),/只读权限/)
  assert.deepEqual(f.counts(),{modelReads:0,catalogReads:0})
  f.setWritable();f.host.authorizePlanning(f.task,f.caller,true)
  assert.deepEqual(f.counts(),{modelReads:1,catalogReads:1})
  f.host.planningModel=()=>({provider:'changed',model:'changed'})
  f.host.authorizePlanning(f.task,f.caller,false)
  assert.throws(()=>f.host.authorizePlanning(f.task,f.caller,true),/模型上下文已变化/)
  f.host.planningUI.dispose()
}
for(const mutation of mutations){
  const f=fixture();f.mutate(mutation)
  assert.throws(()=>f.host.authorizePlanning(f.task,f.caller,false),mutation==='deleted'?/不存在/:mutation==='moved'?/当前对话工作区/:/REVISION_CONFLICT/)
  // Historical published status/receipt reads keep their preexisting semantics.
  f.host.authorizePlanning({...f.task,preview:false,state:'published'},f.caller,false)
  f.host.planningUI.dispose()
}
let callbackChecks=0,cacheReads=0
for(const mutation of [undefined,...mutations]){
  const f=fixture(),directory=mkdtempSync(join(tmpdir(),'planning-host-preview-auth-'))
  const service=new WorkflowPlanningService({directory,compilerMode:'compact-repair',admission:new ModelAdmission(1),
    context:async()=>structuredClone(f.context),authorize:(task,caller,write)=>f.host.authorizePlanning(task,caller,write),
    readiness:async()=>{throw Error('No candidate should execute readiness in this fixture')},publish:async()=>{throw Error('Preview must never publish')},receipt:()=>undefined,
    driver:{generate:async input=>{
      assert.ok(input.beforeSubmission);assert.ok(input.graphContextRead)
      input.beforeSubmission();callbackChecks++
      const first=input.graphContextRead(['n1']),cached=input.graphContextRead(['n1']);cacheReads+=2
      assert.deepEqual(first,cached)
      if(mutation){
        f.mutate(mutation)
        const expected=mutation==='deleted'?/不存在/:mutation==='moved'?/当前对话工作区/:/REVISION_CONFLICT/
        assert.throws(()=>input.beforeSubmission!(),expected);callbackChecks++
        assert.throws(()=>input.graphContextRead!(['n1']),expected);cacheReads++
        throw Error('Fixture confirmed revoked preview')
      }
      const result=input.compiler!.submit({submission:{mode:'needs-input',summary:'Need one user choice',questions:[{id:'format',question:'Choose the format',options:['text','json']}]}})
      if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:0}
    }},
  })
  const receipt={key:'a'.repeat(64),digest:'b'.repeat(64),kind:'proposed' as const,workflowId:f.context.workflow.id,revision:1,proposalId:'proposal'}
  const historical={...f.task,id:'historical-task',request:{...f.task.request,requestId:'historical-request'},preview:false,state:'published',receipt} as PlanningTask
  ;(service as unknown as {tasks:Map<string,PlanningTask>}).tasks.set(historical.id,historical)
  try{
    const result=await service.start({...f.task.request,instruction:'Inspect the current workflow',preview:true},f.caller)
    assert.equal(result.state,mutation?'failed':'awaiting_input',JSON.stringify(result.diagnostics))
    assert.equal(result.candidateAttempts,0)
    assert.deepEqual(service.get(historical.id,f.caller).receipt,receipt)
    assert.throws(()=>service.get(historical.id,{...f.caller,sessionId:'other-session'}),/不属于当前主对话/)
    assert.equal(f.counts().modelReads,0);assert.equal(f.counts().catalogReads,0)
  }finally{await service.close();f.host.planningUI.dispose();rmSync(directory,{recursive:true,force:true})}
}
console.log(JSON.stringify({ok:true,readonlyPreview:true,deletedDenied:true,movedDenied:true,revisionDenied:true,digestDenied:true,writeMutableGate:true,modelContractSemanticsPreserved:true,historicalReceiptReads:true,callbackChecks,cacheReads,modelCalls:0,workflowRuns:0}))
