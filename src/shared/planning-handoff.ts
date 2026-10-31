import { compilePlanningChain } from './planning-chain.ts'
import type { PlanningContext, PlanningIssue } from './planning-types.ts'
import type { Workflow } from './types.ts'
import { allNodes } from './workflow-validation.ts'
import { compilePlanningEdits, planningEditDigest, planningEditView, planningNodeRefs, planningUpdateLocals, rewritePlanningConfig } from './planning-edits.ts'
import { CompilerError, jsonDigest } from './planning-repair.ts'
import { verifiedModuleInstances } from './planning-module-fragments.ts'
import type { PlanningContextSelection } from './planning-context-slice.ts'

export { planningHandoffSchema, type PlanningHandoff } from './planning-handoff-contract.ts'
import type { PlanningHandoff } from './planning-handoff-contract.ts'

export function handoffSelection(handoff:PlanningHandoff):PlanningContextSelection|undefined{
  if(handoff.mode==='module')return undefined
  if(handoff.mode==='chain')return {targetNodeIds:handoff.chain.nodeIds??[handoff.chain.anchorNodeId],topologyChanged:true,outputChanged:true}
  const rows=handoff.mode==='partial'?handoff.unresolved:handoff.changes.map(item=>({nodeId:item.nodeId,fields:[item.op==='set-title'?'title':item.field]}))
  const targetFields:Record<string,string[]>={}
  for(const row of rows)targetFields[row.nodeId]=[...new Set([...(targetFields[row.nodeId]??[]),...row.fields])]
  return {targetNodeIds:Object.keys(targetFields),targetFields,outputChanged:rows.some(row=>row.fields.some(name=>['fields','outputSchema','outputs','outputVariable'].includes(name)))}
}

export const NEW_NODE_REFERENCE_HINT='；若它是另一个还没接受的提案里新增的节点，已保存图里还没有它：改用一次 visible_workflow_splice，同一组 operations 里先 insert 新节点，再 update 引用它的已有节点（values 用新节点 key 引用，ID 不变，不需要 exports），合成一个提案'

/** Reuses the canonical edit materializer; no save, permission or graph-validation bypass. */
export function compileHandoffChanges(handoff:Exclude<PlanningHandoff,{mode:'module'}>,context:PlanningContext){
  if(handoff.mode==='chain')return compilePlanningChain(handoff.chain,context)
  if(context.operation!=='revise')throw new CompilerError('HANDOFF_OPERATION','确定字段修改仅用于已有工作流')
  const base=context.workflow,refs=planningNodeRefs(base),nodes=new Map(allNodes(base).map(node=>[node.id,node]))
  const maps={nodes:new Map(refs),agents:new Map((base.subAgents??[]).map((item,index)=>[item.id,`@a${index+1}`])),environment:new Map((base.environmentVariables??[]).map((item,index)=>[item.id,`@e${index+1}`]))}
  for(const id of new Set([...handoff.changes.map(item=>item.nodeId),...(handoff.mode==='partial'?handoff.unresolved.map(item=>item.nodeId):[])])){
    if(!nodes.has(id))throw new CompilerError('HANDOFF_NODE_MISSING',`目标节点不存在：${id}`)
    if(context.targetNodeIds.length&&!context.targetNodeIds.includes(id))throw new CompilerError('TARGET_SCOPE',`目标不在授权范围内：${id}`)
    if(nodes.get(id)!.fixed)throw new CompilerError('FIXED_NODE',`固定节点不能修改：${id}`)
  }
  const scopes=new Map(planningEditView(context).nodes.map(row=>[row.ref,row.scope]))
  // The edit view collapses verified module instances; their internals change only through module parameters.
  for(const id of new Set([...handoff.changes.map(item=>item.nodeId),...(handoff.mode==='partial'?handoff.unresolved.map(item=>item.nodeId):[])])){
    if(scopes.has(refs.get(id)!))continue
    const instance=verifiedModuleInstances(base).find(item=>Object.values(item.roles).includes(id))
    if(instance)throw new CompilerError('MODULE_INTERNAL_NODE',`节点 ${id} 属于模块实例 ${instance.instanceKey}（${instance.moduleId}@${instance.version}）的固定实现，不能逐字段修改；请改用 visible_workflow_plan 的 operation:revise 与 handoff:{version:1,mode:'module',module:{moduleId:'${instance.moduleId}',version:'${instance.version}',instanceKey:'${instance.instanceKey}',parameters}}，只修改实例参数。当前参数：${JSON.stringify(instance.parameters)}`)
    throw new CompilerError('HANDOFF_NODE_MISSING',`目标节点不可按字段修改：${id}`)
  }
  const updates=new Map<string,{op:'update-node';node:string;scope:string[];title?:string;configSet?:Record<string,unknown>;configUnset?:string[]}>()
  for(const item of handoff.changes){
    const update=updates.get(item.nodeId)??{op:'update-node',node:refs.get(item.nodeId)!,scope:scopes.get(refs.get(item.nodeId)!)!}
    if(item.op==='set-title')update.title=item.value
    else if(item.op==='unset-config')update.configUnset=[...(update.configUnset??[]),item.field]
    else update.configSet={...update.configSet,[item.field]:item.value}
    updates.set(item.nodeId,update)
  }
  // Rewrite only after every field is known, so locals declared by the old
  // inputs, or by an inputs change in the same handoff, stay local.
  for(const[id,update]of updates)if(update.configSet){
    const node=nodes.get(id)!
    update.configSet=rewritePlanningConfig(update.configSet,maps,false,node.kind,'',planningUpdateLocals(node.config as Record<string,unknown>,update.configSet,update.configUnset)) as Record<string,unknown>
  }
  const coverage=[...new Set([...handoff.changes.map(item=>item.nodeId),...(handoff.mode==='partial'?handoff.unresolved.map(item=>item.nodeId):[])])]
  const result=compilePlanningEdits({protocolVersion:1,baseDigest:planningEditDigest(base),outcome:'candidate',edits:[...updates.values()],summary:'按主 Agent 已确定的字段变更编译',requirementCoverage:[{requirementId:'R1',nodeIds:coverage.map(id=>refs.get(id)!)}]},context)
  // Desktop r59 E: a node added by a proposal not yet accepted is not in the saved graph, so a separate field change cannot point at it.
  return {...result,issues:result.issues.map(issue=>issue.code==='INVALID_REFERENCE'&&issue.message.startsWith('节点引用 ')?{...issue,message:issue.message+NEW_NODE_REFERENCE_HINT}:issue)}
}

/** Only the explicitly unresolved fields may differ from the decided baseline. */
export function handoffCandidateIssues(handoff:PlanningHandoff|undefined,decided:Workflow|undefined,candidate:Workflow):PlanningIssue[]{
  if(!handoff||handoff.mode!=='partial'||!decided)return []
  const allowed=new Map<string,Set<string>>()
  for(const row of handoff.unresolved)allowed.set(row.nodeId,new Set([...(allowed.get(row.nodeId)??[]),...row.fields]))
  const mask=(workflow:Workflow)=>{
    const value=structuredClone(workflow)
    for(const node of allNodes(value))for(const field of allowed.get(node.id)??[]){delete (node.config as unknown as Record<string,unknown>)[field]}
    // Materialization may update its timestamp but cannot alter semantic host fields.
    value.updatedAt=decided.updatedAt
    return value
  }
  return jsonDigest(mask(decided))===jsonDigest(mask(candidate))?[]:[{code:'HANDOFF_DECISION_CONFLICT',message:'子 Agent 修改了已确定决定或未决字段范围之外的内容'}]
}
