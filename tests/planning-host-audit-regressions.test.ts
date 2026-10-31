import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeWorkflow } from '../src/shared/types.ts'
import type { PlanningContext, PlannerOutput, PlanningRequest } from '../src/shared/planning-types.ts'
import type { ConversationEvidence, TaskProcedure } from '../src/shared/retrospective.ts'
import { WorkflowPlanningService, type PlanningCaller } from '../src/host/planning/service.ts'
import type { PlanningAgentInput, PlanningAgentResult } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { PlanningStore } from '../src/host/planning/store.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './fixtures/planning-edits.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const request=(changes:Partial<PlanningRequest>={}):PlanningRequest=>({requestId:'audit-request',operation:'create',instruction:'输入文字并输出结果',...changes})
function candidate(input:PlanningAgentInput):PlannerOutput{
  const graph=fixturePlanningPrompt(input).graph
  return {outcome:'candidate',graphJson:JSON.stringify(graph),summary:'定义已生成',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:graph.nodes.map((node:{id:string})=>node.id),note:'覆盖'}]}
}
function evidence():ConversationEvidence{
  const value:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'parent-session',fromSeq:1,throughSeq:2,records:[{id:'e1',seq:1,kind:'user',text:'将报销明细按支付日期汇总',status:'statement',truncated:false},{id:'e2',seq:2,kind:'assistant',text:'已生成本次汇总',status:'statement',truncated:false}],warnings:[]}
  return {...value,digest:conversationEvidenceDigest(value)}
}
const procedure=():TaskProcedure=>({goal:'汇总报销',parameters:[{name:'month',description:'本次月份'}],rules:['使用支付日期'],steps:[{id:'S1',title:'汇总',instruction:'按支付日期汇总本次输入',dependsOn:[],evidenceRefs:['e1','e2'],requiresReview:false}],excluded:[],reviewItems:[]})
const wire=()=>({submission:{mode:'create',title:'编译测试',nodes:[{key:'start',kind:'input',config:{fields:[{name:'text',label:'文本',required:true}]}},{key:'result',kind:'output',config:{text:'{{input.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result'],S1:['result']} as Record<string,string[]>}})
function fixture(config:{run?:(input:PlanningAgentInput,attempt:number)=>Promise<PlanningAgentResult>;conversation?:ConversationEvidence}={}){
  const directory=mkdtempSync(join(tmpdir(),'planning-host-audit-'));directories.push(directory)
  const receipts=new Map<string,PlanningReceipt>(),parent={id:'parent-session'} as Agent
  const caller:PlanningCaller={parent,sessionId:'parent-session',workspaceId:'workspace',signal:new AbortController().signal}
  const baseline=makeWorkflow(caller.workspaceId)
  let attempts=0
  const generate=vi.fn(async(input:PlanningAgentInput)=>{
    attempts++;input.onTask?.(`child-${attempts}`)
    if(config.run){const result=await config.run(input,attempts);return result}
    input.beforeStep?.(20,undefined)
    return {output:fixturePlanningEdits(input,candidate(input)),steps:1,usage:{totalTokens:25}}
  })
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={
    directory,driver:{generate},admission:new ModelAdmission(2,2),
    context:async(req):Promise<PlanningContext>=>({workflow:structuredClone(baseline),operation:req.operation,targetNodeIds:[],nodeIds:['new-node'],subagentIds:[],environmentIds:[],tools:[],model:{provider:'test',model:'fake'},effort:'high',...(config.conversation?{conversation:config.conversation}:{})}),
    authorize:()=>{},
    readiness:vi.fn(async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]})),
    publish:vi.fn(async(flow,task,_owner,commit)=>{receipts.set(commit.key,{...commit,workflowId:flow.id,revision:1,kind:task.request.operation==='create'?'created':'proposed'})}),
    receipt:key=>receipts.get(key),
  }
  const open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  return {service:open(),open,options,caller,generate,directory,file:join(directory,'planning','tasks.json'),journal:join(directory,'planning','tasks.journal')}
}
const untilAbort=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})

describe('P1 cancel aborts even when the journal cannot be written',()=>{
  it('aborts the child when every journal write fails and reports the failure separately',async()=>{
    let entered!:()=>void,childSignal!:AbortSignal
    const started=new Promise<void>(resolve=>{entered=resolve})
    const f=fixture({run:async input=>{childSignal=input.signal;entered();return untilAbort(input.signal)}})
    const pending=f.service.start(request(),f.caller);pending.catch(()=>{})
    await started
    const id=f.service.findRequest('audit-request',f.caller)!.id,store=(f.service as any).store as PlanningStore<never>
    vi.spyOn(store,'append').mockImplementation(()=>{throw Error('ENOSPC: disk full')})
    vi.spyOn(store,'write').mockImplementation(()=>{throw Error('规划记录超过容量')})
    const cancelled=await f.service.cancel(id,f.caller)
    expect(childSignal.aborted).toBe(true);expect(f.service.isActive(id,f.caller)).toBe(false)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.diagnostics.some(item=>item.code==='PLANNING_CANCEL_JOURNAL_FAILED'&&/ENOSPC|容量/.test(item.message))).toBe(true)
    expect(f.generate).toHaveBeenCalledOnce()
  })
  it('persists the final cancelled state when only the cancelling event fails',async()=>{
    let entered!:()=>void,childSignal!:AbortSignal
    const started=new Promise<void>(resolve=>{entered=resolve})
    const f=fixture({run:async input=>{childSignal=input.signal;entered();return untilAbort(input.signal)}})
    const pending=f.service.start(request(),f.caller);pending.catch(()=>{})
    await started
    const id=f.service.findRequest('audit-request',f.caller)!.id,store=(f.service as any).store as PlanningStore<never>
    vi.spyOn(store,'append').mockImplementationOnce(()=>{throw Error('ENOSPC: disk full')})
    const cancelled=await f.service.cancel(id,f.caller)
    expect(childSignal.aborted).toBe(true);expect(cancelled.state).toBe('cancelled')
    await f.service.close()
    const restored=f.open().get(id,f.caller)
    expect(restored.state).toBe('cancelled');expect(restored.diagnostics.map(item=>item.code)).toContain('PLANNING_CANCEL_JOURNAL_FAILED')
    expect(f.generate).toHaveBeenCalledOnce()
  })
})

describe('distillation clarification resumes the Host checkpoint',()=>{
  const invalid=()=>{const value=procedure();value.steps[0]!.evidenceRefs=['missing-event'];return {submission:{mode:'distill',procedure:value}}}
  const clarify={submission:{mode:'needs-input',summary:'需要确认月份口径',questions:[{id:'month',question:'按哪个月份汇总？',options:['支付月份','报销月份']}]}}
  function clarified(second:(input:PlanningAgentInput)=>Promise<PlanningAgentResult>){
    const f=fixture({conversation:evidence(),run:async(input,attempt)=>{
      input.beforeStep?.(100,undefined)
      if(attempt===1){
        const first=input.compiler!.submit(invalid());if(first.ok)throw Error('expected invalid draft')
        const paused=input.compiler!.submit(clarify);if(!paused.ok)throw Error(JSON.stringify(paused.feedback))
        return {output:paused.value,steps:1,usage:{totalTokens:10}}
      }
      if(input.purpose==='distill')return second(input)
      const authored=input.compiler!.submit(wire());if(!authored.ok)throw Error(JSON.stringify(authored.feedback))
      return {output:authored.value,steps:1,usage:{totalTokens:10}}
    }})
    f.options.compilerMode='compact-repair'
    return f
  }
  it('keeps the failed draft and repair scope after a human answer and accepts only a local repair',async()=>{
    let resumed:any
    const f=clarified(async input=>{
      resumed=JSON.parse(input.prompt)
      const schema=JSON.stringify(input.compiler!.nextSchema)
      expect(schema).not.toContain('"const":"distill"')
      const repaired=input.compiler!.submit({submission:{mode:'repair',draftRevision:resumed.continuation.draftRevision,patches:[{op:'replace',path:'/procedure/steps/0/evidenceRefs',value:['e1','e2']}]}})
      if(!repaired.ok)throw Error(JSON.stringify(repaired.feedback))
      return {output:repaired.value,steps:1,usage:{totalTokens:10}}
    })
    f.service=f.open()
    const waiting=await f.service.start(request({preview:true,source:{kind:'current-conversation',fromSeq:1,throughSeq:2}}),f.caller)
    expect(waiting.state).toBe('awaiting_input');expect(waiting.distillationAttempts).toBe(1)
    expect(waiting.compilerDraft).toMatchObject({purpose:'distill',checkpoint:{state:'clarification'}})
    const done=await f.service.answer(waiting.id,waiting.revision,[{questionId:'month',answer:'支付月份'}],f.caller)
    expect(resumed.continuation).toMatchObject({kind:'draft-repair',hasDraft:true})
    expect(resumed.continuation.unresolved).toContain('/procedure/steps/0/evidenceRefs')
    expect(resumed.answers).toEqual([{questionId:'month',answer:'支付月份'}])
    expect(done.state,JSON.stringify(done.diagnostics)).toBe('ready')
    expect(done.distillationAttempts).toBe(2);expect(done.procedure?.steps[0]?.evidenceRefs).toEqual(['e1','e2'])
  })
  it('rejects a full procedure rewrite after the clarification instead of reopening the draft',async()=>{
    let outcome=''
    const f=clarified(async input=>{
      // The restored draft only admits repair patches; a complete resubmission
      // is refused (the unchanged failing draft is reported as stalled).
      try{const rewrite=input.compiler!.submit({submission:{mode:'distill',procedure:procedure()}});outcome=rewrite.ok?'accepted':rewrite.feedback.issues.map(issue=>issue.code).join(',')}
      catch(error){outcome=(error as {code?:string}).code??'thrown';throw error}
      throw Object.assign(Error('stop after rejected rewrite'),{code:'PLANNING_TEST_STOP'})
    })
    f.service=f.open()
    const waiting=await f.service.start(request({preview:true,source:{kind:'current-conversation',fromSeq:1,throughSeq:2}}),f.caller)
    const failed=await f.service.answer(waiting.id,waiting.revision,[{questionId:'month',answer:'支付月份'}],f.caller)
    expect(outcome).not.toBe('accepted');expect(outcome).toMatch(/PATCH_REQUIRED|PLANNING_REPAIR_STALLED/)
    expect(failed.state).toBe('failed');expect(failed.procedure).toBeUndefined()
  })
})

describe('planning journal persists one changed task per event',()=>{
  it('journals hot-path events without rewriting the snapshot and compacts at a resting state',async()=>{
    let checked=false
    const f=fixture({run:async input=>{
      const before=statSync(f.file).mtimeMs,snapshot=readFileSync(f.file,'utf8')
      input.beforeStep?.(100,undefined)
      input.onUsage?.({sequence:1,turn:1,step:1,usage:{totalTokens:7}})
      // Hot-path step/usage events append rows; the snapshot file is untouched.
      expect(readFileSync(f.file,'utf8')).toBe(snapshot);expect(statSync(f.file).mtimeMs).toBe(before)
      const lines=readFileSync(f.journal,'utf8').trim().split('\n')
      expect(JSON.parse(lines[0]!)).toEqual({generation:JSON.parse(snapshot).journal})
      expect(lines.slice(1).every(line=>JSON.parse(line).id===JSON.parse(lines.at(-1)!).id)).toBe(true)
      // A restart would see the journaled usage even though the snapshot is older.
      expect(new PlanningStore(f.directory).readRaw().tasks.find((task:any)=>task.spentTokens===7)).toBeDefined()
      checked=true
      return {output:fixturePlanningEdits(input,candidate(input)),steps:1}
    }})
    const task=await f.service.start(request(),f.caller)
    expect(checked).toBe(true);expect(task.state).toBe('published')
    expect(existsSync(f.journal)).toBe(false)
    expect(JSON.parse(readFileSync(f.file,'utf8')).tasks[0]).toMatchObject({id:task.id,state:'published',spentTokens:7})
  })
  it('replays the journal on restart, ignores a torn final line and rejects a corrupt committed row',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-store-'));directories.push(directory)
    const store=new PlanningStore<{id:string;preview:boolean;value:number}>(directory)
    const rows=[{id:'a',preview:false,value:1},{id:'b',preview:false,value:1}]
    store.append(rows[0]!,()=>rows)
    rows[0]!.value=2;store.append(rows[0]!,()=>rows)
    rows[1]!.value=3;store.append(rows[1]!,()=>rows)
    const file=join(directory,'planning','tasks.json'),journal=join(directory,'planning','tasks.journal')
    expect(JSON.parse(readFileSync(file,'utf8')).tasks.map((row:any)=>row.value)).toEqual([1,1])
    const read=()=>new PlanningStore<{id:string;preview:boolean;value:number}>(directory).read(value=>value as any)
    expect(read().map(row=>row.value)).toEqual([2,3])
    appendFileSync(journal,'{"id":"a","preview":false,"val')
    expect(read().map(row=>row.value)).toEqual([2,3])
    writeFileSync(journal,readFileSync(journal,'utf8').replace(/\{"id":"a","preview":false,"val$/,'')+'not-json\n{"id":"a","preview":false,"value":9}\n')
    expect(read).toThrow()
  })
  it('ignores a journal from an older generation after compaction and keeps legacy snapshots readable',()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-store-'));directories.push(directory)
    const file=join(directory,'planning','tasks.json'),journal=join(directory,'planning','tasks.journal')
    const store=new PlanningStore<{id:string;preview:boolean;value:number}>(directory),rows=[{id:'a',preview:false,value:1}]
    store.append(rows[0]!,()=>rows);rows[0]!.value=2;store.append(rows[0]!,()=>rows)
    const stale=readFileSync(journal,'utf8')
    rows[0]!.value=5;store.write(rows)
    // Simulate a crash after the snapshot rename but before the old journal was removed.
    writeFileSync(journal,stale)
    expect(new PlanningStore(directory).read(value=>value as any).map((row:any)=>row.value)).toEqual([5])
    // A historical snapshot without a generation never replays any journal.
    writeFileSync(file,JSON.stringify({version:1,tasks:[{id:'a',preview:false,value:7}]}))
    expect(new PlanningStore(directory).read(value=>value as any).map((row:any)=>row.value)).toEqual([7])
  })
  it('skips preview rows entirely',()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-store-'));directories.push(directory)
    const store=new PlanningStore<{id:string;preview:boolean}>(directory)
    store.append({id:'p',preview:true},()=>[{id:'p',preview:true}])
    expect(existsSync(join(directory,'planning','tasks.json'))).toBe(false)
  })
})

describe('P3 planning stage spans',()=>{
  it('records independent spans for validation, readiness, optimization, publication and persistence',async()=>{
    const f=fixture()
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('published')
    const phases=task.compilerMetrics?.map(metric=>metric.phase)??[]
    for(const phase of ['span:final-validation','span:provenance-validation','span:readiness','span:optimization','span:optimization-validation','span:publish-readiness','span:publish','span:persist'])expect(phases).toContain(phase)
    for(const metric of task.compilerMetrics!.filter(metric=>metric.phase.startsWith('span:'))){
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);expect(metric.status).toBe('success')
    }
    expect(task.compilerMetrics!.find(metric=>metric.phase==='span:persist')!.count).toBeGreaterThan(0)
  })
  it('marks a failing readiness span as failed',async()=>{
    const f=fixture();(f.options.readiness as any).mockRejectedValueOnce(Error('catalog offline'))
    const task=await f.service.start(request(),f.caller)
    expect(task.state).toBe('failed')
    expect(task.compilerMetrics?.find(metric=>metric.phase==='span:readiness')).toMatchObject({status:'failed'})
  })
})
