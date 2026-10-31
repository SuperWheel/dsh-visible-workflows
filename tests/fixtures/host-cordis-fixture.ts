// Exercise the installed Cordis proxy and the actual service, not a copied inject-name list.
// The original missing `agents` declaration fails at start()/tools() in this plugin context.
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow, newId, type WorkflowRun } from '../../src/shared/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

async function mountedWorkflowService(agentPresent=false,toolMode?:'native'|'ptc') {
  const directory=mkdtempSync(join(tmpdir(),'workflow-cordis-')),ctx=new Context(),nativeCalls:unknown[]=[]
  const promptFiber=ctx.plugin(SystemPrompt,{personaPrefix:'普通聊天测试：{{assistant_name}}。'});await promptFiber
  assert.equal(promptFiber.state,2)
  const sessionId=SessionId('conversation'),workspaceId='workspace'
  const agents=new Map<string,any>()
  const workspaces=[{id:workspaceId,title:'Test',path:directory,sessionIds:[sessionId]}]
  if(agentPresent)agents.set(sessionId,{id:sessionId,ctx,session:{id:sessionId,header:{id:sessionId,cwd:directory}},options:{}})
  const provisions=[
    ctx.provide('llm',{listProviders:()=>[],listModels:async()=>[],resolveModelInfo:async()=>{throw new Error('No model should be resolved in this deterministic fixture')}}),ctx.provide('agents',{get:(id:string)=>agents.get(id),list:()=>[...agents.values()],roots:()=>[...agents.values()],isOwnedBy:()=>false}),
    ctx.provide('workspaceRegistry',{list:()=>workspaces}),
    ctx.systemPrompt.variable('assistant_name',()=> '本地测试助手'),ctx.provide('typert',{}),
  ]
  if(!toolMode)provisions.push(ctx.provide('tools',{register:()=>()=>{},schemas:()=>[{name:'native_test',description:'permission fixture',parameters:{type:'object'}}],get:()=>({}),execute:async(value:unknown)=>{nativeCalls.push(value);return {isError:false,value:'authorized',content:[{type:'text',text:'authorized'}]}}}))
  // DSH 0.2.1 generates its SDK section in `ptc` mode. Only its
  // language is needed for assembly; a code/model execution must never happen.
  if(toolMode==='ptc')provisions.push(ctx.provide('ptcRuntime',{language:'typescript',execute:()=>{throw new Error('Prompt contract fixture must not execute code')}}))
  const toolsFiber=toolMode?ctx.plugin(ToolRuntime,{mode:toolMode}):undefined
  if(toolsFiber){await toolsFiber;assert.equal(toolsFiber.state,2)}
  const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory});await fiber
  assert.equal(fiber.state,2)
  const service=fiber.ctx.get('visibleWorkflows')!
  const close=async()=>{await fiber.dispose();await toolsFiber?.dispose();for(const dispose of provisions.reverse())await dispose();await promptFiber.dispose();rmSync(directory,{recursive:true,force:true})}
  const flow=(native=false)=>{const flow=makeWorkflow(workspaceId),id=newId();flow.nodes.splice(1,0,{id,number:'a-2',kind:'tool',title:'Time',x:300,y:0,fixed:false,config:{toolId:native?'native:native_test':'builtin:time.timestamp',inputs:{}}});flow.nodes.at(-1)!.config.text=`{{${id}.text}}`;flow.edges=[{id:newId(),source:flow.nodes[0]!.id,target:id},{id:newId(),source:id,target:flow.nodes.at(-1)!.id}];return flow}
  const settle=async(id:string)=>{for(let i=0;i<1500;i++){const run=JSON.parse(await service.run(id)) as WorkflowRun;if(run.status!=='running')return run;await new Promise<void>(resolve=>setTimeout(resolve,10))}throw new Error('fixture did not settle')}
  return {service,ctx,fiber,agents,workspaces,sessionId,workspaceId,directory,nativeCalls,close,flow,settle}
}

async function promptContract(){
 const cases:string[]=[]
 for(const mode of ['native','ptc'] as const){
  const fixture=await mountedWorkflowService(false,mode)
  try {
   // This is the section registered by the production Host constructor into
   // the real SDK registry, not an extracted/copy-pasted guidance string.
   const assembly=await fixture.ctx.systemPrompt.assemble()
   const guide=assembly.sections.find(section=>section.name==='visible-workflows:guide')
   assert.ok(guide,'production workflow guidance must actually be registered')
   assert.equal(guide.interpolate,false)
   assert.ok(guide.text.includes('{{input.字段名}}'))
   assert.ok(guide.text.includes('{{稳定节点ID.text}}'))
   assert.ok(guide.text.includes('reviewed-file-write@1.0.0'))
   assert.equal(guide.text.includes('config.body'),false)
   const rendered=renderPrompt(assembly)
   assert.ok(rendered.includes(guide.text),'rendering must preserve the complete workflow guidance verbatim')
   assert.ok(rendered.includes('普通聊天测试：本地测试助手。'),'ordinary prompt variables still interpolate normally')
   assert.deepEqual(Object.keys(assembly.variables),['assistant_name'])
   const save=fixture.ctx.tools.schemas().find(tool=>tool.name==='visible_workflow_save')
   assert.ok(save,'the real ToolRuntime must expose the production save schema')
   assert.equal(save.description,fixture.ctx.tools.get('visible_workflow_save')!.description)
   assert.ok(save.description.includes('{{input.字段名}}'))
   assert.ok(save.description.includes('{{稳定节点ID.text}}'))
   assert.equal(Object.hasOwn(save,'execute'),false)
   const plan=fixture.ctx.tools.schemas().find(tool=>tool.name==='visible_workflow_plan')
   assert.ok(plan?.description.includes('reviewed-file-write@1.0.0'))
   assert.equal(Object.hasOwn(save,'output'),false)
   if(mode==='native')assert.deepEqual(assembly.tools.find(tool=>tool.name==='visible_workflow_save'),save)
   if(mode==='ptc'){
    // PTC advertises only its transport on the wire; individual capabilities
    // remain in the generated SDK documentation consumed by the model.
    assert.deepEqual(assembly.tools.map(tool=>tool.name),['run_code'])
    const sdk=assembly.sections.find(section=>section.name==='tools:sdk')
    assert.ok(sdk,'real SDK tool documentation must participate in prompt assembly')
    assert.equal(sdk.interpolate,false)
    assert.ok(sdk.text.includes('visible_workflow_save'))
    assert.ok(sdk.text.includes('{{input.字段名}}'))
    assert.ok(sdk.text.includes('{{稳定节点ID.text}}'))
    assert.ok(rendered.includes(sdk.text))
   }
   // Mutation of the actual assembled section demonstrates the former failure:
   // omitting the literal flag makes an otherwise ordinary chat fail before LLM.
   const oldAssembly={...assembly,sections:assembly.sections.map(section=>{
    if(section.name!=='visible-workflows:guide')return section
    const {interpolate:_,...oldSection}=section
    return oldSection
   })}
   assert.throws(()=>renderPrompt(oldAssembly),/malformed prompt variable reference "\{\{input\.字段名\}\}" in section "visible-workflows:guide"/)
   assert.equal(fixture.nativeCalls.length,0)
   cases.push(`${mode}-ordinary-chat-literal-guidance`,`${mode}-old-config-reproduces-malformed-variable`,`${mode}-production-tool-braces-preserved`)
  } finally {await fixture.close()}
 }
 console.log(JSON.stringify({ok:true,cases}))
}

async function main(){
 const fixture=await mountedWorkflowService()
 try {
  const flow=fixture.flow();await fixture.service.save(JSON.stringify(flow),0)
  const run=JSON.parse(await fixture.service.start(flow.id,'{"text":"test"}',fixture.sessionId)) as WorkflowRun
  assert.equal((await fixture.settle(run.id)).status,'success')
  assert.ok(JSON.parse(await fixture.service.tools(fixture.workspaceId,fixture.sessionId)).some((t:{id:string})=>t.id==='builtin:time.timestamp'))
  assert.equal(fixture.fiber.ctx.get('sandbox'),undefined)
  const dispose=fixture.ctx.provide('sandbox',{confine:async(argv:readonly string[])=>({argv,enforcement:'full'})})
  assert.ok(fixture.fiber.ctx.get('sandbox'));await dispose()
  const native=fixture.flow(true);await fixture.service.save(JSON.stringify(native),0)
  await assert.rejects(fixture.service.start(native.id,'{"text":"test"}',fixture.sessionId),/对话权限/)
  assert.equal(fixture.nativeCalls.length,0)
 } finally {await fixture.close()}
 const active=await mountedWorkflowService(true)
 try {
  const flow=active.flow(true);await active.service.save(JSON.stringify(flow),0)
  const run=JSON.parse(await active.service.start(flow.id,'{"text":"test"}',active.sessionId)) as WorkflowRun
  assert.equal((await active.settle(run.id)).status,'success')
  assert.equal(active.nativeCalls.length,1)
  assert.equal((active.nativeCalls[0] as {agent:unknown}).agent,active.agents.get(active.sessionId))
  active.workspaces.push({id:'other',title:'Other',path:join(active.directory,'other'),sessionIds:[]})
  const other=active.flow();other.workspaceId='other';await active.service.save(JSON.stringify(other),0)
  const otherRun=JSON.parse(await active.service.start(other.id,'{"text":"test"}',active.sessionId)) as WorkflowRun
  assert.equal((await active.settle(otherRun.id)).status,'success')
  const nativeOther=active.flow(true);nativeOther.workspaceId='other';await active.service.save(JSON.stringify(nativeOther),0)
  await assert.rejects(active.service.start(nativeOther.id,'{"text":"test"}',active.sessionId),/对话权限/)
  assert.equal(active.nativeCalls.length,1)
 } finally {await active.close()}
 console.log(JSON.stringify({ok:true,cases:['builtin-without-agent','optional-sandbox','native-denied-without-agent','native-scoped-execute','other-workspace-builtin-only']}))
}
if(process.argv.includes('--prompt-contract'))await promptContract()
else await main()
