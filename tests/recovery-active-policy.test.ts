import {describe,expect,it} from 'vitest'
import {activeExecutionPolicy} from '../src/shared/execution-policy.ts'
import {buildRecoveryPlan,workflowSemanticDigest} from '../src/host/recovery-plan.ts'
import {makeWorkflow,type Workflow,type WorkflowRun} from '../src/shared/types.ts'

const legacyPolicy={tokenBudget:1,perTaskTokens:1,maxAgentTasks:1}
function history(graph:Workflow):WorkflowRun{return{id:'source',workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,status:'failed',inputs:{text:'x'},outputs:{result:'x'},startedAt:'2026-10-19T00:00:00.000Z',executions:graph.nodes.map(node=>({nodeId:node.id,executionId:node.id,number:node.number,title:node.title,status:'success',data:{text:'x'},startedAt:'2026-10-19T00:00:00.000Z'}))}}
function childCaller(){
  const child=makeWorkflow('workspace','Deterministic child',true),parent=makeWorkflow('workspace','Cached caller',true)
  parent.nodes[1]!.kind='tool';parent.nodes[1]!.config={toolId:`workflow:${child.id}`,inputs:{text:'x'},cache:'reuse'}
  const source=history(parent);source.dependencySnapshots={[child.id]:child}
  return {child,parent,source,nodeId:parent.nodes[1]!.id}
}

describe('active safeguard semantics after execution quota removal',()=>{
  it('treats absent, empty, legacy-only and explicit defaults as the same effective policy without mutating graphs',()=>{
    const flow=makeWorkflow('workspace','Policy baseline',true),before=JSON.stringify(flow)
    const variants=[undefined,{},legacyPolicy,{maxConcurrentAgents:3,repairMode:'auto' as const,maxRepairAttempts:2}]
    const digests=variants.map(policy=>workflowSemanticDigest({...flow,executionPolicy:policy}))
    expect(new Set(digests).size).toBe(1)
    expect(activeExecutionPolicy(legacyPolicy)).toEqual({maxConcurrentAgents:3,repairMode:'auto',maxRepairAttempts:2})
    expect(JSON.stringify(flow)).toBe(before)
  })

  it('reuses the exact completed cached child receipt after only retired child quotas change',()=>{
    const {child,parent,source,nodeId}=childCaller()
    child.executionPolicy=legacyPolicy
    const before=JSON.stringify(source),base=buildRecoveryPlan(source,'resume')
    expect(base.allowed).toBe(true)
    for(const policy of [undefined,{}, {...legacyPolicy,tokenBudget:999,perTaskTokens:888,maxAgentTasks:777}]){
      const next=structuredClone(child);next.executionPolicy=policy
      const plan=buildRecoveryPlan(source,'resume',parent,{dependencySnapshots:{[child.id]:next}})
      expect(plan.allowed).toBe(true)
      expect(plan.planDigest).toBe(base.planDigest)
      expect(plan.items.find(item=>item.nodeId===nodeId)?.action).toBe('reuse')
    }
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each([
    {maxConcurrentAgents:1},
    {repairMode:'confirm' as const},
    {maxRepairAttempts:0},
  ])('still invalidates a cached external caller for a changed child safeguard %j',policy=>{
    const {child,parent,source,nodeId}=childCaller(),next=structuredClone(child)
    next.executionPolicy=policy
    const base=buildRecoveryPlan(source,'resume'),changed=buildRecoveryPlan(source,'resume',parent,{dependencySnapshots:{[child.id]:next}})
    expect(changed.allowed).toBe(false);expect(changed.planDigest).not.toBe(base.planDigest)
    expect(changed.items.find(item=>item.nodeId===nodeId)).toMatchObject({action:'blocked',reviewCanComplete:false,reason:expect.stringContaining('已完成的外部操作不能自动重放')})
  })

  it('ignores old ceilings and token estimates in the confirmation digest while retaining actual usage and receipt evidence',()=>{
    const source=history(makeWorkflow('workspace','Usage history',true))
    source.usage={spentTokens:7,unknownCalls:1,calls:2,agentTasks:1,reservedTokens:100,unknownTokens:200,limit:300,allocations:{known:{tokens:100,status:'settled',usage:7},unknown:{tokens:200,status:'unknown'}}}
    const base=buildRecoveryPlan(source,'resume').planDigest,next=structuredClone(source)
    next.usage!.limit=1;next.usage!.reservedTokens=999;next.usage!.unknownTokens=888
    next.usage!.allocations.known!.tokens=777;next.usage!.allocations.unknown!.tokens=666
    expect(buildRecoveryPlan(next,'resume').planDigest).toBe(base)
    for(const mutate of [
      (value:WorkflowRun)=>{value.usage!.spentTokens++},
      (value:WorkflowRun)=>{value.usage!.unknownCalls++},
      (value:WorkflowRun)=>{value.usage!.calls++},
      (value:WorkflowRun)=>{value.usage!.allocations.known!.usage=8},
      (value:WorkflowRun)=>{value.usage!.allocations.unknown!.status='settled'},
      (value:WorkflowRun)=>{value.usage!.allocations.newReceipt={tokens:0,status:'unknown'}},
    ]){
      const changed=structuredClone(next);mutate(changed)
      expect(buildRecoveryPlan(changed,'resume').planDigest).not.toBe(base)
    }
  })

  it('retains root-child ownership and protected-operation recovery restrictions',()=>{
    const {source}=childCaller();source.rootRunId='exact-root'
    expect(buildRecoveryPlan(source,'resume').blockedReasons).toContain('子工作流必须从所属根运行恢复，避免绕过根运行协调或重放动作')
    delete source.rootRunId
    source.graph.nodes[1]!.kind='http';source.graph.nodes[1]!.config={credentialOperation:{secretVariableId:'credential',operationId:'deepseek.account-status.v1'},cache:'reuse'}
    const plan=buildRecoveryPlan(source,'resume')
    expect(plan.allowed).toBe(false)
    expect(plan.items.find(item=>item.nodeId===source.graph.nodes[1]!.id)).toMatchObject({action:'blocked',reviewCanComplete:false,reason:expect.stringContaining('重新核验当前授权')})
  })
})
