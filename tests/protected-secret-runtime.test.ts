import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ExecutionAdapters } from '../src/host/runtime.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
function setup(adapters:ExecutionAdapters,required=true){
  const directory=mkdtempSync(join(tmpdir(),'protected-workflow-')),storage=new WorkflowStorage(directory),backend={generate:vi.fn(async()=>{throw new Error('No model in this fixture')})}
  const runtime=new WorkflowRuntime(storage,backend,adapters),flow=makeWorkflow('workspace','Secret boundary fixture',true)
  flow.environmentVariables=[{id:'secret-id',name:'API_KEY',type:'secret',required}]
  flow.nodes[1]!.kind='http';flow.nodes[1]!.config={credentialOperation:{secretVariableId:'secret-id',operationId:'deepseek.account-status.v1'}}
  flow.nodes[2]!.config={text:`{{${flow.nodes[1]!.id}.status_code}}`}
  const saved=storage.save(flow,0)
  cleanups.push(async()=>{await runtime.close();rmSync(directory,{recursive:true,force:true})})
  return {storage,runtime,saved,backend}
}
it('checks a required Secret before any graph action and stores only public declarations on failure',async()=>{
  const execute=vi.fn(),secretPreflight=vi.fn(async()=>{throw new Error('凭据未配置')})
  const f=setup({execute,secretPreflight}),run=f.runtime.start(f.saved.id,{text:'hello'}),done=await f.runtime.settle(run.id)
  expect(done.status).toBe('failed');expect(done.error).toBe('凭据未配置')
  expect(execute).not.toHaveBeenCalled();expect(f.backend.generate).not.toHaveBeenCalled()
  expect(secretPreflight).toHaveBeenCalledOnce();expect(done.environment).toEqual({})
  expect(done.executions.every(e=>e.status==='skipped')).toBe(true)
})
it('also refuses optional protected operations when a runtime has no protected preflight',async()=>{
  const execute=vi.fn(),f=setup({execute},false),run=f.runtime.start(f.saved.id,{text:'hello'})
  expect((await f.runtime.settle(run.id)).error).toContain('受保护凭据代理')
  expect(execute).not.toHaveBeenCalled()
})
it('passes only public operation metadata and retains no secret in inputs, environment or results',async()=>{
  const execute=vi.fn(async()=>({ok:true,status_code:200})),secretPreflight=vi.fn(async()=>{})
  const f=setup({execute,secretPreflight}),run=f.runtime.start(f.saved.id,{text:'hello'}),done=await f.runtime.settle(run.id)
  expect(done.status).toBe('success');expect(done.outputs.result).toBe('200');expect(done.environment).toEqual({})
  expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]![1].inputs).toEqual({})
  const record=done.executions.find(e=>e.nodeId===f.saved.nodes[1]!.id)!
  expect(JSON.parse(record.input!)).toEqual({credentialOperation:{secretVariableId:'secret-id',operationId:'deepseek.account-status.v1'}})
  expect(record.data).toEqual({ok:true,status_code:200})
})
it('the existing HTTP adapter selects only the broker branch and fails closed without one',async()=>{
  const catalog=new ToolCatalog({directory:tmpdir(),workflows:()=>[],nativeTools:()=>[],executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>{throw new Error('ordinary HTTP must not be called')}})
  const protectedHttp=vi.fn(async()=>({ok:true,status_code:204})),adapters=createExecutionAdapters({catalog,workspaceRoot:()=>tmpdir(),protectedHttp})
  const request={node:{id:'node',kind:'http',config:{credentialOperation:{secretVariableId:'secret-id',operationId:'deepseek.account-status.v1'}}},inputs:{},signal:new AbortController().signal} as any
  expect(await adapters.execute('http',request)).toEqual({ok:true,status_code:204})
  expect(protectedHttp).toHaveBeenCalledOnce()
  await expect(createExecutionAdapters({catalog,workspaceRoot:()=>tmpdir()}).execute('http',request)).rejects.toThrow('受保护凭据代理')
})
