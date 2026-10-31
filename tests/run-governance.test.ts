import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelBackend, type ExecutionAdapters } from '../src/host/runtime.ts'
import { observeAgentUsage, initializeUsage, ModelAdmission, recordUsageCall, settleUsage } from '../src/host/run-usage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'

const resources:{path:string;runtime:WorkflowRuntime}[]=[]
const model={provider:'fixture',model:'fixture'}
function setup(backend:ModelBackend={generate:async()=>{throw new Error('unexpected model')}},adapters?:ExecutionAdapters){const path=mkdtempSync(join(tmpdir(),'workflow-governance-')),storage=new WorkflowStorage(path),runtime=new WorkflowRuntime(storage,backend,adapters);resources.push({path,runtime});return {storage,runtime,path}}
function ledger():WorkflowRun {const graph=makeWorkflow('workspace');graph.executionPolicy={tokenBudget:100,perTaskTokens:60,maxAgentTasks:2};return {id:'run',workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:1,graph,status:'running',inputs:{},outputs:{},executions:[],startedAt:new Date().toISOString()}}
afterEach(async()=>{for(const {runtime,path} of resources.splice(0)){await runtime.close();rmSync(path,{recursive:true,force:true})}})

describe('usage accounting without execution budgets',()=>{
  it('ignores legacy total, per-task and Agent-count limits without token reservations',()=>{
    const run=ledger()
    for(let i=0;i<101;i++){const call=recordUsageCall(run,true);expect(call.tokens).toBe(0);settleUsage(run,call.id,{totalTokens:1000})}
    expect(run.usage).toMatchObject({agentTasks:101,spentTokens:101000,reservedTokens:0,unknownTokens:0})
    expect(run.usage).not.toHaveProperty('limit')
  })
  it('records unknown receipts without invented token charges or subsequent-step rejection',()=>{
    const run=ledger(),call=recordUsageCall(run,true)
    expect(()=>observeAgentUsage(run,[call.id],undefined,1)).not.toThrow()
    expect(()=>observeAgentUsage(run,[call.id],{totalTokens:100000},2)).not.toThrow()
    settleUsage(run,call.id,undefined);settleUsage(run,call.id,undefined)
    expect(run.usage).toMatchObject({spentTokens:100000,unknownCalls:1,unknownTokens:0,reservedTokens:0})
    expect(()=>recordUsageCall(run,true)).not.toThrow()
  })
  it('settles provider-reported receipts exactly once without allocating future token amounts',()=>{
    const run=ledger(),call=recordUsageCall(run,true)
    observeAgentUsage(run,[call.id],{totalTokens:900},1)
    expect(run.usage).toMatchObject({spentTokens:0,reservedTokens:0})
    settleUsage(run,call.id,{totalTokens:1000});settleUsage(run,call.id,{totalTokens:1000})
    expect(run.usage).toMatchObject({spentTokens:1000,reservedTokens:0,unknownTokens:0})
  })
  it('does not pass a legacy per-task token quota into an LLM request',async()=>{
    const seen:(number|undefined)[]=[]
    const {storage,runtime}=setup({generate:async request=>{seen.push((request as unknown as {maxTokens?:number}).maxTokens);request.onUsage?.({totalTokens:7000});return 'x'.repeat(5000)}})
    const flow=makeWorkflow('workspace','Unlimited output',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model,prompt:'Produce the complete result'};flow.executionPolicy={perTaskTokens:2}
    const done=await runtime.settle(runtime.start(storage.save(flow,0).id,{text:'input'}).id)
    expect(done.status).toBe('success');expect(seen).toEqual([undefined]);expect(done.usage?.spentTokens).toBe(7000)
  })
  it('allows later Agent steps with high or unknown usage while preserving cancellation checks',async()=>{
    let calls=0
    const {storage,runtime}=setup(undefined,{execute:async(_kind,request)=>{
      calls++;expect(request).not.toHaveProperty('tokenLimit');request.beforeModelStep?.(undefined,0)
      request.beforeModelStep?.({totalTokens:120},1);request.beforeModelStep?.(undefined,2);request.onUsage?.(undefined)
      return {text:'completed'}
    }})
    const flow=makeWorkflow('workspace','Legacy limit',true);flow.subAgents=[{id:'worker',number:'agent-1',name:'Worker',prompt:'Perform the assigned task'}];flow.nodes[1]!.kind='agent';flow.nodes[1]!.config={model,prompt:'Do one action',subagentId:'worker'};flow.executionPolicy={tokenBudget:1,perTaskTokens:1,maxAgentTasks:1}
    const done=await runtime.settle(runtime.start(storage.save(flow,0).id,{text:'input'}).id)
    expect(done.status).toBe('success');expect(done.usage).toMatchObject({spentTokens:120,unknownCalls:1,reservedTokens:0});expect(calls).toBe(1)
  })
  it('cancels queued work without starting it and respects the root concurrency cap',async()=>{const admission=new ModelAdmission(2),signal=new AbortController(),first=await admission.acquire('root',1,new AbortController().signal);const waiting=admission.acquire('root',1,signal.signal);const rejection=expect(waiting).rejects.toThrow('stop');signal.abort(new Error('stop'));await rejection;first();const next=await admission.acquire('root',1,new AbortController().signal);next();next()})
  it('runs a legacy one-token workflow without budget_waiting and counts actual reported usage',async()=>{
    let calls=0;const {storage,runtime}=setup({generate:async request=>{calls++;request.onUsage?.({totalTokens:10});return 'done'}})
    const flow=makeWorkflow('workspace','Old quota',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model,prompt:'This input needs more than one token'};flow.executionPolicy={tokenBudget:1,perTaskTokens:1}
    const done=await runtime.settle(runtime.start(storage.save(flow,0).id,{text:'input'}).id)
    expect(done.status).toBe('success');expect(calls).toBe(1);expect(done.usage?.spentTokens).toBe(10);expect(done.usage?.unknownCalls).toBe(0)
  })
  it('runs multiple actual Agent nodes despite a legacy maxAgentTasks=1 quota',async()=>{
    let calls=0
    const {storage,runtime}=setup(undefined,{execute:async(_kind,request)=>{calls++;request.beforeModelStep?.(undefined,0);request.onUsage?.({totalTokens:9});return {text:'result '+calls}}})
    const flow=makeWorkflow('workspace','Two live Agent calls',true),first=flow.nodes[1]!,output=flow.nodes[2]!
    flow.subAgents=[{id:'worker',number:'agent-1',name:'Worker',prompt:'Do the assigned node'}]
    first.kind='agent';first.config={model,prompt:'First operation',subagentId:'worker'}
    const next={...structuredClone(first),id:'second-agent',number:'a-3',config:{...first.config,prompt:'Second operation'}}
    output.number='a-4';output.config.text='{{second-agent.text}}'
    flow.nodes=[flow.nodes[0]!,first,next,output]
    flow.edges=[{id:'one',source:flow.nodes[0]!.id,target:first.id},{id:'two',source:first.id,target:next.id},{id:'three',source:next.id,target:output.id}]
    flow.executionPolicy={tokenBudget:1,perTaskTokens:1,maxAgentTasks:1,maxConcurrentAgents:1}
    const done=await runtime.settle(runtime.start(storage.save(flow,0).id,{text:'input'}).id)
    expect(done.status).toBe('success');expect(calls).toBe(2);expect(done.usage).toMatchObject({agentTasks:2,calls:2,spentTokens:18,reservedTokens:0})
  })
  it('does not mutate an old budget_waiting run on read, and explicit resume skips already successful effects',async()=>{
    let calls=0;const {storage,runtime}=setup({generate:async request=>{calls++;request.onUsage?.({totalTokens:10});return 'done'}})
    const flow=makeWorkflow('workspace','Legacy paused quota',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model,prompt:'Complete remaining work'};flow.executionPolicy={tokenBudget:1,perTaskTokens:1}
    const saved=storage.save(flow,0),legacy:WorkflowRun={id:'old-budget-wait',workflowId:saved.id,workspaceId:saved.workspaceId,workflowTitle:saved.title,sourceRevision:saved.revision,graph:saved,status:'budget_waiting',error:'old quota exhausted',inputs:{text:'original'},outputs:{},startedAt:new Date().toISOString(),executions:saved.nodes.map((node,index)=>({nodeId:node.id,executionId:node.id,number:node.number,title:node.title,status:index===0?'success':'pending',...(index===0?{data:{text:'original'}}:{})}))}
    initializeUsage(legacy).limit=1;storage.saveRun(legacy)
    expect(storage.run(legacy.id)).toEqual(legacy)
    const resumed=runtime.resume(legacy.id);expect(resumed.id).toBe(legacy.id);expect(resumed.error).toBeUndefined()
    const done=await runtime.settle(legacy.id);expect(done.status).toBe('success');expect(calls).toBe(1);expect(done.usage?.spentTokens).toBe(10)
    expect(done.executions[0]!.status).toBe('success');expect(done.usage?.limit).toBe(1)
  })
})

describe('immutable snapshots and recovery',()=>{
  it('does not replay a completed external action when a downstream node failed',async()=>{let actions=0;const {storage,runtime}=setup(undefined,{execute:async()=>{actions++;return {text:'receipt'}}}),flow=makeWorkflow('workspace','No replay',true);flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:'builtin:time.now'};flow.nodes[2]!.config.text='{{missing.text}}';const saved=storage.save(flow,0),done=await runtime.settle(runtime.start(saved.id,{text:'x'}).id);expect(done.status).toBe('failed');expect(actions).toBe(1);expect(()=>runtime.recover(done.id,'resume')).toThrow('已完成的外部操作不能自动重放');expect(storage.runs()).toHaveLength(1);expect(actions).toBe(1)})
  it('pause drains parallel iteration tasks without cancelling or repeating completed effects',async()=>{let announced!:()=>void;const started=new Promise<void>(r=>announced=r),releases:(()=>void)[]=[],signals:AbortSignal[]=[];let calls=0;const {storage,runtime}=setup({generate:request=>{calls++;signals.push(request.signal);if(calls>2){request.onUsage?.({totalTokens:1});return Promise.resolve(request.prompt)}return new Promise<string>(resolve=>{releases.push(()=>{request.onUsage?.({totalTokens:1});resolve(request.prompt)});if(calls===2)announced()})}}),flow=makeWorkflow('workspace','Parallel pause',true),inner=makeWorkflow('workspace','Body',true);inner.nodes[1]!.kind='llm';inner.nodes[1]!.config={model,prompt:'{{item}}'};flow.nodes[1]!.kind='iteration';flow.nodes[1]!.config={parallel:true,concurrency:2,iterator:'[1,2,3]',outputVariable:`${inner.nodes[1]!.id}.text`,body:{nodes:inner.nodes,edges:inner.edges}};const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'x'});await started;await runtime.pause(run.id);releases.forEach(release=>release());const paused=await runtime.settle(run.id);expect(paused.status).toBe('paused');expect(signals.every(signal=>!signal.aborted)).toBe(true);expect(calls).toBe(2);runtime.resume(run.id);const done=await runtime.settle(run.id);expect(done.status).toBe('success');expect(calls).toBe(3)})
  it('freezes env and system variables, pauses after in-flight completion, and resumes unchanged',async()=>{let announce!:()=>void,finish!:(v:string)=>void;const started=new Promise<void>(r=>announce=r);const {storage,runtime}=setup({generate:request=>{announce();return new Promise<string>(r=>finish=v=>{request.onUsage?.({totalTokens:4});r(v)})}});const flow=makeWorkflow('workspace','Snapshot',true);flow.environmentVariables=[{id:'env-id',name:'REGION',type:'string',value:'old'}];flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={model,prompt:'{{env.env-id}}'};flow.nodes[2]!.config.text='{{env.env-id}} / {{sys.workflow_run_id}}';const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'x'},undefined,{sessionId:'session'});await started;expect((await runtime.pause(run.id)).status).toBe('pausing');const future=storage.get(saved.id);future.environmentVariables![0]!.value='new';storage.save(future,future.revision);finish('done');const paused=await runtime.settle(run.id);expect(paused.status).toBe('paused');expect(paused.executions[1]!.status).toBe('success');runtime.resume(run.id);const done=await runtime.settle(run.id);expect(done.outputs.result).toBe(`old / ${run.id}`);expect(done.systemVariables).toEqual(run.systemVariables);expect(done.environment).toEqual({'env-id':'old'})})
  it('uses historical definition but creates new trusted identity on rerun',async()=>{const {storage,runtime}=setup(),flow=makeWorkflow('workspace','Identity',true);flow.nodes[1]!.config.text='{{sys.workflow_run_id}}';const saved=storage.save(flow,0),old=await runtime.settle(runtime.start(saved.id,{text:'x'},undefined,{sessionId:'old-session'}).id);const edited=storage.get(saved.id);edited.nodes[1]!.config.text='new definition';storage.save(edited,edited.revision);const restored=runtime.recover(old.id,'rerun','new-session'),done=await runtime.settle(restored.id);expect(done.id).not.toBe(old.id);expect(done.sourceRunId).toBe(old.id);expect(done.outputs.result).toBe(done.id);expect(done.systemVariables?.session_id).toBe('new-session');expect(done.sourceRevision).toBe(old.sourceRevision)})
  it('rejects unconfirmed side effects on recovery rather than replaying them',async()=>{const {storage,runtime}=setup(),flow=makeWorkflow('workspace','Unknown',true);flow.nodes[1]!.kind='http';flow.nodes[1]!.config={url:'https://example.invalid',method:'POST'};const saved=storage.save(flow,0),done=await runtime.settle(runtime.start(saved.id,{text:'x'}).id);expect(done.status).toBe('failed');expect(()=>runtime.recover(done.id,'resume')).toThrow('结果未确认')})
  it('freezes recursively referenced child definitions and roles before executing',async()=>{const {storage,runtime}=setup(),child=storage.save(makeWorkflow('workspace','Child',true),0),flow=makeWorkflow('workspace','Parent',true);flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:`workflow:${child.id}`,inputs:{text:'x'}};const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'x'});expect(run.dependencySnapshots?.[child.id]?.revision).toBe(child.revision);const next=storage.get(child.id);next.description='changed';storage.save(next,next.revision);expect(storage.run(run.id).dependencySnapshots?.[child.id]?.description).toBe(child.description);await runtime.settle(run.id)})
})

describe('proposal and editor draft persistence',()=>{
  it('requires explicit acceptance, detects revision conflicts and keeps rejected originals',()=>{const {storage}=setup(),editor=new WorkflowEditorState(storage),flow=storage.save(makeWorkflow('workspace','original'),0),candidate={...flow,title:'proposed'},p=editor.propose(candidate,flow.revision);expect(storage.get(flow.id).title).toBe('original');editor.resolve(p.id,'reject',flow.revision);expect(storage.get(flow.id).title).toBe('original');const p2=editor.propose(candidate,flow.revision);storage.save({...flow,description:'concurrent edit'},flow.revision);expect(()=>editor.resolve(p2.id,'accept',flow.revision)).toThrow('修改');expect(editor.proposals(flow.id).find(p=>p.id===p2.id)?.status).toBe('pending')})
  it('persists drafts by flow/session and refuses Secret values or identity reuse',()=>{const {storage}=setup(),flow=storage.save(makeWorkflow('workspace'),0),editor=new WorkflowEditorState(storage),base={id:'draft',workflowId:flow.id,workspaceId:flow.workspaceId,sessionId:'s1',kind:'editor',payload:{generateDraft:'ordinary'},updatedAt:''};editor.saveDraft(base,0);expect(new WorkflowEditorState(storage).drafts(flow.id,'s1')).toHaveLength(1);expect(editor.drafts(flow.id,'s2')).toEqual([]);expect(()=>editor.saveDraft({...base,sessionId:'s2'},1)).toThrow('不能跨');expect(()=>editor.saveDraft({...base,payload:{environmentDraft:{type:'secret',value:'secret'}}},1)).toThrow('Secret')})
})
