import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createNativeAgentExecutor, type NativeSubagentService } from '../src/host/native-agent.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { makeWorkflow, type NodeConfig } from '../src/shared/types.ts'
import type { ToolCatalog } from '../src/host/tool-catalog.ts'

// Real Graphon + production native/evidence adapters. Only the SDK task provider
// and trusted-tool attestation are explicit doubles; no external model is called.
const resources:{directory:string;runtime:WorkflowRuntime}[]=[]
function fixture(options:{verification:NonNullable<NodeConfig['verification']>;trust?:boolean;files?:Record<string,string>;read?:boolean;write?:string;outputs?:string[]}){
  const directory=mkdtempSync(join(tmpdir(),'runtime-file-evidence-')),workspace=join(directory,'workspace')
  const storage=new WorkflowStorage(join(directory,'state'));requireDirectory(workspace)
  for(const [file,value] of Object.entries(options.files??{}))writeFileSync(join(workspace,file),value)
  const listeners=new Map<string,Set<(...args:any[])=>any>>(),children=new Map<string,Agent>(),starts:Parameters<NativeSubagentService['start']>[1][]=[]
  const ctx={on(name:string,fn:(...args:any[])=>any){const group=listeners.get(name)??new Set();group.add(fn);listeners.set(name,group);return()=>group.delete(fn)}} as unknown as Pick<Context,'on'>
  const parent={id:'parent',session:{header:{delegationDepth:0}}} as Agent
  let actionCount=0
  const service:NativeSubagentService={getProvider:()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true,toolFilter:true,persona:true}}),async start(_name,start){
    starts.push(start);const id=`native-${starts.length}`,index=starts.length-1
    const child={id,session:{id,header:{cwd:workspace,parentSession:'parent'}},ctx:{tools:{guard(){return()=>{}},presentAs(){return()=>{}}},systemPrompt:{section(){}}},cancel(){}} as unknown as Agent;children.set(id,child)
    for(const listener of listeners.get('agent/created')??[])await listener({agent:child,source:'startup'})
    let seq=0
    const emit=(type:string,data:unknown)=>{for(const fn of listeners.get('session/event')??[])fn(child.session,{type,data,seq:seq++})}
    const result=(async()=>{
      emit('subagent/descriptor',{label:start.label})
      for(const fn of listeners.get('agent/pre-step')??[])await fn({agent:child},async()=>({kind:'enter',messages:[]}))
      emit('step/start',{})
      if(index===0){
        actionCount++
        if(options.read){
          const value=readFileSync(join(workspace,'source.txt'),'utf8'),lines=value.trimEnd().split('\n'),outer=Symbol('ptc')
          for(const fn of listeners.get('tools/result')??[])fn({name:'read',arguments:{file_path:'source.txt'},token:Symbol('read'),parent:outer,agent:child},{isError:false,value:{path:join(workspace,'source.txt'),offset:1,totalLines:lines.length,lines:lines.map((text,index)=>({number:index+1,text}))}})
          for(const fn of listeners.get('tools/result')??[])fn({name:'run_code',arguments:{},token:outer,agent:child},{isError:false,value:{}})
        }
        if(options.write!==undefined)writeFileSync(join(workspace,'result.txt'),options.write)
      }
      emit('assistant/message',{usage:{totalTokens:10}})
      return {stopReason:'completed',structured:{text:options.outputs?.[index]??'completed output'},output:[]}
    })()
    return {id,localAgent:child,result,dispose:async()=>{await result}}
  }}
  const native=createNativeAgentExecutor({ctx,subagents:()=>service,parentForRun:()=>parent,createParent:async()=>{throw new Error('Unexpected standalone parent')},nativeTools:()=>['read'],childForId:id=>children.get(id),...(options.trust?{trustedFileReadTools:()=>({read:'dsh-tool-fs/read@0.2.0-rc.2' as const})}:{})})
  const adapters=createExecutionAdapters({catalog:{} as ToolCatalog,workspaceRoot:()=>workspace,nativeAgent:native})
  const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('No external model')}},adapters);resources.push({directory,runtime})
  const flow=makeWorkflow('workspace','evidence fixture',true),node=flow.nodes[1]!
  node.kind='agent';node.config={model:{provider:'fixture',model:'sdk-double'},tools:options.read?['native:read']:[],maxSteps:3,verification:options.verification}
  node.config.subagentId='worker';flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
  flow.executionPolicy={tokenBudget:500,perTaskTokens:50,maxAgentTasks:4,maxRepairAttempts:2}
  const saved=storage.save(flow,0)
  return {runtime,storage,workspace,node,starts,actionCount:()=>actionCount,start:()=>runtime.start(saved.id,{text:'input'})}
}
const requireDirectory=(path:string)=>mkdirSync(path,{recursive:true})
afterEach(async()=>{for(const {directory,runtime} of resources.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})

describe('file evidence at actual execution boundaries',()=>{
  it('captures before/after hashes, preserves action evidence through a validation pause and never replays the original write',async()=>{
    const f=fixture({verification:{requiredFiles:['result.txt'],requiredChangedFiles:['result.txt'],minTextLength:5},write:'actual output',outputs:['x']}),run=f.start()
    const paused=await f.runtime.settle(run.id),record=paused.executions.find(item=>item.nodeId===f.node.id)!
    expect(paused.status).toBe('paused');expect(record.fileEvidence?.before.files['result.txt']?.status).toBe('missing')
    expect(record.fileEvidence?.after?.files['result.txt']).toMatchObject({status:'present',sha256:expect.any(String)})
    const original=structuredClone(record.fileEvidence),usage=structuredClone(paused.usage)
    await f.runtime.acceptRepairOutput(run.id,f.node.id,{text:'manual valid output'})
    const done=await f.runtime.settle(run.id),accepted=done.executions.find(item=>item.nodeId===f.node.id)!
    expect(done.status).toBe('success');expect(f.actionCount()).toBe(1);expect(f.starts).toHaveLength(1)
    expect(accepted.fileEvidence).toEqual(original);expect(done.usage).toEqual(usage)
    expect(accepted.verification?.reasons.join(' ')).toContain('不证明该变化由 Agent 引起')
  })
  it('rejects untrusted required reading before starting the native action',async()=>{
    const f=fixture({verification:{requiredReadFiles:['source.txt']},read:true,files:{'source.txt':'first\nsecond\n'}}),run=f.start(),done=await f.runtime.settle(run.id),record=done.executions.find(item=>item.nodeId===f.node.id)!
    expect(done.status).toBe('failed');expect(record.verification?.status).toBe('unverified');expect(done.outputs).toEqual({})
    expect(record.fileEvidence?.reads).toEqual([]);expect(f.starts).toHaveLength(0);expect(f.actionCount()).toBe(0)
    expect(record.error).toContain('可信读取')
    expect(JSON.stringify(record.fileEvidence)).not.toContain('first')
  })
  it('retains original trusted full-read receipts through an empty-tool model repair, using the same before snapshot',async()=>{
    const f=fixture({verification:{requiredReadFiles:['source.txt'],minTextLength:5},trust:true,read:true,files:{'source.txt':'first\nsecond\n'},outputs:['x','valid repaired output']}),run=f.start(),paused=await f.runtime.settle(run.id),record=paused.executions.find(item=>item.nodeId===f.node.id)!
    expect(paused.status).toBe('paused');expect(record.fileEvidence?.reads).toMatchObject([{taskId:'native-1',status:'passed',calls:1,tools:['read']}])
    const before=structuredClone(record.fileEvidence)
    await f.runtime.confirmRepairOutput(run.id,f.node.id,0)
    const repaired=await f.runtime.settle(run.id)
    expect(repaired.status).toBe('paused');expect(repaired.executions.find(item=>item.nodeId===f.node.id)?.status).toBe('success')
    f.runtime.resume(run.id)
    const done=await f.runtime.settle(run.id),completed=done.executions.find(item=>item.nodeId===f.node.id)!
    expect(done.status).toBe('success');expect(f.actionCount()).toBe(1);expect(f.starts).toHaveLength(2)
    expect(f.starts[1]!.toolFilter.allow).toEqual([]);expect(completed.fileEvidence).toEqual(before)
    expect(done.usage?.spentTokens).toBe(20)
  })
  it('blocks missing required reading before dispatch and preserves the failed before snapshot',async()=>{
    const f=fixture({verification:{requiredReadFiles:['missing.txt']}}),run=f.start(),done=await f.runtime.settle(run.id),record=done.executions.find(item=>item.nodeId===f.node.id)!
    expect(done.status).toBe('failed');expect(f.starts).toHaveLength(0);expect(record.fileEvidence?.before.files['missing.txt']?.status).toBe('missing')
  })
  it('rejects unchanged file contents even if an action reports success',async()=>{
    const f=fixture({verification:{requiredChangedFiles:['result.txt']},files:{'result.txt':'unchanged'},write:'unchanged'}),run=f.start(),done=await f.runtime.settle(run.id),record=done.executions.find(item=>item.nodeId===f.node.id)!
    expect(done.status).toBe('failed');expect(record.verification?.reasons.join(' ')).toContain('内容未发生必要变更')
    expect(record.fileEvidence?.after?.files['result.txt']?.sha256).toBe(record.fileEvidence?.before.files['result.txt']?.sha256)
  })
})
