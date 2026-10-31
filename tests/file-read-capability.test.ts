import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeWorkflow,type ToolChoice} from '../src/shared/types.ts'
import {inspectWorkflowReadiness,type WorkflowReadinessContext} from '../src/host/workflow-readiness.ts'
import {createNativeAgentExecutor} from '../src/host/native-agent.ts'
import type {AdapterRequest} from '../src/host/runtime.ts'

const directories:string[]=[]
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'file-read-capability-'));directories.push(directory)
  writeFileSync(join(directory,'source.txt'),'synthetic source')
  const flow=makeWorkflow('workspace','read evidence',true),node=flow.nodes[1]!
  node.kind='agent';node.config={subagentId:'reader',model:{provider:'host',model:'configured'},tools:['native:read'],verification:{requiredReadFiles:['source.txt']}}
  flow.subAgents=[{id:'reader',number:'agent-1',name:'Reader',prompt:'Read the source'}]
  const tool:ToolChoice={id:'native:read',name:'read',description:'The name does not attest ownership',providerId:'native:harness',providerName:'Harness',category:'plugin',inputSchema:{type:'object'},available:true}
  const context:WorkflowReadinessContext={workspaceRoot:directory,catalog:{models:[{provider:'host',model:'configured',label:'Configured',efforts:[]}],tools:[tool],workflows:[],presets:[]}}
  return {flow,node,context}
}
it('rejects required reading before execution even when the file and a same-named tool exist',async()=>{
  const {flow,node,context}=fixture(),report=await inspectWorkflowReadiness(flow,context)
  expect(report.canRun).toBe(false)
  expect(report.issues).toContainEqual(expect.objectContaining({nodeId:node.id,kind:'configuration',field:'verification.requiredReadFiles',message:expect.stringContaining('可信读取')}))
})
it('allows an explicitly attested reader and does not block existence/change-only evidence',async()=>{
  const {flow,node,context}=fixture()
  const attested=await inspectWorkflowReadiness(flow,{...context,canVerifyFileReads:()=>true} as WorkflowReadinessContext)
  expect(attested.canRun).toBe(true)
  node.config.verification={requiredFiles:['result.txt'],requiredChangedFiles:['result.txt']}
  expect((await inspectWorkflowReadiness(flow,context)).canRun).toBe(true)
})
it('surfaces unavailable read evidence from a frozen child on its caller',async()=>{
  const {flow:child,context}=fixture(),parent=makeWorkflow('workspace','caller',true),caller=parent.nodes[1]!
  caller.kind='tool';caller.config={toolId:`workflow:${child.id}`,inputs:{text:'test'}}
  const report=await inspectWorkflowReadiness(parent,{...context,dependencySnapshots:{[child.id]:child}})
  expect(report.canRun).toBe(false)
  expect(report.issues).toContainEqual(expect.objectContaining({nodeId:caller.id,workflowId:child.id,field:'verification.requiredReadFiles'}))
})
it('rejects a direct native execution before parent, provider or model dispatch without attestation',async()=>{
  const {node}=fixture(),subagents=vi.fn(),createParent=vi.fn(),usage=vi.fn()
  const executor=createNativeAgentExecutor({ctx:{on:vi.fn()} as any,subagents,parentForRun:()=>undefined,createParent,nativeTools:()=>['read']})
  const request:AdapterRequest={node,inputs:{},workspaceId:'workspace',runId:'run',signal:new AbortController().signal,backend:{generate:vi.fn()},onUsage:usage}
  await expect(executor(request)).rejects.toThrow('可信读取')
  expect(subagents).not.toHaveBeenCalled();expect(createParent).not.toHaveBeenCalled()
  expect(request.backend.generate).not.toHaveBeenCalled();expect(usage).toHaveBeenCalledWith({totalTokens:0})
})
