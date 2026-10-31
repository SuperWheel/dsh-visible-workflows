import {afterEach,describe,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowRuntime,type AdapterRequest} from '../src/host/runtime.ts'
import {makeWorkflow} from '../src/shared/types.ts'
import {bindNodeSubagent,createWorkflowSubagent} from '../src/shared/workflow-subagents.ts'
const contexts:{path:string;runtime:WorkflowRuntime}[]=[]
afterEach(async()=>{for(const context of contexts.splice(0)){await context.runtime.close();rmSync(context.path,{recursive:true,force:true})}})
describe('子 Agent 身份的 Host 与运行快照',()=>{
  it('persists the main session before returning the actual run revision and rejects cross-session reuse',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/subagent-binding-host-fixture.ts',import.meta.url).pathname],{timeout:15_000})
    expect(JSON.parse(stdout.trim())).toMatchObject({ok:true,mainBindingPersisted:true,sourceRevisionMatches:true,foreignSessionRejected:true,deniedStartUnchanged:true})
  })
  it('freezes registry roles independently of later edits and records logical/native identities separately',async()=>{
    const path=mkdtempSync(join(tmpdir(),'workflow-subagent-role-')),storage=new WorkflowStorage(path),calls:AdapterRequest[]=[]
    const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('no model call')}},{execute:async(_kind,request)=>{calls.push(request);request.onTask?.(`native-${calls.length}`);request.onUsage?.({totalTokens:1});return {text:request.rolePrompt??''}}});contexts.push({path,runtime})
    const flow=makeWorkflow('w','registry role',true),node=flow.nodes[1]!
    node.kind='agent';node.config={prompt:'{{input.text}}',model:{provider:'p',model:'m'},maxSteps:2}
    const definition=createWorkflowSubagent(flow,'分析员','main',{id:'unavailable-preset',name:'preset',prompt:'角色快照一',revision:1});bindNodeSubagent(flow,node.id,definition,'main')
    const saved=storage.save(flow,0),waiting=runtime.start(saved.id,{},undefined,{sessionId:'main'})
    expect(waiting.status).toBe('waiting');expect(waiting.rolePrompts![node.id]).toBe('角色快照一')
    const edited=storage.get(saved.id);edited.subAgents![0]!.prompt='角色快照二';storage.save(edited,edited.revision)
    runtime.answer(waiting.id,{text:'任务一'});const first=await runtime.settle(waiting.id)
    expect(first.status).toBe('success');expect(calls[0]!.rolePrompt).toBe('角色快照一')
    expect(first.executions.find(item=>item.nodeId===node.id)).toMatchObject({subagentDefinitionId:definition.id,subagentId:'native-1'})
    const second=await runtime.settle(runtime.start(saved.id,{text:'任务二'},undefined,{sessionId:'main'}).id)
    expect(second.status).toBe('success');expect(calls[1]!.rolePrompt).toBe('角色快照二')
    expect(second.executions.find(item=>item.nodeId===node.id)).toMatchObject({subagentDefinitionId:definition.id,subagentId:'native-2'})
    expect(()=>runtime.start(saved.id,{text:'foreign'},undefined,{sessionId:'other'})).toThrow('其他主对话')
  })
  it('binds dependency definitions atomically and preserves every graph if a later child conflicts',()=>{
    const path=mkdtempSync(join(tmpdir(),'workflow-subagent-dependencies-')),storage=new WorkflowStorage(path)
    try{
      const graph=(name:string,sessionId?:string)=>{const flow=makeWorkflow('w',name,true),node=flow.nodes[1]!;node.kind='agent';node.config={prompt:'Task',model:{provider:'p',model:'m'}};bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,name,sessionId),sessionId);return storage.save(flow,0)}
      const child=graph('Child'),conflict=graph('Other child','other'),root=graph('Root')
      root.nodes[1]!.config.tools=[`workflow:${child.id}`,`workflow:${conflict.id}`]
      const parent=storage.save(root,root.revision),before=storage.workflows()
      expect(()=>storage.bindSubagents(parent.id,parent.revision,'main')).toThrow('其他主对话')
      expect(storage.workflows()).toEqual(before)
      parent.nodes[1]!.config.tools=[`workflow:${child.id}`];const ready=storage.save(parent,parent.revision)
      const bound=storage.bindSubagents(ready.id,ready.revision,'main')
      expect(bound.subAgents![0]!.sessionId).toBe('main');expect(storage.get(child.id).subAgents![0]!.sessionId).toBe('main')
      expect(storage.get(child.id).revision).toBe(child.revision+1)
      expect(()=>storage.bindSubagents(bound.id,bound.revision,'other')).toThrow('其他主对话')
    }finally{storage.close();rmSync(path,{recursive:true,force:true})}
  })
})
