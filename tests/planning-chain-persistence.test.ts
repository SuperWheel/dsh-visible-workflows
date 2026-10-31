import { afterEach,describe,expect,it,vi } from 'vitest'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowPlanningService,planningDigest,type PlanningCaller,type PlanningTask } from '../src/host/planning/service.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { planningChainDigest } from '../src/shared/planning-chain.ts'
import { planningChainRequestSchema } from '../src/shared/planning-chain-contract.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import type { PlanningRequest } from '../src/shared/planning-types.ts'
const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'chain-persistence-'));directories.push(directory)
  const base=templateContext();base.operation='revise';base.workflow.revision=1
  base.workflow.nodes.splice(1,0,{id:'old-text',number:'a-2',kind:'template',title:'Original',x:200,y:0,fixed:false,config:{text:'Old'}})
  base.workflow.edges=[{id:'in',source:'host-start',target:'old-text'},{id:'out',source:'old-text',target:'host-end'}]
  const caller:PlanningCaller={parent:{id:'owner'} as Agent,sessionId:'owner',workspaceId:'workspace',signal:new AbortController().signal}
  const receipts=new Map<string,PlanningReceipt>()
  const generate=vi.fn(async()=>{throw Error('Chain handoff must not call a model')})
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,compilerMode:'compact-repair',admission:new ModelAdmission(2),driver:{generate},context:async request=>({...structuredClone(base),targetNodeIds:request.targetNodeIds??[]}),authorize:(task,owner)=>{if(task.workspaceId!==owner.workspaceId||task.sessionId!==owner.sessionId)throw Error('FORBIDDEN')},readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),publish:vi.fn(async(flow,task,_caller,commit)=>{receipts.set(commit.key,{...commit,kind:'proposed',workflowId:flow.id,revision:flow.revision,proposalId:'proposal-'+task.id})}),receipt:key=>receipts.get(key)}
  const request:PlanningRequest={requestId:'chain-test',operation:'revise',instruction:'在原节点后新增已决定的模板',targetWorkflowId:base.workflow.id,expectedRevision:1,targetNodeIds:['old-text'],preview:true,handoff:{version:3,mode:'chain',constraints:[],evidenceRefs:[],chain:planningChainRequestSchema.parse({version:1,baseDigest:planningChainDigest(base.workflow),baseRevision:1,chainKey:'a',anchorNodeId:'old-text',operations:[{op:'insert',draftRevision:0,target:'a-2',position:'after',nodes:[{key:'newText',template:'template',values:{text:'New'}}]}]})}}
  const reopen=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  return {directory,caller,request,reopen,options,generate,receipts}
}
describe('chain handoff uses the existing proposal task, review and restoration contract',()=>{
  it('persists the exact candidate and alias map; a recovered direct handoff makes zero model calls',async()=>{
    const f=fixture(),service=f.reopen(),task=await service.start(f.request,f.caller)
    expect(task.state).toBe('ready');expect(task.chainState!.mapping.map(row=>row.standardAlias)).toEqual(['a-1','a-2','a-3','a-4'])
    expect(f.generate).not.toHaveBeenCalled();expect(f.options.publish).not.toHaveBeenCalled()
    const published=await service.publish(task.id,task.revision,task.candidateDigest!,f.caller)
    expect(published.state).toBe('published');expect(published.candidate).toEqual(task.candidate)
    await service.close()
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.candidate).toEqual(task.candidate);expect(restored.chainState).toEqual(task.chainState);expect(restored.state).toBe('published')
    expect(f.generate).not.toHaveBeenCalled()
  })
  it.each(['alias-map','candidate-content','old-identity','boundary-edge'] as const)('blocks restored %s tampering even with an updated candidate digest',async fault=>{
    const f=fixture(),service=f.reopen(),task=await service.start(f.request,f.caller)
    expect(task.state).toBe('ready');const published=await service.publish(task.id,task.revision,task.candidateDigest!,f.caller);expect(published.state).toBe('published');await service.close()
    const file=join(f.directory,'planning/tasks.json'),data=JSON.parse(readFileSync(file,'utf8')) as {tasks:PlanningTask[]},saved=data.tasks.find(row=>row.id===task.id)!
    saved.state='ready';delete saved.commit;delete saved.receipt;f.receipts.clear()
    vi.mocked(f.options.publish).mockClear()
    if(fault==='alias-map')saved.chainState!.mapping[1]!.actualNumber='forged'
    if(fault==='candidate-content')saved.candidate!.nodes.find(node=>node.id==='old-text')!.config.text='Tampered'
    if(fault==='old-identity')saved.candidate!.nodes.find(node=>node.id==='old-text')!.id='allocated-5'
    if(fault==='boundary-edge')saved.candidate!.edges[0]!.id='rewritten-edge-id'
    saved.candidateDigest=planningDigest(saved.candidate);writeFileSync(file,JSON.stringify(data))
    const restored=f.reopen().get(task.id,f.caller)
    expect(restored.state).toBe('blocked');expect(restored.diagnostics.at(-1)!.code).toBe('HANDOFF_CANDIDATE_INVALID')
    expect(f.generate).not.toHaveBeenCalled();expect(f.options.publish).not.toHaveBeenCalled()
  })
})
