import { afterEach,describe,expect,it,vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowPlanningService,type PlanningCaller } from '../src/host/planning/service.ts'
import { WorkflowTrialService } from '../src/host/planning/trial-service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const directories:string[]=[],services:{close():Promise<void>}[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'planning-admission-fault-'));directories.push(directory)
  const parent={id:'owner',session:{id:'owner'}} as Agent,caller:PlanningCaller={parent,sessionId:'owner',workspaceId:'workspace',signal:new AbortController().signal}
  const runtime={isLive:()=>true,withInitiator:async(_owner:Agent,operation:()=>Promise<unknown>)=>operation(),onDisposed:()=>()=>{}}
  const generate=vi.fn(async(input:any)=>{
    const result=input.compiler.submit({submission:{mode:'needs-input',summary:'Needs the human decision',questions:[{id:'format',question:'Choose a format',options:['Text','JSON']}]}})
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    return {output:result.value,steps:1}
  })
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,driver:{generate},admission:new ModelAdmission(2),backgroundRuntime:runtime,
    context:async request=>({...templateContext(),operation:request.operation}),authorize:()=>{},readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),publish:async()=>{throw Error('No publication allowed')},receipt:()=>undefined}
  const reopen=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service},service=reopen()
  const request={requestId:'admission-request',operation:'create' as const,instruction:'Ask before choosing the format',preview:true}
  const done=async(id:string)=>{await (service as any).active.get(id)?.done;return service.get(id,caller)}
  return {directory,parent,caller,runtime,generate,options,reopen,service,request,done}
}
describe('planning admission IO failure boundaries',()=>{
  it('rolls back an uncommitted acceptance so the same request can be admitted after storage recovers',async()=>{
    const f=fixture(),write=vi.spyOn((f.service as any).backgroundStore,'write').mockImplementationOnce(()=>{throw Error('background log unavailable')})
    await expect(f.service.start(f.request,f.caller,{background:true})).rejects.toThrow('background log unavailable')
    expect((f.service as any).tasks.size).toBe(0);expect((f.service as any).active.size).toBe(0);expect(f.generate).not.toHaveBeenCalled()
    write.mockRestore()
    const accepted=await f.service.start(f.request,f.caller,{background:true})
    expect(accepted.state).toBe('queued');expect((await f.done(accepted.id)).state).toBe('awaiting_input');expect(f.generate).toHaveBeenCalledOnce()
  })
  it('keeps a durable acceptance interrupted when the following task-journal write fails and never dispatches it',async()=>{
    const f=fixture();vi.spyOn((f.service as any).store,'write').mockImplementationOnce(()=>{throw Error('task journal unavailable')})
    const request={...f.request,preview:false},accepted=await f.service.start(request,f.caller,{background:true})
    expect(accepted.state).toBe('interrupted');expect(accepted.diagnostics.at(-1)!.code).toBe('PLANNING_ACCEPTANCE_FAILED')
    expect((f.service as any).active.size).toBe(0);expect(f.generate).not.toHaveBeenCalled()
    const duplicate=await f.service.start(request,f.caller,{background:true})
    expect(duplicate.id).toBe(accepted.id);expect(duplicate.state).toBe('interrupted')
    await f.service.close()
    expect(f.reopen().get(accepted.id,f.caller).state).toBe('interrupted')
    expect(f.generate).not.toHaveBeenCalled()
  })
  it('does not treat an error reported after the atomic identity write as permission to create a fresh task',async()=>{
    const f=fixture(),store=(f.service as any).backgroundStore,original=store.write.bind(store)
    vi.spyOn(store,'write').mockImplementationOnce((...args:unknown[])=>{original(...args);throw Error('error after commit')})
    const task=await f.service.start(f.request,f.caller,{background:true})
    expect(task.state).toBe('interrupted');expect(f.generate).not.toHaveBeenCalled()
    expect((await f.service.start(f.request,f.caller,{background:true})).id).toBe(task.id)
  })
  it.each(['backgroundStore','store'] as const)('keeps the original unanswered batch resumable after %s rejects continuation admission',async name=>{
    const f=fixture(),request={...f.request,preview:false},accepted=await f.service.start(request,f.caller,{background:true}),waiting=await f.done(accepted.id)
    expect(waiting.state).toBe('awaiting_input');expect(f.generate).toHaveBeenCalledOnce()
    // Both hot-path task events and continuation receipts are journaled.
    const write=vi.spyOn((f.service as any)[name],'append').mockImplementationOnce(()=>{throw Error('resume journal unavailable')})
    const rejected=await f.service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'Text'}],f.caller)
    expect(rejected.state).toBe('awaiting_input');expect(rejected.answers).toEqual([]);expect(rejected.answeredQuestions).toBeUndefined()
    expect(rejected.diagnostics.at(-1)!.code).toBe('PLANNING_RESUME_ACCEPTANCE_FAILED');expect((f.service as any).active.size).toBe(0)
    write.mockRestore()
    const continued=await f.service.answer(rejected.id,rejected.revision,[{questionId:'format',answer:'Text'}],f.caller)
    expect(continued.state).toBe('queued');expect(continued.answers).toEqual([{questionId:'format',answer:'Text'}])
    await f.done(continued.id);expect(f.generate).toHaveBeenCalledTimes(2)
  })
  it('does not start generation when a Host observer cancels synchronously at queued admission',async()=>{
    const f=fixture()
    f.options.onUpdate=task=>{if(task.state==='queued')void f.service.cancel(task.id,f.caller)}
    const task=await f.service.start(f.request,f.caller,{background:true})
    expect(task.state).toBe('cancelled');expect((f.service as any).active.size).toBe(0);expect(f.generate).not.toHaveBeenCalled()
  })
})

describe('trial admission never strands preparing work after a failed journal write',()=>{
  it.each(['before','after'] as const)('fails %s the atomic write without starting a business child',async when=>{
    const f=fixture(),run=vi.fn(async()=>{throw Error('No business execution allowed')})
    const options:ConstructorParameters<typeof WorkflowTrialService>[0]={directory:f.directory,admission:new ModelAdmission(2),backgroundRuntime:f.runtime,
      driver:{run,close:async()=>{}},resolve:async()=>({workspaceRoot:f.directory,model:{provider:'fixture',model:'never'},policyDigest:'a'.repeat(64)}),authorize:()=>{},plan:async()=>{throw Error('No planning allowed')}}
    const trial=new WorkflowTrialService(options);services.push(trial)
    const request={requestId:'trial-admission',instruction:'Only admit the explicit test task',spec:{task:'Write a local receipt only after actual execution starts',tools:['write'],inputs:[],artifacts:[{path:'receipt.json',format:'json',requireChanged:true,checks:[{kind:'json-type',pointer:'',value:'object'}]}],reviewItems:[]}}
    const store=(trial as any).store,original=store.write.bind(store)
    vi.spyOn(store,'write').mockImplementationOnce((...args:unknown[])=>{if(when==='after')original(...args);throw Error('trial journal unavailable')})
    if(when==='before'){
      await expect(trial.start(request,f.caller,{background:true})).rejects.toThrow('trial journal unavailable')
      expect((trial as any).records.size).toBe(0)
    }else{
      const task=await trial.start(request,f.caller,{background:true})
      expect(task.state).toBe('interrupted');expect(task.diagnostics.at(-1)!.code).toBe('TRIAL_ACCEPTANCE_FAILED')
      expect((await trial.start(request,f.caller,{background:true})).id).toBe(task.id)
    }
    expect((trial as any).active.size).toBe(0);expect(run).not.toHaveBeenCalled()
  })
})


describe('background acceptance receipt journal',()=>{
  it('does not rewrite earlier receipts, recovers every accepted identity and never replays work',async()=>{
    const f=fixture(),first=await f.service.start(f.request,f.caller,{background:true});await f.done(first.id)
    const {readFileSync}=await import('node:fs'),snapshot=readFileSync(join(f.directory,'planning','background.json'),'utf8')
    const writes=vi.spyOn((f.service as any).backgroundStore,'write')
    const second=await f.service.start({...f.request,requestId:'second-request'},f.caller,{background:true});await f.done(second.id)
    expect(writes).not.toHaveBeenCalled();expect(readFileSync(join(f.directory,'planning','background.json'),'utf8')).toBe(snapshot)
    expect(readFileSync(join(f.directory,'planning','background.journal'),'utf8')).toContain(second.id)
    await f.service.close();const restored=f.reopen()
    expect(restored.get(first.id,f.caller).state).toBe('interrupted');expect(restored.get(second.id,f.caller).state).toBe('interrupted')
    expect((await restored.start({...f.request,requestId:'second-request'},f.caller,{background:true})).id).toBe(second.id)
    expect(f.generate).toHaveBeenCalledTimes(2)
  })
  it('never dispatches a second identity if its append fails before durability',async()=>{
    const f=fixture(),first=await f.service.start(f.request,f.caller,{background:true});await f.done(first.id)
    vi.spyOn((f.service as any).backgroundStore,'append').mockImplementationOnce(()=>{throw Error('append unavailable')})
    await expect(f.service.start({...f.request,requestId:'second-request'},f.caller,{background:true})).rejects.toThrow('append unavailable')
    expect(f.generate).toHaveBeenCalledOnce()
  })
})
