import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Run the real Cordis plugin in tsx, as in workflow-scope-host.test.ts, while
// keeping the complete offline fixture in this permitted test file.
const fixture=`
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import VisibleWorkflowService from ${JSON.stringify(new URL('../src/host/index.ts',import.meta.url).href)}
import { makeWorkflow } from ${JSON.stringify(new URL('../src/shared/types.ts',import.meta.url).href)}
const directory=mkdtempSync(join(tmpdir(),'host-entry-audit-')),foreignPath=join(directory,'foreign')
mkdirSync(foreignPath)
const ctx=new Context(),definitions=new Map()
const agent={id:'main',ctx,session:{id:'main',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}}
const provisions=[
  ctx.provide('agents',{get:id=>id===agent.id?agent:undefined,list:()=>[agent],roots:()=>[agent],isOwnedBy:()=>false,withInitiator:(_agent,fn)=>fn()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'local',title:'Local',path:directory,sessionIds:[agent.id]},{id:'foreign',title:'Foreign',path:foreignPath,sessionIds:[]}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){throw Error('Model calls forbidden')}}),
  ctx.provide('tools',{register:definition=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:join(directory,'state')});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows'),signal=new AbortController().signal
const tool=async(name,args={})=>JSON.parse(await definitions.get(name).execute(args,{agent,signal}))
const save=async flow=>JSON.parse(await service.save(JSON.stringify(flow),flow.revision))
try{
TEST_BODY
  console.log(JSON.stringify({ok:true}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
`
async function run(body:string){
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',fixture.replace('TEST_BODY',body)],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true})
}

describe('Host entry audit regressions',()=>{
  it('allows saved viewport/scope navigation but still rejects changed numbers, annotations, content and revisions',async()=>{
    await run(`
      const flow=await save(makeWorkflow('local','Reviewed baseline',true))
      const caller=service.planningCaller({agent,signal})
      const request={requestId:'audit-revise',operation:'revise',instruction:'Update description',targetWorkflowId:flow.id,expectedRevision:flow.revision,preview:true}
      const context=await service.planningContext(request,caller)
      const task={id:'audit-task',sessionId:agent.id,workspaceId:'local',preview:true,request,context}
      const authorize=()=>{service.authorizePlanning(task,caller,false);service.authorizePlanning(task,caller,true)}
      authorize()
      const view=await save({...flow,editor:{viewport:{x:125,y:-42,scale:1.5}}})
      assert.equal(view.revision,flow.revision);assert.equal(view.updatedAt,flow.updatedAt)
      authorize()
      const scope=await save({...view,editor:{...view.editor,scopePath:[]}})
      assert.equal(scope.revision,flow.revision);authorize()
      assert.deepEqual(context.workflow,flow,'authorization must not mutate the frozen context')
      const get=service.storage.get.bind(service.storage)
      for(const change of [
        value=>{value.nodes[1].number='a-999'},
        value=>{value.editor.annotations=[{id:'annotation',number:1,nodeIds:[flow.nodes[1].id],text:'Changed review'}]},
        value=>{value.nodes[1].config.text='Changed content'},
        value=>{value.updatedAt='2099-01-01T00:00:00.000Z'},
        value=>{value.revision++},
      ]){
        const changed=structuredClone(scope);change(changed)
        service.storage.get=id=>id===flow.id?structuredClone(changed):get(id)
        for(const write of [false,true])assert.throws(()=>service.authorizePlanning(task,caller,write),/REVISION_CONFLICT/)
      }
      service.storage.get=get;authorize()
    `)
  },35_000)

  it('lists global and visible workflow roles without returning another workspace private prompt',async()=>{
    await run(`
      const local=await save(makeWorkflow('local','Local',true)),foreign=await save(makeWorkflow('foreign','Private',true))
      const shared=await save({...makeWorkflow('foreign','Shared',true),scope:'global'})
      const preset=(id,owner)=>({id,name:id,prompt:'secret prompt '+id,revision:0,...(owner?{scope:'workflow',workflowId:owner}:{})})
      for(const role of [preset('legacy'),{...preset('global'),scope:'global'},preset('local-role',local.id),preset('foreign-role',foreign.id),preset('shared-role',shared.id)])service.storage.savePreset(role)
      const listed=await tool('visible_workflow_list')
      assert.equal(listed.workspaceId,'local')
      assert.deepEqual(new Set(listed.workflows.map(flow=>flow.id)),new Set([local.id,shared.id]))
      assert.deepEqual(new Set(listed.presets.map(role=>role.id)),new Set(['legacy','global','local-role','shared-role']))
      assert.ok(!JSON.stringify(listed).includes('secret prompt foreign-role'))
      await assert.rejects(definitions.get('visible_workflow_list').execute({},{signal}),/需要当前对话/)
    `)
  },35_000)
  it('returns the same Remote and Agent start receipt, including after a lost reply',async()=>{
    await run(`
      const flow=await save(makeWorkflow('local','Idempotent Host start',true))
      const first=JSON.parse(await service.start(flow.id,'{"text":"one"}',agent.id,'remote-request'))
      assert.equal(JSON.parse(await service.start(flow.id,'{"text":"one"}',agent.id,'remote-request')).id,first.id)
      await service.runtime.settle(first.id)
      assert.equal(JSON.parse(await service.start(flow.id,'{"text":"one"}',agent.id,'remote-request')).id,first.id)
      await assert.rejects(service.start(flow.id,'{"text":"two"}',agent.id,'remote-request'),/REQUEST_ID_CONFLICT/)
      const args={id:flow.id,inputs_json:'{"text":"tool"}',request_id:'agent-request'}
      const fromTool=await tool('visible_workflow_run',args)
      assert.equal((await tool('visible_workflow_run',args)).id,fromTool.id)
      await service.runtime.settle(fromTool.id)
      assert.equal((await tool('visible_workflow_run',args)).id,fromTool.id)
      await assert.rejects(definitions.get('visible_workflow_run').execute({...args,inputs_json:'{"text":"changed"}'},{agent,signal}),/REQUEST_ID_CONFLICT/)
      const plan=JSON.parse(await service.recoveryPlan(first.id,''))
      const recovered=JSON.parse(await service.recover(first.id,agent.id,plan.planDigest,'','recover-request'))
      assert.equal(JSON.parse(await service.recover(first.id,agent.id,plan.planDigest,'','recover-request')).id,recovered.id)
      await service.runtime.settle(recovered.id)
      assert.equal(JSON.parse(await service.recover(first.id,agent.id,plan.planDigest,'','recover-request')).id,recovered.id)
    `)
  },35_000)
  it('rolls back a constructor failure immediately and retains normal live-lock protection',async()=>{
    await run(`
      for(const broken of ['editor-state.json','tool-catalog.json','planning/tasks.json']){
        const bad=join(directory,'failed-'+broken.replaceAll('/','-'));mkdirSync(bad,{recursive:true})
        if(broken.includes('/'))mkdirSync(join(bad,'planning'))
        writeFileSync(join(bad,broken),'{bad')
        const isolated=new Context()
        for(const name of ['agents','workspaceRegistry','llm','tools','systemPrompt','typert','planMode'])isolated.provide(name,ctx.get(name))
        assert.throws(()=>new VisibleWorkflowService(isolated,{stateDirectory:bad}))
        assert.equal(existsSync(join(bad,'host.lock')),false,'constructor must release before Cordis disposal')
        rmSync(join(bad,broken))
        // Real storage lock acquisition immediately succeeds in the same PID.
        const {WorkflowStorage}=await import(${JSON.stringify(new URL('../src/host/storage.ts',import.meta.url).href)})
        const storage=new WorkflowStorage(bad)
        assert.throws(()=>new WorkflowStorage(bad),/其他 Host 占用/)
        storage.close()
      }
    `)
  },35_000)

  it.each(['rerun','recover'] as const)('normalizes empty Remote sessions for %s conflicts and repeated receipts',async mode=>{
    await run(`
      const flow=await save(makeWorkflow('local','Empty-session receipt',true))
      const source=JSON.parse(await service.start(flow.id,'{"text":"input"}','','empty-session-start'))
      await service.runtime.settle(source.id)
      const plan=JSON.parse(await service.recoveryPlan(source.id,''))
      const confirm=requestId=>${mode==='rerun'?"service.rerun(source.id,'',requestId)":"service.recover(source.id,'',plan.planDigest,'',requestId)"}
      await assert.rejects(confirm('empty-session-start'),/REQUEST_ID_CONFLICT/)
      assert.equal(service.storage.runs().length,1,'conflicting request must not dispatch a new run')
      assert.equal(JSON.parse(await service.start(flow.id,'{"text":"input"}','','empty-session-start')).id,source.id)
      assert.equal(JSON.parse(await service.start(flow.id,'{"text":"input"}',undefined,'empty-session-start')).id,source.id)
      assert.equal(source.requestReceipt.sessionId,undefined)
      const recovered=JSON.parse(await confirm('empty-session-confirm'))
      assert.equal(recovered.requestReceipt.sessionId,undefined)
      assert.equal(JSON.parse(await confirm('empty-session-confirm')).id,recovered.id)
      await service.runtime.settle(recovered.id)
      assert.equal(JSON.parse(await confirm('empty-session-confirm')).id,recovered.id)
      assert.equal(JSON.parse(await ${mode==='rerun'?"service.rerun(source.id,undefined,'empty-session-confirm')":"service.recover(source.id,undefined,plan.planDigest,'','empty-session-confirm')"}).id,recovered.id)
      assert.equal(service.storage.runs().length,2)
    `)
  },35_000)

})
