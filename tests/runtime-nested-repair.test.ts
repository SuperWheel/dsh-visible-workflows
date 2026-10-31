import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, newId } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { HumanPause, WorkflowRuntime, type AdapterRequest, type ExecutionAdapters } from '../src/host/runtime.ts'
import { NativeRepairExhaustedError } from '../src/host/native-agent.ts'

const resources:{path:string;runtime:WorkflowRuntime}[]=[]
const model={provider:'fixture',model:'nested-repair'}
afterEach(async()=>{for(const {runtime,path} of resources.splice(0)){await runtime.close();rmSync(path,{recursive:true,force:true})}})

function setup(nextKind:'template'|'llm',canRepair=false,holdRepair=false,rootRepairLimit?:number){
  const path=mkdtempSync(join(tmpdir(),'workflow-nested-repair-')),storage=new WorkflowStorage(path)
  let agentCalls=0,modelCalls=0,repairCalls=0,childId='',rootId=''
  const child=makeWorkflow('workspace','Child output repair',true),[input,agent,output]=child.nodes
  agent!.kind='agent';agent!.config={model,prompt:'Perform the action once',tools:[],outputSchema:[{name:'text',type:'string',required:true}]}
  agent!.config.subagentId='worker';child.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
  const next={...structuredClone(agent!),id:newId(),number:'a-3',title:'After corrected output',kind:nextKind,config:nextKind==='llm'?{model,prompt:`{{${agent!.id}.text}}`}:{text:`after {{${agent!.id}.text}}`}}
  output!.number='a-4';output!.config.text=`{{${next.id}.text}}`
  child.nodes=[input!,agent!,next,output!];child.edges=[{id:newId(),source:input!.id,target:agent!.id},{id:newId(),source:agent!.id,target:next.id},{id:newId(),source:next.id,target:output!.id}]
  const savedChild=storage.save(child,0),root=makeWorkflow('workspace','Root owns continuation',true)
  root.nodes[1]!.kind='tool';root.nodes[1]!.config={toolId:`workflow:${savedChild.id}`,inputs:{text:'{{input.text}}'}}
  root.executionPolicy={tokenBudget:500,perTaskTokens:100,...(rootRepairLimit!==undefined?{maxRepairAttempts:rootRepairLimit}:{})}
  const savedRoot=storage.save(root,0)
  let runtime:WorkflowRuntime
  // This adapter follows index.runNested's real start/resume, snapshot and root
  // ledger contract. Graph scheduling and pause/drain use the Graphon subprocess.
  const adapters:ExecutionAdapters={execute:async(kind,request:AdapterRequest)=>{
    if(kind==='agent'){
      if(request.outputRepair){repairCalls++;request.onTask?.('repair-only-task');if(holdRepair)await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));request.signal.throwIfAborted();request.onUsage?.({totalTokens:8});return {text:'repaired receipt',json:{text:'repaired receipt'}}}
      agentCalls++;request.onTask?.('one-action-task');request.onUsage?.({totalTokens:11})
      throw new NativeRepairExhaustedError('已完成动作，输出需人工修正',[],{text:3},canRepair?2:0,canRepair?'confirmation':'disabled')
    }
    if(kind!=='tool')throw new Error(`Unexpected adapter: ${kind}`)
    const parent=storage.run(request.runId),flow=parent.dependencySnapshots![savedChild.id]!
    const nested=request.childRunId?runtime.resume(request.childRunId):runtime.start(flow.id,{text:String(request.inputs.text)},parent.modelDefaults,{sourceGraph:flow,toolConstraints:parent.toolConstraints,rolePrompts:parent.dependencyRolePrompts?.[flow.id]??{},dependencySnapshots:parent.dependencySnapshots,dependencyRolePrompts:parent.dependencyRolePrompts,rootRunId:parent.rootRunId??parent.id})
    childId=nested.id;request.onChild?.(childId)
    const done=await runtime.settle(childId)
    if(done.status==='paused')throw new HumanPause()
    if(done.status!=='success')throw new Error(done.error??done.status)
    return {text:done.outputs.result!,run_id:done.id}
  }}
  runtime=new WorkflowRuntime(storage,{generate:async request=>{modelCalls++;expect(storage.run(rootId).status).toBe('running');request.onUsage?.({totalTokens:7});return 'model after correction'}},adapters)
  resources.push({path,runtime});rootId=runtime.start(savedRoot.id,{text:'original input'}).id
  return {storage,runtime,rootId,childId:()=>childId,agentId:agent!.id,nextId:next.id,agentCalls:()=>agentCalls,repairCalls:()=>repairCalls,modelCalls:()=>modelCalls}
}

describe('nested output repair stays under root continuation',()=>{
  it('cancels an active child repair from its root and does not open a separate usage context',async()=>{
    const f=setup('llm',true,true);await f.runtime.settle(f.rootId)
    await f.runtime.confirmRepairOutput(f.childId(),f.agentId,0)
    await vi.waitFor(()=>expect(f.repairCalls()).toBe(1))
    expect(()=>f.runtime.resume(f.childId())).toThrow('根运行正在执行')
    const root=await f.runtime.cancel(f.rootId),child=f.storage.run(f.childId())
    expect(root.status).toBe('cancelled');expect(child.status).toBe('cancelled');expect(f.modelCalls()).toBe(0)
    expect(child.executions.find(record=>record.nodeId===f.agentId)?.repairAttemptsUsed).toBe(1)
    expect(root.usage).toMatchObject({calls:2,agentTasks:2,unknownCalls:1});expect(child.usage?.calls).toBe(0)
  })
  it('does not let a child output record relax the root repair limit',async()=>{
    const f=setup('template',true,false,0);await f.runtime.settle(f.rootId)
    await expect(f.runtime.confirmRepairOutput(f.childId(),f.agentId,0)).rejects.toThrow('总轮次上限')
    expect(f.repairCalls()).toBe(0)
  })

  it('charges a confirmed child repair to the root and leaves every successor paused',async()=>{
    const f=setup('llm',true),initial=await f.runtime.settle(f.rootId),childId=f.childId()
    expect(initial.usage?.spentTokens).toBe(11)
    await f.runtime.confirmRepairOutput(childId,f.agentId,0)
    const child=await f.runtime.settle(childId),root=await f.runtime.settle(f.rootId)
    expect(child.status).toBe('paused');expect(root.status).toBe('paused');expect(f.agentCalls()).toBe(1);expect(f.repairCalls()).toBe(1);expect(f.modelCalls()).toBe(0)
    expect(root.usage).toMatchObject({spentTokens:19,calls:2,agentTasks:2});expect(child.usage?.spentTokens).toBe(0)
    expect(child.executions.find(record=>record.nodeId===f.agentId)).toMatchObject({status:'success',repairAttemptsUsed:1,repair:{waiting:false}})
    f.runtime.resume(f.rootId);expect((await f.runtime.settle(f.rootId)).status).toBe('success')
    expect(f.agentCalls()).toBe(1);expect(f.modelCalls()).toBe(1)
  })
  it('does not let a child confirmation escape a cancelled root',async()=>{
    const f=setup('template',true);await f.runtime.settle(f.rootId)
    await f.runtime.cancel(f.rootId)
    await expect(f.runtime.confirmRepairOutput(f.childId(),f.agentId,0)).rejects.toThrow('暂停完成')
    expect(f.repairCalls()).toBe(0)
  })

  it.each(['template','llm'] as const)('keeps the corrected child paused until its root resumes (%s successor)',async nextKind=>{
    const test=setup(nextKind),paused=await test.runtime.settle(test.rootId),childId=test.childId()
    expect(paused.status).toBe('paused');expect(test.storage.run(childId).status).toBe('paused')
    expect(paused.usage).toMatchObject({spentTokens:11,reservedTokens:0,unknownTokens:0,agentTasks:1,calls:1})
    expect(()=>test.runtime.resume(test.rootId)).toThrow('先处理验证暂停')
    const corrected=await test.runtime.acceptRepairOutput(childId,test.agentId,{text:'corrected receipt'})
    expect(corrected.status).toBe('paused');expect(corrected.rootRunId).toBe(test.rootId)
    expect(corrected.executions.find(record=>record.nodeId===test.agentId)).toMatchObject({status:'success',repair:{waiting:false}})
    expect(corrected.executions.find(record=>record.nodeId===test.nextId)?.status).not.toBe('success')
    const stillPaused=await test.runtime.settle(childId)
    expect(stillPaused.status).toBe('paused');expect(stillPaused.outputs).toEqual({})
    expect(test.storage.run(test.rootId).usage).toEqual(paused.usage);expect(test.agentCalls()).toBe(1);expect(test.modelCalls()).toBe(0)

    test.runtime.resume(test.rootId)
    const done=await test.runtime.settle(test.rootId)
    expect(done.status).toBe('success');expect(test.storage.run(childId).status).toBe('success')
    expect(done.outputs.result).toBe(nextKind==='llm'?'model after correction':'after corrected receipt')
    expect(test.agentCalls()).toBe(1);expect(test.modelCalls()).toBe(nextKind==='llm'?1:0)
    expect(done.usage).toMatchObject({spentTokens:nextKind==='llm'?18:11,reservedTokens:0,unknownTokens:0,agentTasks:1,calls:nextKind==='llm'?2:1})
    expect(test.storage.run(childId).usage?.spentTokens).toBe(0)
    expect(test.storage.runs()).toHaveLength(2)
  })
})
