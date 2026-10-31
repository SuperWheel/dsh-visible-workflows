import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { makeWorkflow, type WorkflowRun } from '../src/shared/types.ts'
import { reviewedRecovery } from '../src/host/recovery-review.ts'
function fixture():WorkflowRun{
  const graph=makeWorkflow('workspace','未知动作',true),node=graph.nodes[1]!
  node.kind='agent';node.config={prompt:'action',tools:[]}
  node.config.subagentId='worker';graph.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
  return {id:'source',workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:1,graph,status:'interrupted',inputs:{text:'x'},outputs:{},startedAt:'2026-10-17T00:00:00Z',executions:graph.nodes.map((item,index)=>({nodeId:item.id,executionId:item.id,title:item.title,number:item.number,status:index===0?'success':index===1?'failed':'pending',...(index===0?{data:{text:'x'},startedAt:'2026-10-17T00:00:00Z'}:index===1?{startedAt:'2026-10-17T00:00:01Z',error:'unknown'}:{})}))}
}
describe('explicit external action recovery review',()=>{
  it('allows only an explicit checked redo and keeps source history immutable',()=>{
    const source=fixture(),before=structuredClone(source),base=reviewedRecovery(source).plan,id=source.graph.nodes[1]!.id
    expect(base.allowed).toBe(false);expect(base.items.find(item=>item.executionId===id)?.reviewable).toBe(true)
    const result=reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'redo',evidence:'已检查测试服务，无完成回执，允许重做'}]})
    expect(result.plan.allowed).toBe(true);expect(result.plan.planDigest).not.toBe(base.planDigest);expect(result.plan.items.find(item=>item.executionId===id)?.action).toBe('rerun');expect(source).toEqual(before)
  })
  it('accepts a decision without a note, but still bounds a provided note',()=>{
    const source=fixture(),base=reviewedRecovery(source).plan,id=source.graph.nodes[1]!.id
    const result=reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'redo'}]})
    expect(result.plan.allowed).toBe(true);expect(result.review?.decisions[0]).toEqual({executionId:id,action:'redo'})
    expect(()=>reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'redo',evidence:'字'.repeat(4001)}]})).toThrow()
  })
  it('accepts validated user results without claiming independent verification',()=>{
    const source=fixture(),base=reviewedRecovery(source).plan,id=source.graph.nodes[1]!.id
    const result=reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'completed',evidence:'已核对回执 R-123',output:{text:'done'}}]})
    expect(result.plan.allowed).toBe(true);expect(result.plan.items.find(item=>item.executionId===id)?.action).toBe('reuse');expect(result.source.executions[1]).toMatchObject({status:'success',data:{text:'done'},verification:{status:'unverified'}});expect(source.executions[1]?.status).toBe('failed')
  })
  it('does not bypass stale plans, pure nodes, schema, or file evidence',()=>{
    const source=fixture(),base=reviewedRecovery(source).plan,id=source.graph.nodes[1]!.id,decision={executionId:id,action:'completed',evidence:'receipt',output:{text:'done'}}
    expect(()=>reviewedRecovery(source,{baseDigest:'0'.repeat(64),decisions:[decision]})).toThrow('依据已变化')
    expect(()=>reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{...decision,executionId:source.graph.nodes[0]!.id}]})).toThrow('不允许')
    expect(()=>reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{...decision,output:{wrong:true}}]})).toThrow('不符合结构')
    source.graph.nodes[1]!.config.verification={requiredFiles:['output.txt']}
    expect(()=>reviewedRecovery(source,{baseDigest:reviewedRecovery(source).plan.planDigest,decisions:[decision]})).toThrow(/不能通过手工结果跳过|绕过失效规则/)
  })
  it('abandon stays blocked and a successful invalidated result cannot be blessed as completed',()=>{
    const source=fixture(),id=source.graph.nodes[1]!.id
    expect(reviewedRecovery(source,{baseDigest:reviewedRecovery(source).plan.planDigest,decisions:[{executionId:id,action:'abandon',evidence:'放弃'}]}).plan.allowed).toBe(false)
    source.executions[1]!.status='success';source.executions[1]!.data={text:'old'}
    expect(()=>reviewedRecovery(source,{baseDigest:reviewedRecovery(source).plan.planDigest,decisions:[{executionId:id,action:'completed',evidence:'same',output:{text:'old'}}]})).toThrow('绕过失效规则')
  })
  it('cannot bless an unknown action whose runtime identity or upstream context has expired',()=>{
    for(const changed of ['identity','upstream']){
      const source=fixture(),id=source.graph.nodes[1]!.id
      if(changed==='identity')source.graph.nodes[1]!.config.prompt='action {{sys.workflow_run_id}}'
      else source.executions[0]!.status='failed'
      const base=reviewedRecovery(source).plan
      expect(base.items.find(item=>item.executionId===id)?.reviewCanComplete).toBe(false)
      expect(()=>reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'completed',evidence:'receipt',output:{text:'old'}}]})).toThrow('绕过失效规则')
      expect(reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{executionId:id,action:'redo',evidence:'allow repeat'}]}).plan.items.find(item=>item.executionId===id)?.action).toBe('rerun')
    }
  })
  it('persists review only in the new run and never repeats an action confirmed complete',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'recovery-reviewed-')),storage=new WorkflowStorage(directory)
    let calls=0
    const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('unexpected model')}},{execute:async()=>{calls++;return {text:'should not run'}}})
    try{
      const source=fixture();source.graph.nodes[1]!.config.model={provider:'fixture',model:'fixture'};source.graph=storage.save(source.graph,0);source.sourceRevision=source.graph.revision;storage.saveRun(source)
      const original=storage.run(source.id),base=runtime.recoveryPlan(source.id),id=source.graph.nodes[1]!.id
      const review={baseDigest:base.planDigest,decisions:[{executionId:id,action:'completed' as const,evidence:'回执 R-123',output:{text:'confirmed'}}]},plan=runtime.recoveryPlan(source.id,review)
      const recovered=runtime.recover(source.id,'resume',undefined,plan.planDigest,review),done=await runtime.settle(recovered.id)
      expect(done.status).toBe('success');expect(done.outputs.result).toBe('confirmed');expect(calls).toBe(0);expect(done.recoveryReview).toMatchObject({...review,sourceRunId:source.id});expect(storage.run(source.id)).toEqual(original)
    }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
  })
})
