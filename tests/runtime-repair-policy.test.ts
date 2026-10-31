import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeWorkflow, type WorkflowExecutionPolicy } from '../src/shared/types.ts'
import { createNativeAgentExecutor, type NativeSubagentService } from '../src/host/native-agent.ts'
import { WorkflowRuntime, type RunStartOptions, type ExecutionAdapters } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'

const cleanup:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const {runtime,directory}of cleanup.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve}}
function setup(policy:WorkflowExecutionPolicy={},values:unknown[]=[{text:'x'},{text:'valid result'}],repairGate?:ReturnType<typeof gate>,verifyEvidence?:ExecutionAdapters['verifyEvidence']){
  const directory=mkdtempSync(join(tmpdir(),'workflow-repair-policy-')),storage=new WorkflowStorage(directory)
  const listeners=new Map<string,Set<(...args:any[])=>any>>(),starts:Parameters<NativeSubagentService['start']>[1][]=[]
  const ctx={on(name:string,callback:(...args:any[])=>any){const set=listeners.get(name)??new Set();set.add(callback);listeners.set(name,set);return()=>set.delete(callback)}} as unknown as Pick<Context,'on'>
  const parent={id:'parent',session:{header:{delegationDepth:0}}} as unknown as Agent
  const service:NativeSubagentService={getProvider:()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true,toolFilter:true,persona:true}}),async start(_name,request){
    const index=starts.length;starts.push(request)
    const id=`child-${index+1}`,child={id,session:{id,header:{parentSession:parent.id}},cancel:vi.fn(),ctx:{tools:{guard(){return()=>{}},presentAs(){return()=>{}}},systemPrompt:{section(){return()=>{}}}}} as unknown as Agent
    for(const listener of listeners.get('agent/created')??[])await listener({agent:child,source:'startup'})
    const result=(async()=>{
      let seq=0
      const emit=(type:string,data:unknown)=>{for(const callback of listeners.get('session/event')??[])callback(child.session,{type,data,seq:seq++})}
      emit('subagent/descriptor',{label:request.label})
      for(const callback of listeners.get('agent/pre-step')??[])await callback({agent:child,signal:request.signal},async()=>({kind:'enter',messages:[]}))
      if(index>0&&repairGate)await Promise.race([repairGate.promise,new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}))])
      if(request.signal.aborted)return {stopReason:'aborted',output:[]}
      emit('assistant/message',{usage:{totalTokens:7}})
      return {stopReason:'completed',structured:values[index]??values.at(-1),output:[]}
    })()
    return {id,localAgent:child,result,async dispose(){await result}}
  }}
  const native=createNativeAgentExecutor({ctx,subagents:()=>service,parentForRun:()=>parent,createParent:async()=>{throw new Error('unexpected parent')},nativeTools:()=>['read_file']})
  const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('No model loop')}},{execute:async(_kind,request)=>native(request),verifyEvidence,...(verifyEvidence?{captureEvidence:async()=>{}}:{})})
  cleanup.push({runtime,directory})
  const flow=makeWorkflow('workspace','Repair policy',true),node=flow.nodes[1]!
  node.kind='agent';node.config={model:{provider:'fake',model:'fixture'},tools:['native:read_file'],prompt:'original task',maxSteps:2,verification:{minTextLength:5,...(verifyEvidence?{requiredFiles:['existing-output.md']}: {})}}
  node.config.subagentId='worker';flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
  flow.executionPolicy={tokenBudget:500,perTaskTokens:50,...policy}
  const saved=storage.save(flow,0)
  return {storage,runtime,starts,node,start:(options:RunStartOptions={})=>runtime.start(saved.id,{text:'input'},undefined,options)}
}

describe('A confirmation and B authorized output repair',()=>{
  it('manual output acceptance still verifies original file evidence, including verifier mutations before CAS',async()=>{
    const verify=vi.fn(async(_node,_workspace,record)=>{record.verification={status:'passed',reasons:['original file evidence is valid']}})
    const f=setup({repairMode:'confirm'},[{text:'x'}],undefined,verify),run=f.start();await f.runtime.settle(run.id)
    await f.runtime.acceptRepairOutput(run.id,f.node.id,{text:'user-verified output'})
    const done=await f.runtime.settle(run.id)
    expect(done.status).toBe('success');expect(verify).toHaveBeenCalled();expect(f.starts).toHaveLength(1)
    expect(done.executions.find(item=>item.nodeId===f.node.id)?.verification?.reasons).toContain('original file evidence is valid')
  })
  it('neither model-repair confirmation nor manual output can bypass missing file evidence',async()=>{
    const verify=vi.fn(async(_node,_workspace,record)=>{record.verification={status:'failed',reasons:['missing read receipt']};throw new Error('missing read receipt')})
    const f=setup({repairMode:'confirm'},[{text:'x'},{text:'valid repaired output'}],undefined,verify),run=f.start();await f.runtime.settle(run.id)
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0);let paused=await f.runtime.settle(run.id)
    expect(paused.status).toBe('paused');expect(paused.executions.find(item=>item.nodeId===f.node.id)).toMatchObject({status:'waiting',repairAttemptsUsed:1,repair:{waiting:true},verification:{status:'failed',reasons:['missing read receipt']}})
    await expect(f.runtime.acceptRepairOutput(run.id,f.node.id,{text:'user output'})).rejects.toThrow('missing read receipt')
    paused=f.storage.run(run.id);expect(paused.executions.find(item=>item.nodeId===f.node.id)?.repair?.waiting).toBe(true)
    expect(f.starts).toHaveLength(2)
  })

  it('keeps independent runs confirmation-only even if the graph says auto',async()=>{
    const f=setup({repairMode:'auto'}),run=f.start(),paused=await f.runtime.settle(run.id),record=paused.executions.find(item=>item.nodeId===f.node.id)!
    expect(paused.status).toBe('paused');expect(f.starts).toHaveLength(1)
    expect(record.repair).toMatchObject({mode:'confirm',usedAttempts:0,reason:'confirmation',waiting:true,candidate:{text:'x'}})
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0)
    const repaired=await f.runtime.settle(run.id)
    expect(repaired.status).toBe('paused');expect(repaired.outputs).toEqual({})
    expect(repaired.executions.find(item=>item.nodeId===f.node.id)).toMatchObject({status:'success',attempt:1,repairAttemptsUsed:1,repair:{waiting:false,usedAttempts:1}})
    expect(f.starts).toHaveLength(2);expect(f.starts[1]!.toolFilter.allow).toEqual([])
    expect(f.starts[1]!.label).toContain('/repair/1');expect(repaired.usage).toMatchObject({calls:2,agentTasks:2,spentTokens:14})
    f.runtime.resume(run.id);expect((await f.runtime.settle(run.id)).status).toBe('success');expect(f.starts).toHaveLength(2)
  })
  it('auto repairs only with a host-origin authorization; explicit A still wins',async()=>{
    for(const repairMode of ['auto','confirm'] as const){
      const f=setup({repairMode}),run=f.start({repairAuthorization:{source:'agent-tool'}}),done=await f.runtime.settle(run.id)
      expect(done.status).toBe(repairMode==='auto'?'success':'paused');expect(f.starts).toHaveLength(repairMode==='auto'?2:1)
      if(repairMode==='auto')expect(done.executions.find(item=>item.nodeId===f.node.id)?.repairAttemptsUsed).toBe(1)
    }
  })
  it('retains the same two-attempt ledger across confirmations, including duplicate stale requests',async()=>{
    const f=setup({repairMode:'confirm'},[{text:'x'}]),run=f.start();await f.runtime.settle(run.id)
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0);let paused=await f.runtime.settle(run.id)
    expect(paused.executions.find(item=>item.nodeId===f.node.id)?.repair?.usedAttempts).toBe(1)
    await expect(f.runtime.confirmRepairOutput(run.id,f.node.id,0)).rejects.toThrow('已变化')
    await f.runtime.confirmRepairOutput(run.id,f.node.id,1);paused=await f.runtime.settle(run.id)
    expect(paused.executions.find(item=>item.nodeId===f.node.id)).toMatchObject({attempt:1,repairAttemptsUsed:2,repair:{usedAttempts:2,waiting:true}})
    await expect(f.runtime.confirmRepairOutput(run.id,f.node.id,2)).rejects.toThrow('总轮次上限')
    expect(f.starts).toHaveLength(3);expect(f.starts.slice(1).every(start=>start.toolFilter.allow.length===0)).toBe(true)
    await f.runtime.acceptRepairOutput(run.id,f.node.id,{text:'manual correction after two attempts'})
    const accepted=await f.runtime.settle(run.id);expect(accepted.status).toBe('success');expect(accepted.executions.find(item=>item.nodeId===f.node.id)?.repairAttemptsUsed).toBe(2);expect(f.starts).toHaveLength(3)
  })
  it('charges auto attempts to the same ledger and will not reset after exhaustion',async()=>{
    const f=setup({repairMode:'auto'},[{text:'x'}]),run=f.start({repairAuthorization:{source:'agent-tool'}}),paused=await f.runtime.settle(run.id)
    expect(paused.status).toBe('paused');expect(f.starts).toHaveLength(3)
    expect(paused.executions.find(item=>item.nodeId===f.node.id)).toMatchObject({repairAttemptsUsed:2,repair:{usedAttempts:2,waiting:true}})
    await expect(f.runtime.confirmRepairOutput(run.id,f.node.id,2)).rejects.toThrow('总轮次上限')
  })
  it('ignores a legacy token budget when admitting an explicitly confirmed output repair',async()=>{
    const f=setup({repairMode:'confirm',tokenBudget:7}),run=f.start();await f.runtime.settle(run.id)
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0);const repaired=await f.runtime.settle(run.id)
    expect(f.starts).toHaveLength(2);expect(repaired.executions.find(item=>item.nodeId===f.node.id)?.repairAttemptsUsed).toBe(1)
    expect(repaired.usage).toMatchObject({spentTokens:14,reservedTokens:0})
  })
  it('cancels the confirmed empty-tool repair through the root and preserves its consumed attempt',async()=>{
    const pending=gate(),f=setup({repairMode:'confirm'},[{text:'x'},{text:'valid result'}],pending),run=f.start();await f.runtime.settle(run.id)
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0)
    await vi.waitFor(()=>expect(f.starts).toHaveLength(2))
    const cancelled=await f.runtime.cancel(run.id)
    expect(cancelled.status).toBe('cancelled');expect(cancelled.executions.find(item=>item.nodeId===f.node.id)?.repairAttemptsUsed).toBe(1)
    await expect(f.runtime.confirmRepairOutput(run.id,f.node.id,1)).rejects.toThrow('暂停完成')
  })
})
