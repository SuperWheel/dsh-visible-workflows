import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type Workflow, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type AdapterRequest, type ModelBackend } from '../src/host/runtime.ts'

const contexts:{path:string;runtime:WorkflowRuntime}[]=[]
const model={provider:'fixture',model:'revision'}
function setup(kind:'llm'|'http'='llm',configure?:(flow:Workflow)=>void){
  const path=mkdtempSync(join(tmpdir(),'workflow-revision-')),storage=new WorkflowStorage(path)
  let calls=0,announce!:()=>void,finish!:()=>void
  const started=new Promise<void>(resolve=>{announce=resolve})
  const held=(signal:AbortSignal,onUsage?:Parameters<ModelBackend['generate']>[0]['onUsage'])=>{calls++;return new Promise<string>((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new Error('cancelled'));signal.addEventListener('abort',abort,{once:true})
    finish=()=>{signal.removeEventListener('abort',abort);onUsage?.({totalTokens:13});resolve('completed result')};announce()
  })}
  const runtime=new WorkflowRuntime(storage,{generate:request=>held(request.signal,request.onUsage)},kind==='http'?{execute:async(_kind,request:AdapterRequest)=>({text:await held(request.signal)})}:undefined)
  contexts.push({path,runtime})
  const flow=makeWorkflow('workspace','Revision',true);flow.nodes[1]!.kind=kind;flow.nodes[1]!.config=kind==='llm'?{model,prompt:'{{sys.workflow_run_id}}',cache:'reuse'}:{url:'https://test.invalid/{{sys.workflow_run_id}}',headers:{'x-time':'{{sys.timestamp}}'},method:'POST',cache:'reuse'};flow.executionPolicy={tokenBudget:500,perTaskTokens:100};configure?.(flow)
  const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'original'},undefined,{sessionId:'session'})
  const pause=async()=>{await started;await runtime.pause(run.id);finish();const paused=await runtime.settle(run.id);expect(paused.status).toBe('paused');return paused}
  const candidate=()=>{const next=storage.run(run.id).graph;next.nodes[2]!.config.text=`revised {{${next.nodes[1]!.id}.text}}`;return next}
  return {storage,runtime,saved,run,started,pause,candidate,finish:()=>finish(),calls:()=>calls}
}
afterEach(async()=>{for(const {path,runtime} of contexts.splice(0)){await runtime.close();rmSync(path,{recursive:true,force:true})}})

describe('paused run revision API',()=>{
  it('requires the paused root to drain before preview or apply',async()=>{
    const test=setup();await test.started
    expect(()=>test.runtime.previewRunRevision(test.run.id,test.candidate())).toThrow('排空')
    await test.runtime.pause(test.run.id);expect(test.storage.run(test.run.id).status).toBe('pausing')
    expect(()=>test.runtime.previewRunRevision(test.run.id,test.candidate())).toThrow('排空')
    expect(()=>test.runtime.applyRunRevision(test.run.id,test.candidate(),'unconfirmed')).toThrow('排空')
    test.finish();expect((await test.runtime.settle(test.run.id)).status).toBe('paused');expect(test.runtime.previewRunRevision(test.run.id,test.candidate()).allowed).toBe(true)
  })
  it('retains the prior snapshot and usage, stays paused, and reuses completed model work only after explicit resume',async()=>{
    const test=setup(),before=await test.pause(),candidate=test.candidate(),storedDefinition=test.storage.get(test.saved.id)
    const preview=test.runtime.previewRunRevision(test.run.id,candidate)
    expect(preview).toMatchObject({allowed:true,baseRevision:1,targetRevision:2});expect(preview.items.find(item=>item.nodeId===before.graph.nodes[1]!.id)!.action).toBe('reuse')
    expect(test.storage.run(test.run.id)).toEqual(before)
    const revised=test.runtime.applyRunRevision(test.run.id,candidate,preview.planDigest)
    expect(revised.id).toBe(before.id);expect(revised.status).toBe('paused');expect(revised.activeRevision).toBe(2);expect(revised.inputs).toEqual(before.inputs);expect(revised.systemVariables).toEqual(before.systemVariables);expect(revised.usage).toEqual(before.usage);expect(revised.usage?.spentTokens).toBe(13)
    expect(revised.revisionHistory).toHaveLength(1);expect(revised.revisionHistory![0]!.graph).toEqual(before.graph);expect(revised.revisionHistory![0]!.executions).toEqual(before.executions);expect(revised.revisionHistory![0]!.snapshotDigest).toBe(before.snapshotDigest)
    expect(revised.executions.find(record=>record.nodeId===before.graph.nodes[1]!.id)).toMatchObject({status:'success',runRevision:1,reusedAtRevision:2})
    expect(test.storage.get(test.saved.id)).toEqual(storedDefinition);await Promise.resolve();expect(test.calls()).toBe(1);expect(test.storage.run(test.run.id).status).toBe('paused');expect(test.storage.run(test.run.id).outputs).toEqual({})
    test.runtime.resume(test.run.id);const done=await test.runtime.settle(test.run.id);expect(done.status).toBe('success');expect(done.outputs.result).toBe('revised completed result');expect(test.calls()).toBe(1);expect(done.usage).toEqual(before.usage)
  })
  it('does not replay an explicitly cached successful external action whose system identity stayed unchanged',async()=>{
    const test=setup('http'),before=await test.pause(),candidate=test.candidate(),preview=test.runtime.previewRunRevision(test.run.id,candidate)
    expect(preview.allowed).toBe(true);expect(preview.items.find(item=>item.nodeId===before.graph.nodes[1]!.id)!.action).toBe('reuse')
    test.runtime.applyRunRevision(test.run.id,candidate,preview.planDigest);test.runtime.resume(test.run.id);const done=await test.runtime.settle(test.run.id)
    expect(done.status).toBe('success');expect(test.calls()).toBe(1);expect(done.systemVariables).toEqual(before.systemVariables)
  })
  it('rejects invalid topology and fixed node changes without changing the paused snapshot',async()=>{
    const test=setup('llm',flow=>{flow.nodes[2]!.fixed=true}),before=await test.pause(),candidate=test.candidate()
    expect(()=>test.runtime.previewRunRevision(test.run.id,candidate)).toThrow('固定')
    const invalid=structuredClone(before.graph);invalid.nodes[1]!.config.prompt='updated';invalid.edges[0]!.source='missing-node'
    expect(()=>test.runtime.previewRunRevision(test.run.id,invalid)).toThrow()
    expect(test.storage.run(test.run.id)).toEqual(before)
  })
  it('invalidates the preview when the candidate or ledger changes before confirmation',async()=>{
    const test=setup(),before=await test.pause(),candidate=test.candidate(),preview=test.runtime.previewRunRevision(test.run.id,candidate),changed=structuredClone(candidate)
    changed.nodes[2]!.config.text='different confirmed text'
    expect(()=>test.runtime.applyRunRevision(test.run.id,changed,preview.planDigest)).toThrow('预览已变化')
    const updated=test.storage.run(test.run.id);updated.usage!.spentTokens+=25;test.storage.saveRun(updated)
    expect(()=>test.runtime.applyRunRevision(test.run.id,candidate,preview.planDigest)).toThrow('预览已变化')
    const after=test.storage.run(test.run.id);expect(after.graph).toEqual(before.graph);expect(after.activeRevision).toBe(1);expect(after.usage?.spentTokens).toBe(38)
  })
  it('ignores legacy budget changes while still refusing changed run inputs',async()=>{
    const test=setup(),before=await test.pause(),budget=test.candidate();budget.executionPolicy!.tokenBudget=1000
    expect(test.runtime.previewRunRevision(test.run.id,budget).allowed).toBe(true)
    const inputs=test.candidate();inputs.nodes[0]!.config.fields!.push({name:'newInput',label:'New input',required:false,defaultValue:'new value'})
    expect(()=>test.runtime.previewRunRevision(test.run.id,inputs)).toThrow('保留已有输入')
    expect(test.storage.run(test.run.id)).toEqual(before)
  })
  it('does not create revisions or context changes for absent, empty or retired-only execution policies',async()=>{
    const test=setup(),before=await test.pause()
    for(const policy of [undefined,{}, {tokenBudget:1,perTaskTokens:1,maxAgentTasks:1}]){
      const candidate=structuredClone(before.graph)
      if(policy===undefined)delete candidate.executionPolicy;else candidate.executionPolicy=policy
      const preview=test.runtime.previewRunRevision(test.run.id,candidate)
      expect(preview.allowed).toBe(false);expect(preview.blockedReasons).toContain('执行语义未变化；名称、布局或便签修改无需建立运行修订')
      expect(preview.changes).toEqual([])
    }
    expect(test.storage.run(test.run.id)).toEqual(before)
  })
  it('ignores retired estimate changes during confirmation but rejects changed safeguards',async()=>{
    const test=setup(),before=await test.pause(),candidate=test.candidate(),preview=test.runtime.previewRunRevision(test.run.id,candidate)
    const recorded=test.storage.run(test.run.id)
    recorded.usage!.limit=999;recorded.usage!.reservedTokens=888;recorded.usage!.unknownTokens=777
    for(const receipt of Object.values(recorded.usage!.allocations))receipt.tokens=666
    test.storage.saveRun(recorded)
    const different=structuredClone(candidate);different.executionPolicy!.maxConcurrentAgents=1
    expect(()=>test.runtime.applyRunRevision(test.run.id,different,preview.planDigest)).toThrow('预览已变化')
    const safetyPreview=test.runtime.previewRunRevision(test.run.id,different)
    expect(safetyPreview.changes.some(change=>change.nodeId==='$context')).toBe(true)
    expect(safetyPreview.planDigest).not.toBe(preview.planDigest)
    const applied=test.runtime.applyRunRevision(test.run.id,candidate,preview.planDigest)
    expect(applied.activeRevision).toBe(2);expect(applied.status).toBe('paused')
    expect(applied.usage).toEqual(recorded.usage)
  })
  it('rejects display-only changes as unnecessary revisions',async()=>{
    const test=setup(),before=await test.pause(),display=structuredClone(before.graph);display.title='Renamed only';display.nodes[1]!.x+=100;display.nodes[1]!.title='Display title';display.notes.push({id:'note',text:'Note only',x:0,y:0})
    const preview=test.runtime.previewRunRevision(test.run.id,display)
    expect(preview.allowed).toBe(false);expect(preview.blockedReasons.join(' ')).toContain('执行语义未变化');expect(()=>test.runtime.applyRunRevision(test.run.id,display,preview.planDigest)).toThrow('执行语义未变化');expect(test.storage.run(test.run.id)).toEqual(before)
  })
  it('refuses a revised action that would repeat a successful external side effect',async()=>{
    const test=setup('http'),before=await test.pause(),candidate=test.candidate();candidate.nodes[1]!.config.url='https://test.invalid/changed'
    const preview=test.runtime.previewRunRevision(test.run.id,candidate)
    expect(preview.allowed).toBe(false);expect(preview.items.find(item=>item.nodeId===before.graph.nodes[1]!.id)!.action).toBe('blocked')
    expect(()=>test.runtime.applyRunRevision(test.run.id,candidate,preview.planDigest)).toThrow('不能自动重放');expect(test.storage.run(test.run.id)).toEqual(before);expect(test.calls()).toBe(1)
  })
  it('refuses direct child revisions even when a persisted child appears paused',async()=>{
    const test=setup(),before=await test.pause();const child:WorkflowRun={...structuredClone(before),id:'nested-run',rootRunId:before.id};test.storage.saveRun(child)
    expect(()=>test.runtime.previewRunRevision(child.id,child.graph)).toThrow('根运行')
    expect(()=>test.runtime.previewRunRevision(before.id,test.candidate())).toThrow('子工作流')
    expect(test.storage.run(before.id)).toEqual(before)
  })
})
