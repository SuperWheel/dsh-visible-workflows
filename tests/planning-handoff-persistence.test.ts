import { PlanningStore } from '../src/host/planning/store.ts'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowPlanningService,planningDigest,type PlanningCaller,type PlanningTask } from '../src/host/planning/service.ts'
import type { PlanningAgentInput } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import type { PlanningRequest } from '../src/shared/planning-types.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(retentionLimits?:{maxRows?:number;snapshotBytes?:number}){
  const directory=mkdtempSync(join(tmpdir(),'handoff-persistence-'));directories.push(directory)
  const base={...makeWorkflow('workspace','Existing',true),revision:1},receipts=new Map<string,PlanningReceipt>()
  const caller:PlanningCaller={parent:{id:'owner'} as Agent,sessionId:'owner',workspaceId:'workspace',signal:new AbortController().signal}
  const generate=vi.fn(async(input:PlanningAgentInput)=>{
    input.beforeStep?.(100,undefined);input.beforeSubmission?.()
    const result=input.compiler!.submit({submission:{mode:'edit',updates:{n2:{set:{text:'Allowed completion'}}},coverage:{R1:['n2']}}})
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    return {output:result.value,steps:1,usage:{totalTokens:1}}
  })
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={
    directory,retentionLimits,compilerMode:'compact-repair',admission:new ModelAdmission(2),driver:{generate},
    context:async request=>({...templateContext(),operation:request.operation,workflow:request.operation==='create'?templateContext().workflow:structuredClone(base),targetNodeIds:request.targetNodeIds??[]}),
    authorize:(task,owner)=>{if(task.workspaceId!==owner.workspaceId||task.sessionId!==owner.sessionId)throw Error('FORBIDDEN')},
    readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),
    publish:vi.fn(async(flow,task,_caller,commit)=>{receipts.set(commit.key,{...commit,kind:task.request.operation==='create'?'created':'proposed',workflowId:flow.id,revision:task.request.operation==='create'?1:flow.revision,...(task.request.operation==='revise'?{proposalId:'proposal-'+task.id}:{})})}),
    receipt:key=>receipts.get(key),
  }
  const reopen=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service},service=reopen()
  const file=join(directory,'planning/tasks.json')
  const read=()=>JSON.parse(readFileSync(file,'utf8')) as {version:number;tasks:PlanningTask[]}
  const mutate=(id:string,change:(task:PlanningTask)=>void,pending=true)=>{
    const stored=read(),task=stored.tasks.find(task=>task.id===id)!
    if(pending){task.state='ready';if(task.commit)receipts.delete(task.commit.key);delete task.commit;delete task.receipt}
    change(task);task.candidateDigest=planningDigest(task.candidate)
    writeFileSync(file,JSON.stringify(stored))
  }
  const edit=(id:string,partial=false):PlanningRequest=>({requestId:id,operation:'revise',instruction:'Apply the decided greeting',targetWorkflowId:base.id,expectedRevision:1,targetNodeIds:[base.nodes[1]!.id],handoff:partial?
    {version:1,mode:'partial',constraints:[],evidenceRefs:[],changes:[{op:'set-title',nodeId:base.nodes[1]!.id,value:'Decided title'}],unresolved:[{nodeId:base.nodes[1]!.id,fields:['text'],question:'Fill text only'}]}:
    {version:1,mode:'edit',constraints:[],evidenceRefs:[],changes:[{op:'set-config',nodeId:base.nodes[1]!.id,field:'text',value:'Decided greeting'}]}})
  const moduleRequest=(id:string):PlanningRequest=>({requestId:id,operation:'create',instruction:'Render the explicitly selected columns',handoff:{version:1,mode:'module',constraints:[],evidenceRefs:[],module:{moduleId:'structured-result-table',version:'1.0.0',instanceKey:'report',parameters:{title:'Report',columns:[{key:'name',label:'Name'}],emptyText:'No rows'}}}})
  return {directory,base,caller,options,service,reopen,read,mutate,edit,moduleRequest,receipts,generate}
}
describe('handoff decisions survive storage and publication faults',()=>{
  it.each([false,true])('blocks a valid-JSON %s handoff candidate whose decided text/title changed with a synchronized digest',async partial=>{
    const f=fixture(),task=await f.service.start(f.edit('decided',partial),f.caller)
    expect(task.state).toBe('published');await f.service.close()
    f.mutate(task.id,row=>{if(partial)row.candidate!.nodes[1]!.title='Rolled back';else row.candidate!.nodes[1]!.config.text='Changed after compilation'})
    vi.mocked(f.options.publish).mockClear()
    const reopened=f.reopen(),restored=reopened.get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.at(-1)!.code).toBe('HANDOFF_CANDIDATE_INVALID')
    await expect(reopened.publish(task.id,restored.revision,restored.candidateDigest!,f.caller)).rejects.toThrow('版本')
    expect(f.options.publish).not.toHaveBeenCalled()
    expect(f.read().tasks.find(row=>row.id===task.id)!.state).toBe('blocked')
  })
  it('blocks changes outside the frozen node scope while keeping unrelated historical tasks readable',async()=>{
    const f=fixture(),legacy=await f.service.start({...f.edit('historical'),handoff:undefined},f.caller),task=await f.service.start(f.edit('new-handoff'),f.caller)
    expect(legacy.state).toBe('published');await f.service.close()
    f.mutate(task.id,row=>{row.candidate!.nodes[2]!.config.text='Unauthorized output change'})
    const restored=f.reopen()
    expect(restored.get(task.id,f.caller).state).toBe('blocked')
    expect(restored.get(legacy.id,f.caller).state).toBe('published')
    expect(restored.get(legacy.id,f.caller).diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')).toBe(false)
  })
  it('rechecks the same decisions immediately before publication even if memory changed after generation',async()=>{
    const f=fixture(),task=await f.service.start(f.edit('publish-guard'),f.caller)
    const internal=(f.service as any).tasks.get(task.id) as PlanningTask
    internal.state='ready';delete internal.commit;delete internal.receipt;f.receipts.clear()
    internal.candidate!.nodes[1]!.config.text='Fault injected after compilation';internal.candidateDigest=planningDigest(internal.candidate)
    vi.mocked(f.options.publish).mockClear()
    const result=await f.service.publish(task.id,internal.revision,internal.candidateDigest,f.caller)
    expect(result.state).toBe('conflict');expect(result.diagnostics.at(-1)!.code).toBe('HANDOFF_DECISION_CONFLICT')
    expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('retains genuine atomic receipt evidence when a newly altered handoff no longer matches its committed candidate',async()=>{
    const f=fixture(),task=await f.service.start(f.edit('receipt-evidence'),f.caller),receipt=structuredClone(task.receipt)
    await f.service.close()
    f.mutate(task.id,row=>{
      if(row.request.handoff?.mode!=='edit')throw Error('expected edit')
      row.request.handoff.changes[0]={op:'set-config',nodeId:f.base.nodes[1]!.id,field:'text',value:'Tampered decision'}
      row.requestDigest=planningDigest(row.request);row.handoffState!.decisionDigest=planningDigest(row.request.handoff)
    },false)
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.receipt).toEqual(receipt)
    expect(restored.diagnostics.at(-1)!.code).toBe('HANDOFF_CANDIDATE_INVALID')
  })
  it.each(['code','provenance'] as const)('rejects changed module %s without treating the stored digest as proof',async field=>{
    const f=fixture(),task=await f.service.start(f.moduleRequest('module-'+field),f.caller)
    expect(task.state).toBe('published');await f.service.close()
    f.mutate(task.id,row=>{if(field==='code')row.candidate!.nodes.find(node=>node.kind==='code')!.config.code='function main(){return {text:"altered",count:0}}';else row.moduleProvenance!.parametersDigest='0'.repeat(64)})
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.at(-1)!.code).toBe('HANDOFF_CANDIDATE_INVALID')
  })
  it('excludes timestamps from decision comparison and does not silently authorize canvas layout edits',async()=>{
    const f=fixture(),task=await f.service.start(f.edit('timestamp'),f.caller)
    const timestamp=structuredClone(task);timestamp.candidate!.updatedAt='2026-10-19T00:00:00.000Z'
    expect(()=>(f.service as any).validateHandoffCandidate(timestamp)).not.toThrow()
    await f.service.close()
    f.mutate(task.id,row=>{row.candidate!.nodes[1]!.x+=50})
    expect(f.reopen().get(task.id,f.caller).state).toBe('blocked')
  })
  it('restores module updates independently of row order and rejects a source with corrupted provenance',async()=>{
    const f=fixture(),created=await f.service.start(f.moduleRequest('module-source'),f.caller)
    expect(created.state).toBe('published')
    const current={...structuredClone(created.candidate!),revision:1}
    f.options.context=async request=>({...templateContext(),workflow:structuredClone(current),operation:request.operation,targetNodeIds:request.targetNodeIds??[]})
    const request=f.moduleRequest('module-update');request.operation='revise';request.targetWorkflowId=current.id;request.expectedRevision=1
    if(request.handoff?.mode!=='module')throw Error('expected module')
    request.handoff.module.parameters.title='Updated report'
    const updated=await f.service.start(request,f.caller)
    expect(updated.state,JSON.stringify(updated.diagnostics)).toBe('published');await f.service.close()
    f.mutate(updated.id,()=>{})
    const reordered=f.read();reordered.tasks.reverse();writeFileSync(join(f.directory,'planning/tasks.json'),JSON.stringify(reordered))
    const valid=f.reopen();expect(valid.get(updated.id,f.caller).state).toBe('ready');await valid.close()
    f.mutate(created.id,row=>{row.moduleProvenance!.parametersDigest='0'.repeat(64)},false)
    const denied=f.reopen()
    expect(denied.get(created.id,f.caller).state).toBe('blocked')
    expect(denied.get(updated.id,f.caller).state).toBe('blocked')
    expect(denied.get(created.id,f.caller).receipt).toEqual(created.receipt)
  })
})


describe('planning service retention and lineage',()=>{
  it('drops ended details from memory, dedupe and restart while preserving publication receipts',async()=>{
    const f=fixture({maxRows:4}),tasks:PlanningTask[]=[]
    for(let index=0;index<5;index++)tasks.push(await f.service.start(f.edit(`retain-${index}`),f.caller))
    expect(tasks.every(task=>task.state==='published')).toBe(true)
    for(const task of tasks.slice(0,2)){
      expect(()=>f.service.get(task.id,f.caller)).toThrow('已清理')
      expect(f.service.findRequest(task.request.requestId,f.caller)).toBeUndefined()
      expect(f.receipts.get(task.commit!.key)).toEqual(task.receipt)
    }
    expect(f.read().tasks.map(task=>task.id)).toEqual(tasks.slice(2).map(task=>task.id))
    expect((await f.service.start(f.edit('retain-4'),f.caller)).id).toBe(tasks[4]!.id)
    await f.service.close()
    const reopened=f.reopen()
    expect(()=>reopened.get(tasks[0]!.id,f.caller)).toThrow('已清理')
    await reopened.start(f.edit('retain-5'),f.caller)
    expect(f.read().tasks.some(task=>task.id===tasks[0]!.id)).toBe(false)
  })
  it('pins committed module ancestors of retained ready updates, without weakening missing-source validation',async()=>{
    const f=fixture({maxRows:4}),originalContext=f.options.context
    const created=await f.service.start(f.moduleRequest('retained-source'),f.caller)
    const current={...structuredClone(created.candidate!),revision:1}
    f.options.context=async request=>({...templateContext(),workflow:structuredClone(current),operation:request.operation,targetNodeIds:request.targetNodeIds??[]})
    const request=f.moduleRequest('retained-update');request.operation='revise';request.targetWorkflowId=current.id;request.expectedRevision=1
    const updated=await f.service.start(request,f.caller)
    expect(updated.state).toBe('published');await f.service.close()
    f.mutate(updated.id,()=>{})
    f.options.context=originalContext
    const service=f.reopen(),unrelated:PlanningTask[]=[]
    for(let index=0;index<3;index++)unrelated.push(await service.start(f.edit(`other-${index}`),f.caller))
    expect(()=>service.get(unrelated[0]!.id,f.caller)).toThrow('已清理')
    expect(service.get(created.id,f.caller).state).toBe('published')
    await service.close()
    const restored=f.reopen()
    expect(restored.get(updated.id,f.caller).state).toBe('ready')
    expect(restored.get(updated.id,f.caller).diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')).toBe(false)
    await restored.close()
    const stored=f.read();stored.tasks=stored.tasks.filter(task=>task.id!==created.id)
    writeFileSync(join(f.directory,'planning/tasks.json'),JSON.stringify(stored))
    expect(f.reopen().get(updated.id,f.caller).state).toBe('blocked')
  })
  it('protects every nonterminal state, active terminal tasks and command links',async()=>{
    const f=fixture(),task=await f.service.start(f.edit('state-protection'),f.caller),service=f.service as any
    for(const state of ['ready','awaiting_input','collecting','queued','distilling','authoring','validating','repairing','optimizing','regressing','publishing','cancelling'])expect(service.canEvict({...task,state},[]),state).toBe(false)
    for(const state of ['published','failed','cancelled','blocked','interrupted','returned','handed_off','conflict'])expect(service.canEvict({...task,state},[]),state).toBe(true)
    expect(service.canEvict(task,[{...task,id:'linked',commandIntake:{linkedTaskId:task.id}}])).toBe(false)
    service.active.set(task.id,{done:Promise.resolve(task)})
    expect(service.canEvict(task,[])).toBe(false);service.active.delete(task.id)
  })
})


describe('background retention',()=>{
  it.each([false,true])('removes stale envelopes with evicted %s preview details so restart cannot resurrect them',async preview=>{
    const f=fixture({maxRows:4})
    Object.assign(f.caller.parent,{session:{id:f.caller.sessionId}})
    f.options.backgroundRuntime={isLive:()=>true,withInitiator:(_parent,run)=>run(),onDisposed:()=>()=>{}}
    f.options.context=async()=>{throw new Error('Offline context failure')}
    const tasks:PlanningTask[]=[]
    for(let index=0;index<5;index++){
      const task=await f.service.start({...f.edit(`background-${index}`),preview},f.caller,{background:true})
      await (f.service as any).active.get(task.id)?.done
      tasks.push(f.service.get(task.id,f.caller))
    }
    expect(tasks.every(task=>task.state==='failed')).toBe(true)
    const envelopes=()=>new PlanningStore<{id:string;preview:false}>(f.directory,()=>true,'background.json').read(row=>row as {id:string;preview:false})
    expect(envelopes().map(row=>row.id)).toEqual(tasks.slice(2).map(task=>task.id))
    expect(()=>f.service.get(tasks[0]!.id,f.caller)).toThrow('已清理')
    await f.service.close()
    const restored=f.reopen()
    expect(()=>restored.get(tasks[0]!.id,f.caller)).toThrow('已清理')
    expect(restored.get(tasks[4]!.id,f.caller).state).toBe(preview?'interrupted':'failed')
    const next=await restored.start({...f.edit('background-next'),preview},f.caller,{background:true})
    await (restored as any).active.get(next.id)?.done
    expect(envelopes().some(row=>row.id===tasks[0]!.id)).toBe(false)
  })
})


it('retains legacy pending proposal baselines only while the editor needs them',async()=>{
  const f=fixture({maxRows:4}),legacy=await f.service.start(f.edit('legacy-pending'),f.caller)
  f.options.retainReceiptBase=receipt=>receipt.key===legacy.commit!.key
  for(let index=0;index<4;index++)await f.service.start(f.edit(`modern-${index}`),f.caller)
  expect(f.service.get(legacy.id,f.caller).state).toBe('published')
  f.options.retainReceiptBase=()=>false
  for(let index=4;index<6;index++)await f.service.start(f.edit(`modern-${index}`),f.caller)
  expect(()=>f.service.get(legacy.id,f.caller)).toThrow('已清理')
  expect(f.receipts.has(legacy.commit!.key)).toBe(true)
})


it('rejects admission without evicting ready previews when no ended task can make room',async()=>{
  const f=fixture({maxRows:2}),tasks:PlanningTask[]=[]
  for(let index=0;index<2;index++)tasks.push(await f.service.start({...f.edit(`waiting-publish-${index}`),preview:true},f.caller))
  expect(tasks.every(task=>task.state==='ready')).toBe(true)
  await expect(f.service.start({...f.edit('no-room'),preview:true},f.caller)).rejects.toThrow('规划记录超过容量')
  for(const task of tasks)expect(f.service.get(task.id,f.caller).state).toBe('ready')
  expect(f.service.findRequest('no-room',f.caller)).toBeUndefined()
})
