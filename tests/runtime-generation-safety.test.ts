import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type WorkflowNode, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelBackend, type ExecutionAdapters } from '../src/host/runtime.ts'
import { initializeUsage, recordUsageCall, settleUsage, settleUsageGroup } from '../src/host/run-usage.ts'

const contexts:{path:string;runtime:WorkflowRuntime}[]=[]
const noModel:ModelBackend={generate:async()=>{throw new Error('确定性测试不得调用模型')}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function n(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode{return{id,kind,config,number:id,title:id,x:0,y:0,fixed:false}}
function setup(backend=noModel,adapters?:ExecutionAdapters){
  const path=mkdtempSync(join(tmpdir(),'runtime-generation-')),storage=new WorkflowStorage(path),runtime=new WorkflowRuntime(storage,backend,adapters)
  contexts.push({path,runtime});return {path,storage,runtime}
}
/** In-process engine double: sequential node calls, optionally holding the first paused request open. */
function scheduler(runtime:WorkflowRuntime,hold:boolean){
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let executions=0
  ;(runtime as any).graphon={engine:{name:'graphon',version:'0.7.0',protocol:1},close:async()=>{},countTokens:async()=>({tokens:1,encoding:'mock',estimated:true}),
    execute:async(graph:any,signal:AbortSignal,call:any)=>{const index=++executions;for(const node of graph.nodes){signal.throwIfAborted();const value=await call(node.id,signal);if(value.control){if(hold&&index===1)await gate;return {status:'paused'}}}return {status:'success'}}}
  return {release,executions:()=>executions}
}
afterEach(async()=>{for(const context of contexts.splice(0)){await context.runtime.close();rmSync(context.path,{recursive:true,force:true})}})

describe('runtime launch generations',()=>{
  it('a human answer that arrives before the paused engine request drains never replays downstream effects',async()=>{
    let effects=0
    const {storage,runtime}=setup(noModel,{execute:async()=>{effects++;return {text:'effect'}}})
    const flow=makeWorkflow('ws','human race',true)
    flow.nodes=[n('in','input',{fields:[]}),n('ask','human',{prompt:'confirm',fields:[],actions:[{id:'go',label:'go'}]}),n('effect','tool',{toolId:'builtin:dummy',inputs:{}}),n('out','output',{text:'ok'})]
    flow.edges=flow.nodes.slice(1).map((node,index)=>({id:`edge${index}`,source:flow.nodes[index]!.id,target:node.id,...(index===1?{port:'go'}:{})}))
    storage.save(flow,0)
    const engine=scheduler(runtime,true),run=runtime.start(flow.id,{})
    while(storage.run(run.id).status!=='waiting')await tick()
    expect((runtime as any).running.has(run.id)).toBe(true)
    runtime.answer(run.id,{__action:'go'})
    await tick();await tick()
    // The successor waits for the old request instead of executing concurrently.
    expect(engine.executions()).toBe(1)
    expect(storage.run(run.id).status).toBe('running')
    engine.release()
    const settled=await runtime.settle(run.id)
    expect(settled.status).toBe('success')
    expect(settled.executions.find(item=>item.nodeId==='ask')?.status).toBe('success')
    expect(() => runtime.answer(run.id,{__action:'go'})).toThrow('不再等待输入')
    expect(effects).toBe(1)
    expect((runtime as any).running.has(run.id)).toBe(false)
  })

  it('keeps a parallel sibling checkpoint that completes after the answer instead of replaying it (real engine)',async()=>{
    let effects=0,release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve)
    const {storage,runtime}=setup(noModel,{execute:async()=>{effects++;entered();await gate;return {text:'effect'}}})
    const flow=makeWorkflow('ws','loop human with parallel effect',true)
    flow.nodes=[n('in','input',{fields:[]}),n('loop','loop',{maxIterations:1,body:{nodes:[n('loop_in','input',{fields:[]}),n('ask','human',{prompt:'confirm',fields:[],actions:[{id:'go',label:'go'}]})],edges:[{id:'body_edge',source:'loop_in',target:'ask'}]}}),n('effect','tool',{toolId:'builtin:dummy',inputs:{}})]
    flow.edges=[{id:'to_loop',source:'in',target:'loop'},{id:'to_effect',source:'in',target:'effect'}]
    storage.save(flow,0)
    const run=runtime.start(flow.id,{})
    await started
    while(storage.run(run.id).status!=='waiting')await tick()
    expect(storage.run(run.id).executions.find(item=>item.nodeId==='effect')?.status).toBe('running')
    runtime.answer(run.id,{__action:'go'})
    release()
    const settled=await runtime.settle(run.id)
    expect(settled.status,settled.error).toBe('success')
    expect(settled.executions.find(item=>item.nodeId==='effect')?.status).toBe('success')
    expect(effects).toBe(1)
  },30_000)

  it('public resume refuses a child run whose root is not re-entering it',async()=>{
    let effects=0
    const {storage,runtime}=setup(noModel,{execute:async()=>{effects++;return {text:'effect'}}})
    scheduler(runtime,false)
    const flow=makeWorkflow('ws','child coordination',true);flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:'builtin:dummy',inputs:{}};flow.nodes[2]!.config.text='done'
    const saved=storage.save(flow,0)
    const root={id:randomUUID(),workflowId:'root-flow',workspaceId:'ws',workflowTitle:'root',sourceRevision:1,graph:saved,status:'paused',inputs:{text:'x'},outputs:{},startedAt:new Date().toISOString(),executions:[]} as unknown as WorkflowRun
    storage.saveRun(root)
    const child={...structuredClone(root),id:randomUUID(),workflowId:saved.id,rootRunId:root.id,executions:saved.nodes.map(node=>({nodeId:node.id,executionId:node.id,number:node.number,title:node.title,status:'pending'}))} as WorkflowRun
    storage.saveRun(child)
    expect(()=>runtime.resume(child.id)).toThrow('子工作流须由所属根运行继续')
    expect(storage.run(child.id).status).toBe('paused')
    expect(storage.run(root.id).status).toBe('paused')
    expect(effects).toBe(0)
  })

  it('resume refuses a paused run that still records a running node',async()=>{
    let effects=0
    const {storage,runtime}=setup(noModel,{execute:async()=>{effects++;return {text:'effect'}}})
    scheduler(runtime,false)
    const flow=makeWorkflow('ws','interrupted pause',true);flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:'builtin:dummy',inputs:{}}
    const saved=storage.save(flow,0)
    const run={id:randomUUID(),workflowId:saved.id,workspaceId:'ws',workflowTitle:'paused',sourceRevision:1,graph:saved,status:'paused',inputs:{text:'x'},outputs:{},startedAt:new Date().toISOString(),executions:saved.nodes.map(node=>({nodeId:node.id,executionId:node.id,number:node.number,title:node.title,status:node.kind==='tool'?'running':'pending'}))} as unknown as WorkflowRun
    storage.saveRun(run)
    expect(()=>runtime.resume(run.id)).toThrow('仍在执行的节点')
    expect(storage.run(run.id).status).toBe('paused')
    expect(effects).toBe(0)
  })
})

describe('late provider usage',()=>{
  it('records a trusted receipt that arrives after the engine exited without changing node status',async()=>{
    let started!:()=>void,release!:(text:string)=>void,onUsage!:(usage:{totalTokens:number}|undefined)=>void
    const begun=new Promise<void>(resolve=>started=resolve)
    const {storage,runtime}=setup({generate:request=>{onUsage=request.onUsage!;started();return new Promise<string>(resolve=>release=resolve)}})
    // Engine double that exits while the model call is outstanding, like GraphonBridge.fail().
    ;(runtime as any).graphon={engine:{name:'graphon',version:'0.7.0',protocol:1},close:async()=>{},countTokens:async()=>({tokens:1,encoding:'mock',estimated:true}),
      execute:async(graph:any,_signal:AbortSignal,call:any)=>{const controller=new AbortController();for(const node of graph.nodes){if(node.kind==='llm'){void call(node.id,controller.signal).catch(()=>{});await begun;controller.abort(new Error('engine exited'));throw new Error('工作流引擎已退出（信号）')}await call(node.id,controller.signal)}return {status:'success'}}}
    const flow=makeWorkflow('ws','late usage',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model:{provider:'fake',model:'offline'},prompt:'test'}
    const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'x'})
    const failed=await runtime.settle(run.id)
    expect(failed.status).toBe('failed')
    expect(failed.usage?.unknownCalls).toBe(1)
    const nodeStatus=failed.executions.find(item=>item.nodeId===flow.nodes[1]!.id)?.status
    onUsage({totalTokens:17});onUsage({totalTokens:99})
    release('ignored late output');await tick();await tick()
    const final=storage.run(run.id)
    expect(final.status).toBe('failed')
    expect(final.usage?.spentTokens).toBe(17)
    expect(final.usage?.unknownCalls).toBe(0)
    expect(Object.values(final.usage!.allocations).map(item=>item.status)).toEqual(['settled'])
    const record=final.executions.find(item=>item.nodeId===flow.nodes[1]!.id)
    expect(record?.status).toBe(nodeStatus)
    expect(record?.tokenUsage).toBe(17)
  })

  it('upgrades an unknown settlement when a trusted receipt arrives after the call returned',async()=>{
    let onUsage!:(usage:{totalTokens:number}|undefined)=>void
    const {storage,runtime}=setup({generate:async request=>{onUsage=request.onUsage!;return 'done'}})
    scheduler(runtime,false)
    const flow=makeWorkflow('ws','receipt after return',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model:{provider:'fake',model:'offline'},prompt:'test'}
    const saved=storage.save(flow,0),run=await runtime.settle(runtime.start(saved.id,{text:'x'}).id)
    expect(run.status).toBe('success');expect(run.usage).toMatchObject({spentTokens:0,unknownCalls:1})
    onUsage({totalTokens:12});onUsage({totalTokens:40})
    const final=storage.run(run.id)
    expect(final.status).toBe('success')
    expect(final.usage).toMatchObject({spentTokens:12,unknownCalls:0})
    expect(final.executions.find(item=>item.nodeId===flow.nodes[1]!.id)).toMatchObject({status:'success',tokenUsage:12})
  })

  it('settles each allocation idempotently and never erases known use',()=>{
    const run={} as WorkflowRun;initializeUsage(run)
    const first=recordUsageCall(run,false),second=recordUsageCall(run,true)
    settleUsage(run,first.id,undefined)
    expect(run.usage).toMatchObject({spentTokens:0,unknownCalls:1})
    settleUsage(run,first.id,{totalTokens:5})
    settleUsage(run,first.id,{totalTokens:8})
    settleUsage(run,first.id,undefined)
    expect(run.usage).toMatchObject({spentTokens:5,unknownCalls:0})
    expect(run.usage!.allocations[first.id]).toEqual({tokens:0,status:'settled',usage:5})
    settleUsageGroup(run,[second.id],{totalTokens:3})
    settleUsageGroup(run,[second.id],{totalTokens:4})
    expect(run.usage).toMatchObject({spentTokens:8,unknownCalls:0})
  })
})
