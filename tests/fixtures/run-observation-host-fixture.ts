import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { existsSync,mkdtempSync,readFileSync,rmSync,statSync,unlinkSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime,{ defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow,newId,type Workflow,type WorkflowRun } from '../../src/shared/types.ts'
import { sdk,FsError,observationPolicyPlugin } from './t18-tools.ts'

// Run in tsx by run-observation-scope.test.ts (decorated Host entry).
// Production Host + real Cordis events + real dsh-tools registry + the pinned
// official tool-fs/observation-policy sources (T18 snapshot). Only the
// filesystem provider, working directory and Agent records are doubles.
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const cleanups:Array<()=>Promise<void>|void>=[]

function provider(directory:string){
  const version=(path:string)=>existsSync(path)?hash(readFileSync(path)):undefined
  return {
    resolve:async(path:string)=>({targetKey:resolve(directory,path),displayPath:resolve(directory,path)}),
    processPath:(target:any)=>target.displayPath,
    stat:async(target:any)=>existsSync(target.displayPath)?{type:statSync(target.displayPath).isFile()?'file':'directory',size:statSync(target.displayPath).size,version:version(target.displayPath)}:undefined,
    readText:async(target:any)=>readFileSync(target.displayPath,'utf8'),
    writeText:async(target:any,content:string,intent:any)=>{
      const path=target.displayPath,before=existsSync(path)?readFileSync(path,'utf8'):null
      if(intent?.kind==='createIfAbsent'&&before!==null)throw new FsError('not observed','FS_NOT_OBSERVED')
      if(intent?.kind==='replaceIfVersion'&&version(path)!==intent.version)throw new FsError(`cannot write "${path}": ${before===null?'file no longer exists':'changed'}`,'FS_STALE_VERSION')
      writeFileSync(path,content,{flag:intent?.kind==='createIfAbsent'?'wx':'w'})
      return {operation:before===null?'create':'update',before,after:content,version:version(path)}
    },
  }
}

type Mount={
  // A conversation that existed (and acted) before the Host plugin was installed.
  beforeHost?:(converse:(name:string,args:Record<string,unknown>)=>Promise<any>,directory:string)=>Promise<void>
  // A non-SDK decider holding the write-intent slot ahead of the policy.
  foreignDecider?:boolean
}
async function mount(options:Mount={}){
  const directory=mkdtempSync(join(tmpdir(),'run-observation-')),ctx=new Context(),sessionId=SessionId('conversation'),workspaceId='workspace'
  const agent:any={id:sessionId,ctx,session:{id:sessionId,header:{id:sessionId,cwd:directory}},options:{}}
  const provisions=[
    ctx.provide('llm',{listProviders:()=>[],listModels:async()=>[],resolveModelInfo:async()=>{throw new Error('No model may be resolved')}}),
    ctx.provide('agents',{get:(id:string)=>id===sessionId?agent:undefined,list:()=>[agent],roots:()=>[agent],isOwnedBy:()=>false}),
    ctx.provide('workspaceRegistry',{list:()=>[{id:workspaceId,title:'Test',path:directory,sessionIds:[sessionId]}]}),
    ctx.provide('typert',{}),
  ]
  const prompt=ctx.plugin(SystemPrompt,{});await prompt
  const tools=ctx.plugin(ToolRuntime,{mode:'native'});await tools
  const registry=(ctx as any).tools
  sdk({fs:provider(directory),workingDirectory:{ensure:async()=>directory},tools:{register:(definition:any)=>registry.register(definition)},systemPrompt:{section:()=>{},getSectionOrder:()=>0},effect:()=>{},
    on:(name:string,listener:any)=>ctx.on(name as any,listener),emit:(...args:any[])=>(ctx.emit as any)(...args),waterfall:(...args:any[])=>(ctx.waterfall as any)(...args)},{policy:false})
  // Deployment order: an optional foreign decider, then the policy as its own Cordis plugin.
  const foreign=options.foreignDecider?ctx.plugin({name:'create-only-decider',apply:(plugin:any)=>{plugin.on('fs/write-intent',async()=>({kind:'createIfAbsent'}))}}):undefined
  if(foreign)await foreign
  const policy=ctx.plugin(observationPolicyPlugin());await policy
  // A wrapper whose first act is a nested dispatch, before emitting any fs event itself.
  registry.register(defineTool({name:'nested_read',description:'fixture wrapper',parameters:{file_path:{type:'string',required:true}},output:{schema:{type:'string'},render:(_:unknown,value:string)=>[{type:'text',text:value}]},
    execute:async(args:any,exec:any)=>{const result=await registry.execute({name:'read',arguments:{file_path:args.file_path},agent:exec.agent,signal:exec.signal,callId:randomUUID(),parent:exec.token,rootCallId:exec.rootCallId});if(result.isError)throw new Error(JSON.stringify(result.content));return 'nested'}}))
  // An out-of-band edit between workflow nodes, without any fs observation.
  registry.register(defineTool({name:'external_change',description:'fixture external writer',parameters:{},output:{schema:{type:'string'},render:(_:unknown,value:string)=>[{type:'text',text:value}]},execute:async()=>{writeFileSync(join(directory,'t05-greeting.json'),'{"external":true}');return 'changed'}}))
  // The conversation Agent's own tool call, outside any workflow run.
  const converse=(name:string,args:Record<string,unknown>)=>registry.execute({name,arguments:args,agent,signal:new AbortController().signal,callId:randomUUID()})
  if(options.beforeHost)await options.beforeHost(converse,directory)
  const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:join(directory,'.state')});await fiber
  const service:any=fiber.ctx.get('visibleWorkflows')!
  // A conversation opened after installation is announced like the SDK store does.
  if(!options.beforeHost)(ctx.emit as any)('session/created',agent.session)
  cleanups.push(async()=>{await fiber.dispose();await policy.dispose();await foreign?.dispose();await tools.dispose();for(const dispose of provisions.reverse())await dispose();await prompt.dispose();rmSync(directory,{recursive:true,force:true})})
  const chain=(steps:Array<{toolId:string;inputs?:Record<string,string>}|'human'>)=>{
    const flow=makeWorkflow(workspaceId),output=flow.nodes.pop()!,ids=steps.map(()=>newId())
    steps.forEach((step,index)=>flow.nodes.push(step==='human'
      ?{id:ids[index]!,number:`a-${index+2}`,kind:'human',title:'确认',x:300*(index+1),y:0,fixed:false,config:{prompt:'确认',fields:[],actions:[{id:'continue',label:'确认'}]}}
      :{id:ids[index]!,number:`a-${index+2}`,kind:'tool',title:step.toolId,x:300*(index+1),y:0,fixed:false,config:{toolId:step.toolId,inputs:step.inputs??{}}}))
    output.number=`a-${steps.length+2}`;output.config.text=`{{${ids.at(-1)}.text}}`;flow.nodes.push(output)
    const order=flow.nodes.map(node=>node.id);flow.edges=order.slice(1).map((target,index)=>({id:newId(),source:order[index]!,target}))
    return flow
  }
  const save=async(flow:Workflow)=>{await service.save(JSON.stringify(flow),0);return flow}
  const settle=async(id:string)=>{for(let i=0;i<1500;i++){const run=JSON.parse(await service.run(id)) as WorkflowRun;if(run.status!=='running')return run;await new Promise<void>(done=>setTimeout(done,10))}throw new Error('run did not settle')}
  const start=async(flow:Workflow)=>settle((JSON.parse(await service.start(flow.id,'{"text":"x"}',sessionId)) as WorkflowRun).id)
  // Waits through persisted state only: Remote run() would itself release terminal contexts.
  const stored=async(id:string,done:(run:WorkflowRun)=>boolean)=>{for(let i=0;i<1500;i++){const run=service.storage.run(id) as WorkflowRun;if(done(run))return run;await new Promise<void>(next=>setTimeout(next,10))}throw new Error('run did not reach the expected state')}
  const begin=async(flow:Workflow)=>(JSON.parse(await service.start(flow.id,'{"text":"x"}',sessionId)) as WorkflowRun).id
  // Continue a waiting run only after its first executor drained and start()'s settle callback ran.
  const drained=async(id:string)=>{for(let i=0;i<500&&service.runtime.running.has(id);i++)await new Promise<void>(next=>setTimeout(next,10));await new Promise<void>(next=>setTimeout(next,10))}
  const holds=(id:string)=>service.observations.runs.has(id) as boolean
  const tool=(name:string,args:Record<string,unknown>)=>registry.execute({name,arguments:args,agent,signal:new AbortController().signal,callId:randomUUID()})
  const target=join(directory,'t05-greeting.json')
  return {directory,target,chain,save,start,converse,stored,begin,drained,holds,tool,service}
}
const read={toolId:'native:read',inputs:{file_path:'t05-greeting.json'}}
const write=(name:string)=>({toolId:'native:write',inputs:{file_path:'t05-greeting.json',content:JSON.stringify({greeting:`Hello, ${name}`})}})
const failure=(run:WorkflowRun)=>[run.error??'',...run.executions.map(item=>item.error??'')].join('\n')

const cases:Record<string,()=>Promise<void>>={
  // run A reads and writes, external delete, run B creates the root target
  'cross-run-create':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const ada=await f.save(f.chain([read,write('Ada')])),grace=await f.save(f.chain([write('Grace')]))
    assert.equal((await f.start(ada)).status,'success')
    unlinkSync(f.target)
    const run=await f.start(grace)
    assert.equal(run.status,'success',failure(run))
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Grace'})
  },
  // still rejects an external change between a read and a write in the same run
  'same-run-stale':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const run=await f.start(await f.save(f.chain([read,{toolId:'native:external_change'},write('Ada')])))
    assert.equal(run.status,'failed')
    assert.match(failure(run),/re-read the file/)
    assert.equal(readFileSync(f.target,'utf8'),'{"external":true}')
  },
  // an unread existing target stays protected inside a run
  'same-run-unread':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const run=await f.start(await f.save(f.chain([write('Ada')])))
    assert.equal(run.status,'failed')
    assert.match(failure(run),/file has not been read/)
    assert.equal(readFileSync(f.target,'utf8'),'{"old":true}')
  },
  // conversation observations do not authorize or stale a run
  'conversation-to-run':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    assert.equal((await f.converse('read',{file_path:'t05-greeting.json'})).isError,false)
    // The conversation read does not let the run overwrite an unread file...
    const blocked=await f.start(await f.save(f.chain([write('Ada')])))
    assert.match(failure(blocked),/file has not been read/)
    // ...and its stale present@V cannot block the run's creation after a delete.
    unlinkSync(f.target)
    const created=await f.start(await f.save(f.chain([write('Grace')])))
    assert.equal(created.status,'success',failure(created))
  },
  // run observations neither authorize nor stale the conversation, which keeps its own
  'run-to-conversation':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const ada=await f.save(f.chain([read,write('Ada')]))
    assert.equal((await f.start(ada)).status,'success')
    // Unseen by the conversation: overwrite still needs its own read.
    const unread=await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":1}'})
    assert.equal(unread.isError,true)
    assert.match(JSON.stringify(unread.content),/file has not been read/)
    unlinkSync(f.target)
    assert.equal((await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":2}'})).isError,false)
    // The conversation's own read survives a run, and the run's write makes it stale.
    assert.equal((await f.converse('read',{file_path:'t05-greeting.json'})).isError,false)
    assert.equal((await f.start(await f.save(f.chain([read,write('Grace')])))).status,'success')
    const stale=await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":3}'})
    assert.match(JSON.stringify(stale.content),/re-read the file/)
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Grace'})
    // Its re-read hands the decision back to the SDK gate.
    assert.equal((await f.converse('read',{file_path:'t05-greeting.json'})).isError,false)
    assert.equal((await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":4}'})).isError,false)
  },
  // a child workflow run owns its observations, separate from its parent
  'child-run':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    // The parent's read does not authorize the child's overwrite...
    const childWrite=await f.save(f.chain([write('Child')]))
    const parentRead=await f.start(await f.save(f.chain([read,{toolId:`workflow:${childWrite.id}`,inputs:{text:'x'}}])))
    assert.equal(parentRead.status,'failed')
    assert.match(failure(parentRead),/file has not been read/)
    assert.equal(readFileSync(f.target,'utf8'),'{"old":true}')
    // ...and the child's read does not authorize the parent's.
    const childReadWrite=await f.save(f.chain([read,write('Child')]))
    const parentWrite=await f.start(await f.save(f.chain([{toolId:`workflow:${childReadWrite.id}`,inputs:{text:'x'}},write('Parent')])))
    assert.equal(parentWrite.status,'failed')
    assert.match(failure(parentWrite),/file has not been read/)
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Child'})
  },
  // A decider other than the policy keeps its semantics: it never grants an overwrite.
  'foreign-decider':async()=>{
    const f=await mount({foreignDecider:true})
    writeFileSync(f.target,'{"old":true}')
    const run=await f.start(await f.save(f.chain([read,write('Ada')])))
    assert.equal(run.status,'failed')
    assert.match(failure(run),/file has not been read/)
    assert.equal(readFileSync(f.target,'utf8'),'{"old":true}')
  },
  // A wrapper's nested read belongs to the run even though the wrapper emitted nothing first.
  'nested-before-observation':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const run=await f.start(await f.save(f.chain([read,{toolId:'native:external_change'},{toolId:'native:nested_read',inputs:{file_path:'t05-greeting.json'}},write('Ada')])))
    assert.equal(run.status,'success',failure(run))
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Ada'})
    const unread=await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":1}'})
    assert.match(JSON.stringify(unread.content),/file has not been read/)
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Ada'})
  },
  // Conversation history from before installation is unknown, not "never observed".
  'pre-install-conversation':async()=>{
    const f=await mount({beforeHost:async(converse,directory)=>{writeFileSync(join(directory,'t05-greeting.json'),'{"old":true}');assert.equal((await converse('read',{file_path:'t05-greeting.json'})).isError,false)}})
    assert.equal((await f.start(await f.save(f.chain([read])))).status,'success')
    unlinkSync(f.target)
    const stale=await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":1}'})
    assert.equal(stale.isError,true)
    assert.match(JSON.stringify(stale.content),/re-read the file/)
    assert.equal(existsSync(f.target),false)
    // Following the remediation records absence; the guarded creation then succeeds.
    assert.equal((await f.converse('read',{file_path:'t05-greeting.json'})).isError,true)
    assert.equal((await f.converse('write',{file_path:'t05-greeting.json',content:'{"agent":2}'})).isError,false)
  },
  // Completion after an answer releases the ledger without any Remote run() poll.
  'release-after-answer':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const id=await f.begin(await f.save(f.chain([read,'human',write('Ada')])))
    await f.stored(id,run=>run.status==='waiting')
    await f.drained(id)
    assert.equal(f.holds(id),true)
    await f.service.answer(id,'{}')
    const finished=await f.stored(id,run=>!['running','waiting'].includes(run.status));assert.equal(finished.status,'success',failure(finished))
    assert.equal(f.holds(id),false)
  },
  // Answering before the first executor drained keeps the live conversation binding.
  'answer-before-drain':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const id=await f.begin(await f.save(f.chain([read,'human',write('Ada')])))
    await f.stored(id,run=>run.status==='waiting')
    await f.service.answer(id,'{}')
    const finished=await f.stored(id,run=>!['running','waiting'].includes(run.status))
    assert.equal(finished.status,'success',failure(finished))
    assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{greeting:'Hello, Ada'})
    assert.equal(f.service.runContexts.has(id),false)
    assert.equal(f.holds(id),false)
  },
  // Cancelling a waiting run through the Agent tool releases the ledger too.
  'release-after-agent-cancel':async()=>{
    const f=await mount()
    writeFileSync(f.target,'{"old":true}')
    const id=await f.begin(await f.save(f.chain([read,'human'])))
    await f.stored(id,run=>run.status==='waiting')
    await f.drained(id)
    assert.equal(f.holds(id),true)
    const cancelled=await f.tool('visible_workflow_cancel',{run_id:id})
    assert.equal(cancelled.isError,false,JSON.stringify(cancelled.content))
    assert.equal(f.holds(id),false)
  },
}
const name=process.argv[2]!
assert.ok(cases[name],`unknown case ${name}`)
try{await cases[name]!()}finally{for(const cleanup of cleanups.splice(0).reverse())await cleanup()}
console.log(JSON.stringify({ok:true,case:name}))
