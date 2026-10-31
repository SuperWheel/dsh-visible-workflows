import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {WorkflowPlanningService,type PlanningCaller,type PlanningTask} from '../src/host/planning/service.ts'
import {PlanningStore} from '../src/host/planning/store.ts'
import {workspaceChangeVerification} from '../src/host/planning/command-brief.ts'
import {businessModuleCatalog} from '../src/shared/planning-business-modules.ts'
import {ModelAdmission} from '../src/host/run-usage.ts'
import type {PlanningReceipt} from '../src/host/planning/receipt.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools} from './fixtures/t18-tools.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'planning-workspace-changes-'));directories.push(directory)
  const caller:PlanningCaller={parent:{id:'owner'} as Agent,sessionId:'owner',workspaceId:'workspace',signal:new AbortController().signal}
  const receipts=new Map<string,PlanningReceipt>(),revisions:Record<string,number>={existing:2,archived:4}
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,compilerMode:'compact-repair',admission:new ModelAdmission(2),
    driver:{generate:vi.fn(async input=>{
      input.beforeStep?.(100,undefined);input.beforeSubmission?.()
      const compiled=input.compiler!.submit({submission:{mode:'create',title:'设计结果',nodes:[{key:'start',kind:'input',config:{fields:[]}},{key:'text',kind:'template',config:{text:'正文'}},{key:'end',kind:'output',config:{text:'{{text.text}}'}}],chains:[{key:'main',nodes:['start','text','end']}],coverage:{R1:['text','end']}}})
      if(!compiled.ok)throw Error(JSON.stringify(compiled.feedback))
      return {output:compiled.value,steps:1,usage:{totalTokens:1}}
    })},
    context:async()=>({...templateContext(),tools:tools()}),authorize:()=>{},
    readiness:async candidate=>({workflowId:candidate.id,revision:candidate.revision,canRun:true,issues:[]}),
    workspaceRevisions:vi.fn(()=>revisions),
    publish:async(candidate,_task,_caller,commit)=>{revisions[candidate.id]=1;receipts.set(commit.key,{...commit,kind:'created',workflowId:candidate.id,revision:1})},
    receipt:key=>receipts.get(key),
  }
  const open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  return {caller,options,revisions,open,directory}
}

describe('T23 workspace change receipt endpoints',()=>{
  it.each(['design',...businessModuleCatalog().map(module=>module.id)])('freezes acceptance and publication for %s, preserving receipt shape and restart bytes',async route=>{
    const f=fixture(),service=f.open(),module=businessModuleCatalog().find(row=>row.id===route)
    const request={requestId:'snapshot',operation:'create',instruction:'只设计所需工作流',preview:true,...(module?{handoff:{version:1,mode:'module',module:{moduleId:module.id,version:module.version,instanceKey:'example',parameters:module.parameterExample}}}:{})}
    const ready=await service.start(request,f.caller)
    expect(ready.state).toBe('ready')
    expect(f.options.driver.generate).toHaveBeenCalledTimes(module?0:1)
    expect(ready.workspaceSnapshot).toEqual({accepted:{existing:2,archived:4}})
    expect(workspaceChangeVerification(ready)).toBeUndefined()
    f.revisions.existing=3;f.revisions.added=1
    const duplicate=await service.start(request,f.caller)
    expect(duplicate.id).toBe(ready.id)
    expect(f.options.workspaceRevisions).toHaveBeenCalledTimes(1)
    expect(duplicate.workspaceSnapshot).toEqual(ready.workspaceSnapshot)
    const published=await service.publish(ready.id,ready.revision,ready.candidateDigest!,f.caller)
    expect(published.state).toBe('published')
    const comparison=workspaceChangeVerification(published)!
    expect(comparison.taskWorkflow).toEqual({workflowId:published.receipt!.workflowId,action:'created',revision:1})
    expect(comparison.otherWorkflows).toEqual([
      {workflowId:'added',acceptedRevision:null,publishedRevision:1,unchanged:false},
      {workflowId:'archived',acceptedRevision:4,publishedRevision:4,unchanged:true},
      {workflowId:'existing',acceptedRevision:2,publishedRevision:3,unchanged:false},
    ])
    expect(comparison.changedWorkflowIds).toEqual(['added','existing'])
    expect(comparison.source).toContain('不归因于本任务')
    expect(comparison.existingWorkflowsUnchanged).toBe(false)
    expect(published.receipt).not.toHaveProperty('verification')
    f.revisions.existing=9;delete f.revisions.archived
    expect(workspaceChangeVerification(service.get(ready.id,f.caller))).toEqual(comparison)
    await service.close()
    const path=join(f.directory,'planning/tasks.json'),before=readFileSync(path,'utf8'),reopened=f.open()
    expect(workspaceChangeVerification(reopened.get(ready.id,f.caller))).toEqual(comparison)
    expect(readFileSync(path,'utf8')).toBe(before)
    expect(f.options.workspaceRevisions).toHaveBeenCalledTimes(2)
  })

  it('loads old rows without backfilling snapshots, preserves bytes and omits comparison',async()=>{
    const f=fixture(),service=f.open(),module=businessModuleCatalog()[0]!
    const task=await service.start({requestId:'old',operation:'create',instruction:'模块',handoff:{version:1,mode:'module',module:{moduleId:module.id,version:module.version,instanceKey:'example',parameters:module.parameterExample}}},f.caller)
    await service.close();delete task.workspaceSnapshot
    new PlanningStore<PlanningTask>(f.directory).write([task])
    const path=join(f.directory,'planning/tasks.json'),before=readFileSync(path,'utf8'),reopened=f.open()
    expect(reopened.get(task.id,f.caller)).not.toHaveProperty('workspaceSnapshot')
    expect(workspaceChangeVerification(reopened.get(task.id,f.caller))).toBeUndefined()
    expect(readFileSync(path,'utf8')).toBe(before)
  })

  it('publishes an old ready task without manufacturing acceptance-time evidence',async()=>{
    const f=fixture(),service=f.open(),module=businessModuleCatalog()[0]!
    const task=await service.start({requestId:'old-ready',operation:'create',instruction:'模块',preview:true,handoff:{version:1,mode:'module',module:{moduleId:module.id,version:module.version,instanceKey:'example',parameters:module.parameterExample}}},f.caller)
    await service.close();delete task.workspaceSnapshot;task.preview=false
    new PlanningStore<PlanningTask>(f.directory).write([task])
    const reopened=f.open(),ready=reopened.get(task.id,f.caller)
    const published=await reopened.publish(ready.id,ready.revision,ready.candidateDigest!,f.caller)
    expect(published.state).toBe('published')
    expect(published).not.toHaveProperty('workspaceSnapshot')
    expect(workspaceChangeVerification(published)).toBeUndefined()
    expect(f.options.workspaceRevisions).toHaveBeenCalledTimes(1)
  })

  it('reports removed workflows and never invents a missing publish endpoint after recovery',()=>{
    const task={state:'published',request:{operation:'create'},receipt:{workflowId:'new',kind:'created',revision:1},workspaceSnapshot:{accepted:{removed:3},published:{new:1}}} as PlanningTask
    expect(workspaceChangeVerification(task)!.otherWorkflows).toEqual([{workflowId:'removed',acceptedRevision:3,publishedRevision:null,unchanged:false}])
    delete task.workspaceSnapshot!.published
    expect(workspaceChangeVerification(task)).toBeUndefined()
    task.request.operation='revise'
    expect(workspaceChangeVerification(task)).toBeUndefined()
  })
})
