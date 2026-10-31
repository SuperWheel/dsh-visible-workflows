// Real installed SDK registry + official spawn provider + ToolRuntime. Temporary
// in-memory sessions only; no production session registration or model request.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {resolveAgentWorkspace} from '../../src/host/agent-workspace.ts'

if(!process.versions.electron)throw Error('INSTALLED_HARNESS_NODE_REQUIRED')
const req=createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json')
const url=name=>pathToFileURL(req.resolve('@deepseek-ai/'+name)).href
const load=name=>import(url(name)),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const [{boot},{default:SystemPrompt},{default:Tools,defineTool},{default:Projections},{default:SandboxPolicy}]=await Promise.all(['dsh-app-boot','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-sandbox-policy'].map(load))
const directory=await realpath(await mkdtemp(path.join(tmpdir(),'dsh-agent-workspace-'))),workspace=path.join(directory,'workspace'),otherWorkspace=path.join(directory,'other')
await mkdir(workspace);await mkdir(otherWorkspace)
const config=path.join(directory,'cordis.yml')
await writeFile(config,JSON.stringify(['dsh-session','dsh-agent','dsh-llm','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process'].map(name=>({id:name,name:url(name),config:{}}))))
const results=[],failures=[],handles=[],controller=new AbortController()
let root,nativeChild,nativeRun,startTask,releaseCreation,foundChild,watchNative=false,modelRequests=0,remainingAgents
const barrier=new Promise(resolve=>{releaseCreation=resolve}),created=new Promise(resolve=>{foundChild=resolve})
const deadline=setTimeout(()=>{controller.abort();releaseCreation()},15000)
const hardDeadline=setTimeout(()=>process.exit(124),25000);hardDeadline.unref()
const check=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch{results.push({name,passed:false})}}
try{
  root=await boot('workflow-agent-workspace-component',config,[],async ctx=>{
    await ctx.plugin(SystemPrompt,{});await ctx.plugin(Tools,{mode:'native'});await ctx.plugin(Projections,{});await ctx.plugin(SandboxPolicy,{mode:'workspace-write',workspaceRoot:workspace})
  })
  root.on('llm/request',()=>{modelRequests++;throw Error('MODEL_REQUEST_FORBIDDEN')})
  root.on('agent/created',async({agent})=>{if(watchNative&&agent.session.header.origin==='subagent'){nativeChild=agent;foundChild();await barrier}})
  const main=await root.agents.create({sessionId:'workspace-probe-main',meta:{cwd:workspace}});handles.push(main)
  const other=await root.agents.create({sessionId:'workspace-probe-other',meta:{cwd:otherWorkspace}});handles.push(other)
  const workspaces=[{id:'workspace-a',path:workspace,sessionIds:[main.agent.id]},{id:'workspace-b',path:otherWorkspace,sessionIds:[other.agent.id]}]
  const resolve=agent=>resolveAgentWorkspace(agent,workspaces,root.agents)
  root.tools.register(defineTool({name:'synthetic_workspace_lookup',description:'Synthetic registry acceptance only',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(_args,exec)=>{const id=resolve(exec.agent);if(!id)throw Error('WORKSPACE_DENIED');return id}}))
  const execute=agent=>root.tools.execute({agent,name:'synthetic_workspace_lookup',arguments:{},callId:'workspace-probe-call',signal:new AbortController().signal})
  await check('registered_main_uses_real_tool_runtime',async()=>{assert.equal((await execute(main.agent)).value,'workspace-a')})
  const forged=await root.agents.create({sessionId:'workspace-probe-forged',meta:{cwd:workspace,parentSession:main.agent.id,origin:'subagent',delegationDepth:1}});handles.push(forged)
  await check('forged_durable_parent_without_runtime_owner_denied',async()=>{assert.equal(root.agents.isOwnedBy(forged.agent.id,main.agent),false);assert.equal((await execute(forged.agent)).isError,true)})
  const wrong=await other.agent.ctx.agents.create({sessionId:'workspace-probe-wrong-parent',parentAgent:other.agent,meta:{cwd:workspace,parentSession:main.agent.id,origin:'subagent',delegationDepth:1}});handles.push(wrong)
  await check('real_owned_child_with_forged_parent_header_denied',async()=>{assert(root.agents.isOwnedBy(wrong.agent.id,other.agent));assert.equal((await execute(wrong.agent)).isError,true)})
  const changed=await main.agent.ctx.agents.create({sessionId:'workspace-probe-other-cwd',parentAgent:main.agent,meta:{cwd:otherWorkspace,parentSession:main.agent.id,origin:'subagent',delegationDepth:1}});handles.push(changed)
  await check('owned_child_cannot_switch_to_other_workspace_by_cwd',async()=>{assert(root.agents.isOwnedBy(changed.agent.id,main.agent));assert.equal((await execute(changed.agent)).isError,true)})
  watchNative=true
  startTask=root.get('subagents').start('spawn',{parent:main.agent,label:'Synthetic workspace inheritance',prompt:[{type:'text',text:'No model execution; creation barrier acceptance.'}],signal:controller.signal,maxDepth:3,toolFilter:{allow:['synthetic_workspace_lookup']}}).then(async run=>{nativeRun=run;return run.result.then(()=>({finished:true}),()=>({aborted:true}))},()=>({aborted:true}))
  await Promise.race([created,startTask.then(()=>{if(!nativeChild)throw Error('NATIVE_CHILD_NOT_CREATED')})])
  await check('official_spawn_child_inherits_registered_parent_workspace',async()=>{
    assert(root.agents.isOwnedBy(nativeChild.id,main.agent));assert.equal(nativeChild.session.header.parentSession,main.agent.id)
    assert.equal((await execute(nativeChild)).value,'workspace-a');assert.equal(workspaces[0].sessionIds.includes(nativeChild.id),false)
  })
  await check('same_id_object_substitution_denied',async()=>{assert.equal(resolve({...nativeChild}),undefined)})
  await check('workspace_registration_removal_revokes_child_authority',async()=>{workspaces[0].sessionIds=[];assert.equal((await execute(nativeChild)).isError,true);workspaces[0].sessionIds=[main.agent.id]})
}catch(error){failures.push(String(error?.message??error).slice(0,300))}
finally{
  clearTimeout(deadline);controller.abort();releaseCreation()
  await startTask;await nativeRun?.dispose().catch(()=>failures.push('NATIVE_DISPOSAL_FAILED'))
  for(const handle of handles.reverse())await handle.dispose().catch(()=>failures.push('AGENT_DISPOSAL_FAILED'))
  if(root){remainingAgents=root.agents.list().length;await root.fiber.dispose()}
  await rm(directory,{recursive:true,force:true});clearTimeout(hardDeadline)
}
const passed=results.length===7&&results.every(row=>row.passed)&&!failures.length&&modelRequests===0&&remainingAgents===0
const report={at:new Date().toISOString(),passed,results,failures,modelRequests,remainingAgents,temporaryFilesRemoved:true,productionModified:false,scope:'Installed SDK component acceptance with official native spawn held before its model turn; not a Desktop user-session retry',helperSha256:sha(await readFile('src/host/agent-workspace.ts')),installedAgentSha256:sha(await readFile(req.resolve('@deepseek-ai/dsh-agent'))),installedDriverSha256:sha(await readFile(req.resolve('@deepseek-ai/dsh-subagent-in-process-driver')))}
await mkdir('.cache/agent-workspace-20261017',{recursive:true});await writeFile('.cache/agent-workspace-20261017/results.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report));process.exitCode=passed?0:1
