import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { makeWorkflow } from '../src/shared/types.ts'

it('shares model admission between a held planner slot and the actual runtime dispatch',async()=>{
  const path=mkdtempSync(join(tmpdir(),'workflow-shared-admission-')),storage=new WorkflowStorage(path),admission=new ModelAdmission(1)
  const releasePlanner=await admission.acquire('planning-task',1,new AbortController().signal,'workspace'),acquire=vi.spyOn(admission,'acquire')
  const generate=vi.fn(async()=>'runtime result')
  const runtime=new WorkflowRuntime(storage,{generate},undefined,undefined,{admission})
  try{
    const flow=makeWorkflow('workspace','Shared slot',true);flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={prompt:'{{input.text}}',model:{provider:'fixture',model:'offline'}}
    const saved=storage.save(flow,0),run=runtime.start(saved.id,{text:'input'})
    await vi.waitFor(()=>{
      const current=storage.run(run.id)
      expect(current.status,current.error??'runtime must reach model admission').not.toBe('failed')
      expect(acquire).toHaveBeenCalled()
    },{timeout:10_000})
    expect(generate).not.toHaveBeenCalled()
    releasePlanner()
    const done=await runtime.settle(run.id)
    expect(done.status).toBe('success');expect(generate).toHaveBeenCalledOnce();expect(done.outputs.result).toBe('runtime result')
  }finally{releasePlanner();await runtime.close();storage.close();rmSync(path,{recursive:true,force:true})}
})
