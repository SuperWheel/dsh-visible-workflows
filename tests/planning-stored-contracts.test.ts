import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WorkflowPlanningService, planningDigest, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { PlanningStore } from '../src/host/planning/store.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { storedReviewCandidate } from './fixtures/stored-review-candidate.ts'
import {workspaceChangeVerification} from '../src/host/planning/command-brief.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(state:'ready'|'publishing'|'published',committed=state!=='ready',change?:(task:PlanningTask)=>void){
  const directory=mkdtempSync(join(tmpdir(),'planning-stored-contracts-'));directories.push(directory)
  const task=storedReviewCandidate(state)
  expect(planningCandidateIssues(task.candidate!,task.context!)).toContainEqual(expect.objectContaining({code:'REVIEW_BEFORE_EFFECT',path:'config.inputs.file_path'}))
  change?.(task)
  new PlanningStore<PlanningTask>(directory).write([task])
  const generate=vi.fn(async()=>{throw new Error('No model calls allowed')}),publish=vi.fn(async()=>{throw new Error('No publication allowed')})
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,driver:{generate},admission:new ModelAdmission(2,2),context:async()=>task.context!,authorize:()=>{},readiness:async()=>{throw new Error('No readiness calls allowed')},publish,
    receipt:()=>committed&&task.commit?{...task.commit,kind:'created',workflowId:task.candidate!.id,revision:1}:undefined}
  const caller={parent:{id:'main'},sessionId:'main',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
  const open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  return {directory,task,caller,generate,publish,open,options}
}
const changedContract=expect.objectContaining({code:'STORED_CANDIDATE_CONTRACT_CHANGED',message:expect.stringContaining('REVIEW_BEFORE_EFFECT')})

describe('historical planning content contracts',()=>{
  it.each(['published','publishing'] as const)('reads a committed %s T05 candidate and never publishes it again',async state=>{
    const f=fixture(state),service=f.open(),restored=service.get(f.task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.candidate).toEqual(f.task.candidate);expect(restored.candidateDigest).toBe(f.task.candidateDigest)
    expect(restored).not.toHaveProperty('workspaceSnapshot')
    expect(workspaceChangeVerification(restored)).toBeUndefined()
    expect(restored.commit).toEqual(f.task.commit);expect(restored.receipt?.digest).toBe(f.task.candidateDigest)
    expect(restored.diagnostics).toContainEqual(changedContract)
    expect(restored.diagnostics.at(-1)!.message).toContain('config.inputs.file_path');expect(restored.diagnostics.at(-1)!.message.length).toBeLessThanOrEqual(2000)
    if(state==='published'){expect(restored.revision).toBe(f.task.revision);expect(restored.events).toEqual(f.task.events)}
    expect(await service.publish(restored.id,restored.revision,restored.candidateDigest!,f.caller)).toEqual(restored)
    const before=readFileSync(join(f.directory,'planning/tasks.json'),'utf8')
    expect(f.open().get(restored.id,f.caller)).toEqual(restored)
    expect(readFileSync(join(f.directory,'planning/tasks.json'),'utf8')).toBe(before)
    expect(f.generate).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
  })

  it.each(['ready','publishing','published'] as const)('blocks a %s candidate without canonical commit evidence and forbids publication',async state=>{
    const f=fixture(state,false),service=f.open(),restored=service.get(f.task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics).toContainEqual(changedContract)
    if(state!=='ready')expect(restored.diagnostics).toContainEqual(expect.objectContaining({code:'PUBLISH_UNCERTAIN'}))
    expect(restored.candidate).toEqual(f.task.candidate);expect(restored.candidateDigest).toBe(f.task.candidateDigest)
    await expect(service.publish(restored.id,restored.revision,restored.candidateDigest!,f.caller)).rejects.toThrow('版本已变化')
    expect(f.open().get(restored.id,f.caller).state).toBe('blocked')
    expect(f.generate).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled()
  })

  it('keeps bounded diagnostics readable after recovering an uncertain publication',()=>{
    const f=fixture('publishing',false,task=>{task.diagnostics=Array.from({length:1000},()=>({code:'OLD_DIAGNOSTIC',message:'Historical diagnostic'}))})
    const restored=f.open().get(f.task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics).toHaveLength(1000)
    expect(restored.diagnostics).toContainEqual(changedContract)
    expect(f.open().get(f.task.id,f.caller)).toEqual(restored)
  })

  it.each(['digest','ownership'] as const)('still fails closed for a candidate %s mismatch despite a content-contract issue',kind=>{
    const f=fixture('published',true,task=>{if(kind==='digest')task.candidateDigest='0'.repeat(64);else{task.candidate!.workspaceId='other';task.candidateDigest=planningDigest(task.candidate)}})
    const before=readFileSync(join(f.directory,'planning/tasks.json'),'utf8')
    expect(f.open).toThrow('规划候选归属或摘要无效')
    expect(readFileSync(join(f.directory,'planning/tasks.json'),'utf8')).toBe(before)
  })

  it('still fails closed for a canonical receipt digest mismatch',()=>{
    const f=fixture('published')
    f.options.receipt=()=>({...f.task.receipt!,digest:'0'.repeat(64)})
    expect(f.open).toThrow('规划回执归属或摘要冲突')
  })

  it('boots the full Host and registers tools with a historical T05 store',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-startup-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
    expect(JSON.parse(stdout.trim())).toEqual({active:true,published:true,toolsRegistered:true,commandRegistered:true,modelCalls:0})
  },35_000)
})
