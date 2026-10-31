import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI, type WorkflowRun } from '../src/shared/types.ts'
import { executionPolicyWarnings, assertGraph, parseWorkflow } from '../src/shared/workflow-validation.ts'

const fixtures:{directory:string;runtime:WorkflowRuntime}[]=[]
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'runtime-request-')),storage=new WorkflowStorage(directory)
  const execute=vi.fn(async()=>({text:'one effect'}))
  const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No model')}},{execute})
  const flow=makeWorkflow('w','Idempotent effect',true);flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:'builtin:test',cache:'reuse'}
  storage.save(flow,0);fixtures.push({directory,runtime});return {directory,storage,runtime,flow,execute}
}
afterEach(async()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0)){await f.runtime.close();rmSync(f.directory,{recursive:true,force:true})}})
describe('client lost replies with durable runtime receipts',()=>{
  it.each(['start','rerun','recover'] as const)('does not replay the %s effect after discarding an older success',async operation=>{
    const f=fixture()
    let sourceId='',planDigest:string|undefined
    if(operation!=='start'){
      const source=f.runtime.start(f.flow.id,{text:'input'})
      await f.runtime.settle(source.id);sourceId=source.id
      // Recovery must redo this tool, so an accidental new identity has a
      // measurable business effect even on the resume/recover path.
      if(operation==='recover'){
        const failed=f.storage.run(sourceId)
        failed.status='failed'
        const pending=failed.executions.find(record=>record.nodeId===f.flow.nodes[1]!.id)!
        pending.status='pending';delete pending.startedAt;delete pending.endedAt;delete pending.attempt;delete pending.data
        f.storage.saveRun(failed);planDigest=f.runtime.recoveryPlan(sourceId).planDigest
      }
      f.execute.mockClear()
    }
    const replies:Array<{run:WorkflowRun;resolve:(run:WorkflowRun)=>void;reject:(error:Error)=>void}>=[]
    const deliver=(run:WorkflowRun)=>new Promise<WorkflowRun>((resolve,reject)=>replies.push({run,resolve,reject}))
    const api={
      list:async()=>({workflows:[f.storage.get(f.flow.id)],workspaces:[],presets:[],runs:[]}),
      get:async()=>f.storage.get(f.flow.id),models:async()=>[],
      save:async(raw,revision)=>f.storage.save(JSON.parse(raw),revision),
      inspectReadiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),
      start:vi.fn((id,raw,sessionId,requestId)=>deliver(f.runtime.start(id,JSON.parse(raw),undefined,{sessionId,requestId}))),
      rerun:vi.fn((id,sessionId,requestId)=>deliver(f.runtime.recover(id,'rerun',sessionId,undefined,undefined,requestId))),
      recover:vi.fn((id,sessionId,digest,review,requestId)=>deliver(f.runtime.recover(id,'resume',sessionId,digest,review,requestId))),
    } satisfies Partial<WorkflowAPI>
    const store=new WorkflowStore(api as WorkflowAPI)
    try{
      await store.load();await store.open(f.flow.id)
      const submit=()=>operation==='start'?store.execute({text:'input'}):store.control(operation,sourceId,planDigest)
      const older=submit()
      await vi.waitFor(()=>expect(replies).toHaveLength(1))
      const done=await f.runtime.settle(replies[0]!.run.id)
      expect(done.status).toBe('success');expect(f.execute).toHaveBeenCalledOnce()
      const newer=submit(),lost=expect(newer).rejects.toThrow('latest reply lost')
      await vi.waitFor(()=>expect(replies).toHaveLength(2))
      replies[1]!.reject(Error('latest reply lost'));await lost
      replies[0]!.resolve(done);await older
      expect(store.getSnapshot().run).toBeUndefined()
      const retry=submit()
      await vi.waitFor(()=>expect(replies).toHaveLength(3))
      const ids=api[operation].mock.calls.map(args=>args.at(-1))
      expect(ids).toEqual([expect.any(String),ids[0],ids[0]])
      expect(replies[2]!.run).toEqual(done)
      replies[2]!.resolve(replies[2]!.run);await retry
      expect(store.getSnapshot().run).toEqual(done)
      expect(f.execute).toHaveBeenCalledOnce()
      expect(f.storage.runs()).toHaveLength(operation==='start'?1:2)
    }finally{store.dispose()}
  })
})
describe('persistent start and recovery request receipts',()=>{
  it('deduplicates active and completed starts, rejects changed parameters, and keeps legacy starts independent',async()=>{
    const f=fixture(),options={requestId:'request-1',sessionId:'session'}
    const first=f.runtime.start(f.flow.id,{text:'input'},undefined,options)
    expect(f.runtime.start(f.flow.id,{text:'input'},undefined,options).id).toBe(first.id)
    const done=await f.runtime.settle(first.id)
    expect(done.status).toBe('success');expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.runtime.start(f.flow.id,{text:'input'},undefined,options)).toEqual(done)
    expect(()=>f.runtime.start(f.flow.id,{text:'changed'},undefined,options)).toThrow('REQUEST_ID_CONFLICT')
    expect(()=>f.runtime.start(f.flow.id,{text:'input'},{provider:'p',model:'m'} as any,options)).toThrow('REQUEST_ID_CONFLICT')
    const legacy=f.runtime.start(f.flow.id,{text:'input'});await f.runtime.settle(legacy.id)
    expect(legacy.id).not.toBe(first.id);expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('retains identity on restart and after ordinary run artifacts have been removed',async()=>{
    const f=fixture(),options={requestId:'restart',sessionId:'session'}
    const first=f.runtime.start(f.flow.id,{text:'input'},undefined,options),done=await f.runtime.settle(first.id)
    await f.runtime.close()
    // Run history retention removes these artifacts; request receipts have independent retention.
    for(const name of readdirSync(join(f.directory,'runs')))rmSync(join(f.directory,'runs',name))
    const storage=new WorkflowStorage(f.directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No model')}})
    fixtures.push({directory:f.directory,runtime})
    expect(runtime.start(f.flow.id,{text:'input'},undefined,options)).toEqual(done)
    expect(()=>runtime.start(f.flow.id,{text:'changed'},undefined,options)).toThrow('REQUEST_ID_CONFLICT')
    expect(storage.runs()).toHaveLength(0)
  })
  it.each(['resume','rerun'] as const)('deduplicates repeated %s confirmation while active, completed and restarted',async mode=>{
    const f=fixture(),source=f.runtime.start(f.flow.id,{text:'input'});await f.runtime.settle(source.id)
    const digest=mode==='resume'?f.runtime.recoveryPlan(source.id).planDigest:undefined
    const recovered=f.runtime.recover(source.id,mode,'session',digest,undefined,'confirm-1')
    expect(f.runtime.recover(source.id,mode,'session',digest,undefined,'confirm-1').id).toBe(recovered.id)
    const done=await f.runtime.settle(recovered.id)
    expect(done.status).toBe('success')
    expect(f.runtime.recover(source.id,mode,'session',digest,undefined,'confirm-1')).toEqual(done)
    expect(()=>f.runtime.recover(source.id,mode,'session','changed',undefined,'confirm-1')).toThrow('REQUEST_ID_CONFLICT')
    expect(()=>f.runtime.recover(source.id,mode,'session',digest,{changed:true},'confirm-1')).toThrow('REQUEST_ID_CONFLICT')
    expect(f.execute).toHaveBeenCalledTimes(mode==='resume'?1:2)
    await f.runtime.close()
    const storage=new WorkflowStorage(f.directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No model')}});fixtures.push({directory:f.directory,runtime})
    expect(runtime.recover(source.id,mode,'session',digest,undefined,'confirm-1')).toEqual(done)
    // The source and result can both age out of the normal run-history window.
    await runtime.close()
    for(const name of readdirSync(join(f.directory,'runs')))rmSync(join(f.directory,'runs',name))
    const afterRetention=new WorkflowRuntime(new WorkflowStorage(f.directory),{generate:async()=>{throw Error('No model')}});fixtures.push({directory:f.directory,runtime:afterRetention})
    expect(afterRetention.recover(source.id,mode,'session',digest,undefined,'confirm-1')).toEqual(done)
  })
  it('stores recovery reuse and confirmation in the first durable run snapshot',async()=>{
    const f=fixture(),source=f.runtime.start(f.flow.id,{text:'input'});await f.runtime.settle(source.id)
    const digest=f.runtime.recoveryPlan(source.id).planDigest,save=f.storage.saveRun.bind(f.storage),snapshots:any[]=[]
    vi.spyOn(f.storage,'saveRun').mockImplementation(run=>{snapshots.push(structuredClone(run));save(run)})
    const recovered=f.runtime.recover(source.id,'resume','session',digest,undefined,'confirm')
    expect(snapshots[0].requestReceipt).toMatchObject({requestId:'confirm',runId:recovered.id})
    expect(snapshots[0].executions.some((record:any)=>record.reusedFromRunId===source.id)).toBe(true)
    await f.runtime.settle(recovered.id);expect(f.execute).toHaveBeenCalledOnce()
  })
  it('does not dispatch when run storage fails after durable admission, and retries never replay it',async()=>{
    const f=fixture()
    vi.spyOn(f.storage,'saveRun').mockImplementationOnce(()=>{throw Error('injected disk failure')})
    expect(()=>f.runtime.start(f.flow.id,{text:'input'},undefined,{requestId:'io-failure'})).toThrow('disk failure')
    expect(f.execute).not.toHaveBeenCalled()
    const receiptFile=join(f.directory,'run-requests',readdirSync(join(f.directory,'run-requests'))[0]!),accepted=JSON.parse(readFileSync(receiptFile,'utf8'))
    await f.runtime.close()
    const storage=new WorkflowStorage(f.directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No model')}});fixtures.push({directory:f.directory,runtime})
    const retry=runtime.start(f.flow.id,{text:'input'},undefined,{requestId:'io-failure'})
    expect(retry.id).toBe(accepted.id);expect(retry.status).toBe('interrupted');expect(storage.run(retry.id).status).toBe('interrupted')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('does not dispatch before the identity receipt is durable',async()=>{
    const f=fixture()
    vi.spyOn((f.runtime as any).requests,'save').mockImplementationOnce(()=>{throw Error('receipt unavailable')})
    expect(()=>f.runtime.start(f.flow.id,{text:'input'},undefined,{requestId:'receipt-io'})).toThrow('receipt unavailable')
    expect(f.storage.runs()).toEqual([]);expect(f.execute).not.toHaveBeenCalled()
    const run=f.runtime.start(f.flow.id,{text:'input'},undefined,{requestId:'receipt-io'});await f.runtime.settle(run.id)
    expect(f.execute).toHaveBeenCalledOnce()
  })
  it('rejects invalid identities and scopes the same id to workspace/session ownership',async()=>{
    const f=fixture()
    for(const requestId of ['', '../escape', 'x'.repeat(161)])expect(()=>f.runtime.start(f.flow.id,{text:'x'},undefined,{requestId})).toThrow('requestId')
    const first=f.runtime.start(f.flow.id,{text:'x'},undefined,{requestId:'same',sessionId:'one'});await f.runtime.settle(first.id)
    const second=f.runtime.start(f.flow.id,{text:'x'},undefined,{requestId:'same',sessionId:'two'});await f.runtime.settle(second.id)
    expect(second.id).not.toBe(first.id);expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('fails closed on corrupt independent receipts',async()=>{
    const f=fixture(),first=f.runtime.start(f.flow.id,{text:'x'},undefined,{requestId:'corrupt'});await f.runtime.settle(first.id);await f.runtime.close()
    const file=join(f.directory,'run-requests',readdirSync(join(f.directory,'run-requests'))[0]!),row=JSON.parse(readFileSync(file,'utf8'));row.requestReceipt.runId='wrong';writeFileSync(file,JSON.stringify(row))
    expect(()=>new WorkflowRuntime(f.storage,{generate:async()=>''})).toThrow('回执格式无效')
  })
})
describe('legacy execution quota notices',()=>{
  it.each(['maxAgentTasks','tokenBudget','perTaskTokens'] as const)('reports explicit %s without blocking save or execution',async key=>{
    const f=fixture(),flow=parseWorkflow({...f.flow,executionPolicy:{[key]:1}})
    expect(()=>assertGraph(flow,true)).not.toThrow()
    expect(executionPolicyWarnings(flow)).toEqual([{message:expect.stringContaining(key)}])
    f.storage.save(flow,1)
    const done=await f.runtime.settle(f.runtime.start(flow.id,{text:'x'}).id)
    expect(done.status).toBe('success');expect(done.compatibilityWarnings?.[0]?.message).toContain('已不生效')
    expect(done.usage?.limit).toBeUndefined()
  })
  it('keeps default and current safety policies free of legacy warnings',()=>{
    const f=fixture();expect(executionPolicyWarnings(f.flow)).toEqual([])
    f.flow.executionPolicy={maxConcurrentAgents:2,maxRepairAttempts:1};expect(executionPolicyWarnings(f.flow)).toEqual([])
  })
})
