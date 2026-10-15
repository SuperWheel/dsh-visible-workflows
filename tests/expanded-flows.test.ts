import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validationFlows } from '../scripts/create-web-validation-flows.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { createExecutionAdapters, httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'

const instances:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const {runtime,directory} of instances.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})
function setup(){
 const directory=mkdtempSync(join(tmpdir(),'vdw-full-flow-')),storage=new WorkflowStorage(directory)
 const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async()=>{throw new Error('This fixture must not invoke external tools')},runWorkflow:async()=>{throw new Error('Not part of this fixture')},http:httpRequest})
 const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('This fixture must run without a model')}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}))
 instances.push({runtime,directory});for(const f of validationFlows('builtin:time.now'))storage.save(f,0)
 return {runtime,storage}
}
describe('多类节点真实执行链（无模型与网络）',()=>{
 it('隔离 JavaScript → 类型化列表 → 嵌套迭代 → 人工确认 → 真实时间工具',async()=>{
  const {runtime}=setup(),run=runtime.start('vdw_validation_data',{})
  const waiting=await runtime.settle(run.id)
  expect(waiting.status).toBe('waiting');expect(waiting.waitingNodeId).toBe('verify_human')
  expect(waiting.executions.find(e=>e.nodeId==='verify_time')?.status).toBe('pending')
  expect(waiting.executions.find(e=>e.nodeId==='verify_iteration')?.data?.result).toEqual(['第 0 项：2','第 1 项：4','第 2 项：6'])
  const codeStarted=waiting.executions.find(e=>e.nodeId==='verify_code')!.startedAt
  runtime.answer(run.id,{__action:'approve',feedback:'已检查'})
  const done=await runtime.settle(run.id)
  expect(done.status).toBe('success');expect(done.outputs.result).toContain('已检查')
  expect(done.executions.find(e=>e.nodeId==='verify_revise')?.status).toBe('skipped')
  expect(done.executions.find(e=>e.nodeId==='verify_code')?.startedAt).toBe(codeStarted)
  expect(Number(done.executions.find(e=>e.nodeId==='verify_time')?.data?.timestamp)).toBeGreaterThan(1_700_000_000)
  expect(()=>runtime.answer(run.id,{__action:'approve'})).toThrow()
 })
 it('循环状态累加，第三轮退出并返回容器外',async()=>{
  const {runtime}=setup(),run=runtime.start('vdw_validation_loop',{})
  const done=await runtime.settle(run.id)
  expect(done.status).toBe('success');expect(done.outputs.result).toBe('最终计数：3；执行轮数：3')
  expect(done.executions.filter(e=>e.nodeId==='verify_add'&&e.status==='success')).toHaveLength(3)
  expect(done.executions.find(e=>e.nodeId==='verify_exit'&&e.status==='success')).toBeTruthy()
 })
})
