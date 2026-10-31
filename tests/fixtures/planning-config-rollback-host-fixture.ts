import {moduleCheck} from './planning-module-check.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import type { PlanningTask } from '../../src/host/planning/service.ts'
import { filling } from './planning-compiler/template.ts'

type Mode='template-fill'|'compact-repair'|'legacy'
const scenario=process.argv[2],directory=mkdtempSync(join(tmpdir(),'planning-config-rollback-'))
let driverCalls=0,externalCalls=0,businessCalls=0,agentStarts=0,publications=0
const actions=()=>({driverCalls,externalCalls,businessCalls,agentStarts,publications})
const file=join(directory,'planning','tasks.json'),journal=join(directory,'planning','tasks.journal')
const snapshot=()=>new Map([file,journal].map(path=>[path,existsSync(path)?readFileSync(path):undefined]))
const restore=(files:ReturnType<typeof snapshot>)=>{for(const [path,bytes] of files)if(bytes)writeFileSync(path,bytes);else rmSync(path,{force:true})}
const question={submission:{mode:'needs-input',summary:'需要确认问候语',questions:[{id:'greeting',question:'使用哪种问候语？',options:['你好','Hello']}]}}
const request=(id:string)=>({requestId:id,operation:'create',moduleCheck,instruction:`${id}：根据输入姓名生成问候语`,execution:{mode:'design-only'}})
function wire(input:PlanningAgentInput){
  const value=filling()
  if(!input.templateQuery){const {forms,...rest}=value.submission;value.submission={...rest,nodes:forms.map(({key,template,values}:any)=>({key,kind:template,config:values}))}}
  return value
}
function frozen(task:PlanningTask){
  const {id,request,requestDigest,workspaceId,sessionId,childId,compilerMode,compilerSelection,templateBinding,compilerDraft,candidate,candidateDigest,commit,receipt}=task
  const draft=compilerDraft?(({format,purpose,baseDigest,revision,document,issues})=>({format,purpose,baseDigest,revision,document,issues}))(compilerDraft):undefined
  return {id,request,requestDigest,workspaceId,sessionId,childId,compilerMode,compilerSelection,templateBinding,draft,candidate,candidateDigest,commit,receipt}
}
async function harness(mode:Mode,rejectedField?:string){
  const ctx=new Context(),definitions=new Map<string,any>()
  const main:any={id:'main',ctx,session:{id:'main',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}}
  const provisions=[
    ctx.provide('agents',{get:(id:string)=>id==='main'?main:undefined,list:()=>[main],roots:()=>[main],withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation(),create:()=>{agentStarts++;throw Error('Unexpected native Agent start')}}),
    ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'T11 offline',path:directory,sessionIds:['main']}]}),
    ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){externalCalls++;throw Error('External models forbidden')}}),
    ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>definitions.delete(definition.name)},schemas:()=>[],execute:()=>{businessCalls++;throw Error('Business tools forbidden')}}),
    ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
  ]
  let fiber:any
  const close=async()=>{await fiber?.dispose();for(const dispose of provisions.reverse())await dispose()}
  if(rejectedField){
    try{await assert.rejects(async()=>{fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:mode});await fiber},error=>error instanceof Error&&error.message.includes(rejectedField)&&error.message.includes('protocolVersion'))}finally{await close()}
    return undefined!
  }
  fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:mode});await fiber
  assert.equal(fiber.state,2)
  const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner,storage=(service as any).storage
  assert.equal(planner.active.size,0);assert.equal(storage.runs().length,0)
  const publish=planner.options.publish
  planner.options.publish=async(...args:any[])=>{publications++;return publish(...args)}
  let behavior:'candidate'|'clarify'|'draft'='candidate',entered:()=>void=()=>{}
  planner.options.driver.generate=async(input:PlanningAgentInput)=>{
    driverCalls++;input.onTask?.(`offline-child-${driverCalls}`);input.beforeStep?.(120,undefined);input.beforeSubmission?.()
    const value=behavior==='clarify'?question:wire(input)
    if(behavior==='draft')value.submission.title=42
    const compiled=input.compiler.submit(value)
    if(behavior==='draft'){
      assert.equal(compiled.ok,false);assert.ok(input.compiler.snapshot().document);entered()
      return new Promise<never>((_,reject)=>{const abort=()=>reject(input.signal.reason);input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort()})
    }
    assert.equal(compiled.ok,true,JSON.stringify(compiled));if(!compiled.ok)throw Error('Compilation failed')
    return {output:compiled.value,steps:1,usage:{totalTokens:7}}
  }
  const tool=async(name:string,args:unknown)=>JSON.parse(await definitions.get(name).execute(args,{agent:main,signal:new AbortController().signal}))
  const get=(id:string)=>tool('visible_workflow_plan_get',{task_id:id,include_candidates:true})
  const accepted=(id:string)=>tool('visible_workflow_plan',{request_json:JSON.stringify(request(id))})
  const settle=async(view:any)=>{await planner.active.get(view.taskId)?.done;return get(view.taskId)}
  const plan=async(id:string)=>settle(await accepted(id))
  const task=(id:string):PlanningTask=>planner.get(id,{parent:main,sessionId:'main',workspaceId:'workspace',signal:new AbortController().signal})
  const flows=async()=>JSON.parse(await service.list('workspace')).workflows
  return {service,planner,storage,tool,get,accepted,settle,plan,task,flows,close,setBehavior:(next:typeof behavior)=>{behavior=next},draftStarted:()=>new Promise<void>(resolve=>{entered=resolve})}
}

let host:Awaited<ReturnType<typeof harness>>|undefined
try{
  if(scenario==='legacy-config'){
    host=await harness('legacy')
    const view=await host.plan('legacy-config'),task=host.task(view.taskId)
    assert.equal(view.state,'published');assert.equal(task.compilerMode,'compact-repair')
    assert.deepEqual(view.compilerSelection,{protocolVersion:1,state:'frozen',requestedMode:'legacy',effectiveMode:'compact-repair',reason:'legacy-retired',nodeIds:[]})
    console.log(JSON.stringify({ok:true,scenario,legacyConfigMapped:true,externalCalls,businessCalls}))
  }else if(scenario==='legacy-task'){
    host=await harness('compact-repair')
    const old=await host.plan('legacy-task');assert.equal(old.state,'published',JSON.stringify(old))
    const original={...frozen(host.task(old.taskId)),compilerMode:undefined,draft:undefined};await host.close();host=undefined
    const raw=JSON.parse(readFileSync(file,'utf8'));delete raw.tasks[0].engineVersion;delete raw.tasks[0].compilerMode;delete raw.tasks[0].compilerDraft;delete raw.tasks[0].compilerSelection;delete raw.tasks[0].compilerMetrics;delete raw.tasks[0].designChecks;delete raw.tasks[0].workspaceSnapshot
    writeFileSync(file,JSON.stringify(raw));const historical=readFileSync(file,'utf8'),before=actions()
    for(const mode of ['template-fill','compact-repair'] as const){
      host=await harness(mode);assert.deepEqual(actions(),before)
      const task=host.task(old.taskId);assert.equal(task.engineVersion,'0.0.1');assert.equal(task.compilerSelection,undefined);assert.equal(task.compilerMode,undefined);assert.equal(task.designChecks,undefined);assert.equal(task.workspaceSnapshot,undefined);assert.equal((await host.get(old.taskId)).receipt.verification,undefined)
      assert.deepEqual(frozen(task),{...original,compilerSelection:undefined});assert.equal((await host.plan('legacy-task')).taskId,old.taskId)
      assert.deepEqual(actions(),before);assert.equal(readFileSync(file,'utf8'),historical);await host.close();host=undefined
    }
    host=await harness('template-fill');const modern=await host.plan('modern-task');assert.equal(modern.state,'published')
    await host.close();host=undefined
    const compatible=JSON.parse(readFileSync(file,'utf8'))
    for(const field of ['compilerSelection','templateBinding']){
      const future=structuredClone(compatible),task=future.tasks.find((row:any)=>row.id===modern.taskId)
      assert.equal(task[field].protocolVersion,1);task[field].protocolVersion=999
      writeFileSync(file,JSON.stringify(future));const bytes=readFileSync(file,'utf8'),before=actions()
      await harness('compact-repair',field);assert.deepEqual(actions(),before);assert.equal(readFileSync(file,'utf8'),bytes)
    }
    writeFileSync(file,JSON.stringify(compatible));host=await harness('compact-repair');assert.equal((await host.get(modern.taskId)).state,'published')
    console.log(JSON.stringify({ok:true,scenario,legacyReadable:true,futureProtocolsRejected:2,externalCalls,businessCalls}))
  }else{
    assert.ok(scenario==='template-fill'||scenario==='compact-repair')
    const initial=scenario,switched=initial==='template-fill'?'compact-repair':'template-fill'
    host=await harness(initial)
    const published=await host.plan('original-receipt');assert.equal(published.state,'published',JSON.stringify(published))
    host.setBehavior('clarify');const waiting=await host.plan('original-clarification');assert.equal(waiting.state,'awaiting_input',JSON.stringify(waiting))
    host.setBehavior('draft');const entered=host.draftStarted(),draft=await host.accepted('original-draft');await entered
    const originals=[published,waiting,draft].map(view=>host!.task(view.taskId))
    assert.equal(originals[2].state,'repairing');assert.ok(originals[2].compilerDraft)
    for(const task of originals)assert.equal(task.compilerMode,initial)
    // Capture actual in-flight files, then discard graceful-close changes to rehearse a crash image.
    const crash=snapshot(),oldPlanner=host.planner,oldStorage=host.storage
    await host.close();host=undefined;restore(crash)
    const before=actions();host=await harness(switched)
    assert.notEqual(host.planner,oldPlanner);assert.notEqual(host.storage,oldStorage);assert.deepEqual(actions(),before)
    for(const task of originals)assert.deepEqual(frozen(host.task(task.id)),frozen(task))
    assert.equal(host.task(draft.taskId).state,'interrupted');assert.equal(host.task(waiting.taskId).state,'awaiting_input');assert.equal(host.task(published.taskId).state,'published')
    for(const view of [published,waiting,draft])assert.equal((await host.plan(host.task(view.taskId).request.requestId)).taskId,view.taskId)
    assert.deepEqual(actions(),before);assert.equal((await host.flows()).length,1)
    const changed=await host.plan('changed-default');assert.equal(changed.state,'published',JSON.stringify(changed));assert.equal(host.task(changed.taskId).compilerMode,switched)
    host.setBehavior('clarify');const changedWaiting=await host.plan('changed-clarification');assert.equal(changedWaiting.state,'awaiting_input')
    const retained=[...originals,host.task(changed.taskId),host.task(changedWaiting.taskId)].map(task=>frozen(host!.task(task.id)))
    await host.close();host=undefined;const beforeBack=actions();host=await harness(initial);assert.deepEqual(actions(),beforeBack)
    for(const task of retained)assert.deepEqual(frozen(host.task(task.id)),task)
    const back=await host.plan('restored-default');assert.equal(back.state,'published');assert.equal(host.task(back.taskId).compilerMode,initial)
    for(const view of [waiting,changedWaiting]){
      const original=host.task(view.taskId),result=await host.settle(await host.tool('visible_workflow_plan_answer',{task_id:original.id,revision:original.revision,answers_json:JSON.stringify([{questionId:'greeting',answer:'你好'}])}))
      assert.equal(result.state,'published',JSON.stringify(result));const resumed=host.task(original.id)
      for(const key of ['id','requestDigest','workspaceId','sessionId','compilerMode','compilerSelection','templateBinding'] as const)assert.deepEqual(resumed[key],original[key])
    }
    const dedupe=actions(),count=(await host.flows()).length;assert.equal(count,5)
    for(const view of [published,waiting,draft,changed,changedWaiting,back]){
      const original=host.task(view.taskId),duplicate=await host.plan(original.request.requestId)
      assert.equal(duplicate.taskId,original.id);assert.deepEqual(frozen(host.task(original.id)),frozen(original))
      if(original.receipt){
        const repeated=await host.tool('visible_workflow_plan_publish',{task_id:original.id,revision:original.revision,candidate_digest:original.candidateDigest})
        assert.equal(repeated.state,'published');assert.equal(repeated.taskId,original.id);assert.equal(repeated.candidateDigest,original.candidateDigest);const {verification,...storedReceipt}=repeated.receipt;assert.deepEqual(storedReceipt,original.receipt);assert.deepEqual(verification,(await host.get(original.id)).receipt.verification)
        assert.deepEqual(frozen(host.task(original.id)),frozen(original))
        assert.deepEqual(host.storage.planningReceipt(original.commit!.key),original.receipt)
      }
    }
    assert.deepEqual(actions(),dedupe);assert.equal((await host.flows()).length,count)
    await host.close();host=undefined;const final=actions();host=await harness(initial);assert.deepEqual(actions(),final)
    assert.equal((await host.flows()).length,count);assert.equal(host.task(draft.taskId).state,'interrupted')
    assert.equal(externalCalls,0);assert.equal(businessCalls,0);assert.equal(agentStarts,0)
    console.log(JSON.stringify({ok:true,scenario,switches:2,reloadedWithoutActions:true,duplicateWithoutWork:true,clarificationsResumed:true,externalCalls,businessCalls}))
  }
}finally{await host?.close();rmSync(directory,{recursive:true,force:true})}
