import { z } from 'zod'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { PlanningContext, PlanningIssue } from './planning-types.ts'
import type { Workflow, NodeGraph } from './types.ts'
import type { PlanningHandoff } from './planning-handoff-contract.ts'
import { allNodes, workflowNodeConfigSchema } from './workflow-validation.ts'
import { planningNodeRefs } from './planning-edits.ts'
import { templateFieldSchema } from './planning-node-templates.ts'
import { continuationDigest } from './planning-continuation.ts'
import { CompilerError, pointer, type CompilerIssue } from './planning-repair.ts'

export interface PlanningCompletionPlan {
  readonly version:2
  readonly digest:string
  readonly entries:readonly {
    nodeId:string; key:string; field:string; require:'changed'|'present'; baselinePresent:boolean; baselineDigest?:string; wire:JsonSchemaNode
  }[]
}
const object=(properties:Record<string,JsonSchemaNode>):JsonSchemaNode=>({type:'object',properties,required:Object.keys(properties),additionalProperties:true})
const isObject=(value:any):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/** Host derives this once from the original authorization and decided baseline. Selection is never permission. */
export function handoffCompletionPlan(handoff:PlanningHandoff|undefined,context:PlanningContext,decided:Workflow):PlanningCompletionPlan|undefined {
  if(handoff?.version!==2)return
  if(context.operation!=='revise')throw new CompilerError('HANDOFF_OPERATION','完成义务仅用于已有工作流',undefined,true)
  const nodes=new Map(allNodes(decided).map(node=>[node.id,node])),original=new Map(allNodes(context.workflow).map(node=>[node.id,node])),refs=planningNodeRefs(context.workflow),fixed=new Set<string>()
  const visit=(graph:NodeGraph,ancestorFixed=false)=>{for(const node of graph.nodes){if(ancestorFixed||node.fixed)fixed.add(node.id);if(node.config.body)visit(node.config.body,ancestorFixed||node.fixed)}}
  visit(context.workflow)
  const entries=handoff.completion.map(item=>{
    const node=nodes.get(item.nodeId),before=original.get(item.nodeId),ref=refs.get(item.nodeId)
    if(!node||!before||!ref)throw new CompilerError('HANDOFF_NODE_MISSING','完成义务节点不存在',undefined,true)
    if(context.targetNodeIds.length&&!context.targetNodeIds.includes(item.nodeId))throw new CompilerError('TARGET_SCOPE','完成义务不在原授权范围',undefined,true)
    if(fixed.has(item.nodeId))throw new CompilerError('FIXED_NODE','完成义务不能修改固定节点或其子图',undefined,true)
    const source=z.toJSONSchema(workflowNodeConfigSchema(before.kind),{target:'draft-7',io:'input',unrepresentable:'any'}) as any
    if(!source.properties)throw new CompilerError('HANDOFF_COMPLETION_CONTRACT','当前节点的联合配置无法安全确定局部完成义务合同',undefined,true)
    if(['body','kind','title'].includes(item.field)||before.kind==='tool'&&item.field==='toolId'||!Object.hasOwn(source.properties,item.field))throw new CompilerError('HANDOFF_COMPLETION_FIELD','完成义务必须引用可填写的已知顶层 config 字段',undefined,true)
    const wire=(templateFieldSchema(source) as any).properties?.[item.field] as JsonSchemaNode|undefined
    if(!wire||!Object.keys(wire).length)throw new CompilerError('HANDOFF_COMPLETION_CONTRACT','完成义务字段没有可安全表达的类型合同',undefined,true)
    const baselinePresent=Object.hasOwn(node.config,item.field)
    return {...item,key:'n'+ref.slice(1),baselinePresent,...(baselinePresent?{baselineDigest:continuationDigest((node.config as any)[item.field])}:{}),wire}
  })
  return {version:2,entries,digest:continuationDigest({version:2,entries})}
}
/** Full graph/type validation remains authoritative; this adds only explicit completion obligations. */
export function completionCandidateIssues(plan:PlanningCompletionPlan|undefined,candidate:Workflow):PlanningIssue[]{
  if(!plan)return []
  const nodes=new Map(allNodes(candidate).map(node=>[node.id,node]))
  return plan.entries.flatMap(entry=>{
    const node=nodes.get(entry.nodeId),present=!!node&&Object.hasOwn(node.config,entry.field)
    const code=!present?'REQUIRED_FIELD_MISSING':entry.require==='changed'&&entry.baselinePresent&&continuationDigest((node!.config as any)[entry.field])===entry.baselineDigest?'REQUIRED_FIELD_UNCHANGED':undefined
    return code?[{code,nodeId:entry.nodeId,path:'config.'+entry.field,message:code==='REQUIRED_FIELD_MISSING'?'显式完成义务要求提供该字段':'显式完成义务要求该字段区别于已确定基线'}]:[]
  })
}
/** Narrow only existing authorized slots. Never synthesize an editable node or field absent from this frontend. */
export function completionNextSchema(schema:ObjectJsonSchema,plan:PlanningCompletionPlan|undefined,container:'set'|'values'):ObjectJsonSchema{
  if(!plan)return schema
  const result=structuredClone(schema),initial=(result.properties!.submission as any).oneOf[0],updates=initial.properties?.updates
  const required=plan.entries.filter(entry=>entry.require==='changed'||!entry.baselinePresent)
  if(!required.length)return result
  if(!updates?.properties)throw new CompilerError('HANDOFF_COMPLETION_SCHEMA','当前前端没有完成义务写入槽位',undefined,true)
  initial.required=[...new Set([...(initial.required??[]),'updates'])]
  for(const entry of required){
    const update=updates.properties[entry.key]
    if(!update)throw new CompilerError('HANDOFF_COMPLETION_SCHEMA','完成义务不在现有可写节点中',undefined,true)
    updates.required=[...new Set([...(updates.required??[]),entry.key])]
    // A partial handoff cannot change kind. Its same-type branch is sufficient.
    const branch=update.oneOf?.[0]??update
    if(!branch.properties?.[container])throw new CompilerError('HANDOFF_COMPLETION_SCHEMA','完成义务不在现有可写字段中',undefined,true)
    const fields=branch.properties[container]
    if(fields.properties&&!Object.hasOwn(fields.properties,entry.field))throw new CompilerError('HANDOFF_COMPLETION_SCHEMA','完成义务不在当前字段合同中',undefined,true)
    fields.properties={...fields.properties,[entry.field]:fields.properties?.[entry.field]??entry.wire}
    fields.required=[...new Set([...(fields.required??[]),entry.field])]
    branch.required=[...new Set([...(branch.required??[]),container])]
    updates.properties[entry.key]=branch
  }
  return result
}
/** A missing update is repaired at its stable alias, never at the whole updates map. */
export function completionRepairIssue(plan:PlanningCompletionPlan|undefined,issue:PlanningIssue,document:any):CompilerIssue|undefined{
  if(!/^REQUIRED_FIELD_(?:MISSING|UNCHANGED)$/.test(issue.code))return
  const entry=plan?.entries.find(row=>row.nodeId===issue.nodeId&&'config.'+row.field===issue.path)
  if(!entry||!isObject(document.updates))throw new CompilerError('COMPLETION_REPAIR_UNAVAILABLE','完成义务无法绑定到安全的局部草稿根',undefined,true)
  const update=document.updates[entry.key]
  if(update?.unset?.includes(entry.field))throw new CompilerError('COMPLETION_REPAIR_UNAVAILABLE','该草稿显式删除了必须提供的字段；需明确的新请求，不能扩大局部修复范围',undefined,true)
  const fields=Object.fromEntries(plan!.entries.filter(row=>row.key===entry.key&&(row.require==='changed'||!row.baselinePresent)).map(row=>[row.field,row.wire]))
  let path:string,expected:JsonSchemaNode
  if(!Object.hasOwn(document.updates,entry.key)){path=pointer(['updates',entry.key]);expected=object({set:object(fields)})}
  else if(!isObject(update))throw new CompilerError('COMPLETION_REPAIR_UNAVAILABLE','目标更新不是可安全修复的对象',undefined,true)
  else if(!Object.hasOwn(update,'set')){path=pointer(['updates',entry.key,'set']);expected=object(fields)}
  else if(!isObject(update.set))throw new CompilerError('COMPLETION_REPAIR_UNAVAILABLE','配置更新不是可安全修复的对象',undefined,true)
  else {path=pointer(['updates',entry.key,'set',entry.field]);expected=entry.wire}
  return {...issue,path,expected,contracts:{[path]:expected},allowedPaths:[path]}
}
