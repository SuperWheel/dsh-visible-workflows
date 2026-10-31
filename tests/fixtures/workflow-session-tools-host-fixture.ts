import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import VisibleWorkflowService from '../../src/host/index.ts'
import {validateTrialEntryTools} from '../../src/host/planning/trial-agent.ts'
import {WORKFLOW_SESSION_TOOL_NAMES} from '../../src/shared/workflow-session-tools.ts'
import {HTTP_CACHE_THRESHOLD,isCachedBody} from '../../src/shared/http-cache.ts'

// dsh-scope is not a direct dependency; take the instance dsh-tools itself uses.
const toolsRequire=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'))
const {createScope}=await import(toolsRequire.resolve('@deepseek-ai/dsh-scope')) as {createScope(ctx:Context,key:object):{ctx:Context}}
const directory=mkdtempSync(join(tmpdir(),'workflow-session-host-')),ctx=new Context()
let readonly=false,plan=false,networkCalls=0
const main:any={id:'main',ctx,session:{id:'main',header:{id:'main',cwd:directory}},options:{}}
const other:any={id:'other',ctx,session:{id:'other',header:{id:'other',cwd:directory}},options:{}}
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'?main:id==='other'?other:undefined,list:()=>[main,other],roots:()=>[main,other],isOwnedBy:()=>false}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:directory,title:'工具测试',sessionIds:['main','other']}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:async()=>[],resolveModelInfo:async()=>{throw Error('禁止模型调用')}}),
  ctx.provide('typert',{}),
  ctx.provide('planMode',{get:()=>({active:plan})}),
  ctx.provide('sandboxPolicy',{resolve:()=>({mode:readonly?'read-only':'workspace-write'})}),
]
const prompt=ctx.plugin(SystemPrompt,{});await prompt
const tools=ctx.plugin(ToolRuntime,{mode:'native'});await tools
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory});await fiber
const fetch=globalThis.fetch
globalThis.fetch=async url=>{networkCalls++;return new Response((String(url).includes('/large')?'<!--'+'x'.repeat(HTTP_CACHE_THRESHOLD)+'-->':'')+'<title>工具测试</title><body><main>正文</main></body>',{headers:{'content-type':'text/html'}})}
try{
  assert.equal(fiber.state,2)
  // Real agent scopes: session tools and their guidance stay out of conversations not doing workflow work.
  main.ctx=createScope(fiber.ctx,main).ctx;other.ctx=createScope(fiber.ctx,other).ctx
  const service=fiber.ctx.get('visibleWorkflows')!
  const visible=(agent:any)=>ctx.tools.schemas(agent).map(tool=>tool.name)
  const sectionNames=async(agent:any)=>(await ctx.systemPrompt.assemble({scope:agent,agent} as any)).sections.map((section:any)=>[section.name,section.text] as const)
  for(const agent of [main,other])assert.ok(!visible(agent).some(name=>WORKFLOW_SESSION_TOOL_NAMES.includes(name as any)))
  assert.ok(!(await sectionNames(main)).some(([name,text])=>name==='visible-workflows:session-tools'||text.includes('workflow_http_request')))
  await ctx.tools.execute({callId:'enable' as any,name:'visible_workflow_dictionary',arguments:{},agent:main,signal:new AbortController().signal})
  assert.ok((await sectionNames(main)).some(([name,text])=>name==='visible-workflows:session-tools'&&text.includes('workflow_file_stat')))
  assert.ok(!visible(other).some(name=>WORKFLOW_SESSION_TOOL_NAMES.includes(name as any)))
  assert.ok(!(await sectionNames(other)).some(([name])=>name==='visible-workflows:session-tools'))
  const names=visible(main)
  for(const name of WORKFLOW_SESSION_TOOL_NAMES){
    assert.ok(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
    assert.equal(names.filter(value=>value===name).length,1)
    assert.ok(ctx.tools.get(name,main))
  }
  const menu=JSON.parse(await service.tools('workspace','main'))
  assert.ok(menu.some((tool:any)=>tool.id==='builtin:html.select'))
  for(const name of WORKFLOW_SESSION_TOOL_NAMES)assert.ok(!menu.some((tool:any)=>tool.id===`native:${name}`))
  const plannerCatalog=(service as any).catalog.list('workspace','main')
  for(const name of WORKFLOW_SESSION_TOOL_NAMES)assert.ok(!plannerCatalog.some((tool:any)=>tool.id===`native:${name}`))
  validateTrialEntryTools(main,WORKFLOW_SESSION_TOOL_NAMES)
  const unregistered:any={ctx:{tools:{schemas:()=>[],get:()=>undefined}}}
  assert.throws(()=>validateTrialEntryTools(unregistered,WORKFLOW_SESSION_TOOL_NAMES),/TRIAL_TOOLS_INVALID/)
  for(const name of ['workflow_http_request_extra','native:workflow_http_request','builtin:html.select','visible_workflow_run'])assert.throws(()=>validateTrialEntryTools(main,[name]),/TRIAL_TOOLS_INVALID/)
  const call=(name:string,args:any,agent=main)=>ctx.tools.get(name,main)!.execute(args,{agent,signal:new AbortController().signal} as any)
  const body:any=await call('workflow_http_request',{url:'https://offline.test'})
  assert.equal(body.status_code,200)
  assert.equal((await call('workflow_html_extract_text',{html:body.text}) as any).text,'正文')
  assert.equal((await call('workflow_html_select',{html:body.text,items:'main',fields:{text:{text:true}}}) as any).count,1)
  const cached:any=await call('workflow_http_request',{url:'https://offline.test/large'})
  assert.ok(isCachedBody(cached.text))
  assert.equal((await call('workflow_html_extract_text',{html:cached.text}) as any).text,'正文')
  assert.equal((await call('workflow_html_select',{html:cached.body,items:'main',fields:{text:{text:true}}}) as any).count,1)
  writeFileSync(join(directory,'a.txt'),'\uFEFFx\r\n')
  assert.deepEqual(await call('workflow_file_stat',{path:'a.txt'}),{text:'a.txt：6 字节，1 行，行尾 crlf，有 UTF-8 BOM',path:'a.txt',name:'a.txt',bytes:6,lines:1,lineEnding:'crlf',endsWithNewline:true,bom:true})
  for(const mode of ['read-only','plan']){
    readonly=mode==='read-only';plan=mode==='plan'
    for(const name of WORKFLOW_SESSION_TOOL_NAMES)await assert.rejects(call(name,{url:'https://offline.test',html:body.text,items:'main',fields:{text:{text:true}},path:'a.txt'}),mode==='read-only'?/只读/:/规划模式/)
  }
  readonly=false;plan=false
  await assert.rejects(call('workflow_http_request',{url:'https://offline.test'},null),/当前对话/)
  await assert.rejects(call('workflow_http_request',{url:'https://offline.test'},{...main}),/权限上下文已结束/)
  assert.equal(networkCalls,2)
  console.log(JSON.stringify({ok:true,registration:true,nativeExclusion:true,plannerExclusion:true,trialAdmission:true,readOnly:true,planMode:true,networkCalls}))
}finally{
  globalThis.fetch=fetch
  await fiber.dispose();await tools.dispose();await prompt.dispose()
  for(const dispose of provisions.reverse())await dispose()
  rmSync(directory,{recursive:true,force:true})
}
