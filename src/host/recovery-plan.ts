import { activeExecutionPolicy } from '../shared/execution-policy.ts'
import { createHash } from 'node:crypto'
import type { NodeGraph, NodeExecution, Workflow, WorkflowNode, WorkflowRun } from '../shared/types.ts'
import { builtinReadsCurrentTime } from './tool-catalog.ts'

export type RecoveryAction = 'reuse' | 'rerun' | 'blocked'
export interface RecoveryPlanItem { executionId:string;nodeId:string;title:string;action:RecoveryAction;reason:string;reviewable?:boolean;reviewCanComplete?:boolean }
export interface RecoveryPlan { sourceRunId:string;planDigest:string;allowed:boolean;blockedReasons:string[];items:RecoveryPlanItem[];invalidNodeIds:string[] }
export type WorkflowSemanticContext = Partial<Pick<WorkflowRun,'modelDefaults'|'rolePrompts'|'toolConstraints'|'dependencySnapshots'|'dependencyRolePrompts'|'environment'|'inputs'|'systemVariables'>>

function ordered(value:unknown):unknown {
  if(Array.isArray(value))return value.map(ordered)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)]))
  return value
}
const serialize=(value:unknown)=>JSON.stringify(ordered(value))
const digest=(value:unknown)=>createHash('sha256').update(serialize(value)).digest('hex')
const compare=(a:unknown,b:unknown)=>serialize(a)===serialize(b)
const byId=<T extends {id:string}>(a:T,b:T)=>a.id.localeCompare(b.id)
const ownConfig=(node:WorkflowNode)=>{const {body:_,...config}=node.config;return config}
const envDefinitions=(flow:Workflow)=>(flow.environmentVariables??[]).map(v=>({id:v.id,type:v.type,required:v.required??false,...(v.type!=='secret'&&v.value!==undefined?{value:v.value}:{})})).sort(byId)
const envValues=(flow:Workflow)=>Object.fromEntries((flow.environmentVariables??[]).flatMap(v=>v.type!=='secret'&&v.value!==undefined?[[v.id,v.value]]:[]))
function graphSemantics(graph:NodeGraph):unknown {
  return {
    nodes:[...graph.nodes].sort(byId).map(node=>({id:node.id,kind:node.kind,fixed:node.fixed,config:{...ownConfig(node),...(node.config.body?{body:graphSemantics(node.config.body)}:{})}})),
    edges:graph.edges.map(edge=>({source:edge.source,target:edge.target,port:edge.port??'default'})).sort((a,b)=>serialize(a).localeCompare(serialize(b))),
  }
}
function workflowSemantics(graph:Workflow):unknown {return {id:graph.id,workspaceId:graph.workspaceId,graph:graphSemantics(graph),environmentVariables:envDefinitions(graph),executionPolicy:activeExecutionPolicy(graph.executionPolicy)}}

/** Retired ceilings/reservations/estimates are not recovery authority. Keep
 * actual reported usage and receipt identities so changed evidence stays stale. */
function usageEvidence(state:WorkflowRun['usage']):unknown {
  if(!state)return undefined
  return {spentTokens:state.spentTokens,unknownCalls:state.unknownCalls,agentTasks:state.agentTasks,calls:state.calls,
    allocations:Object.fromEntries(Object.entries(state.allocations).map(([id,receipt])=>[id,{status:receipt.status,...(receipt.usage===undefined?{}:{usage:receipt.usage})}]))}
}

/** Excludes labels, revisions, timestamps, canvas coordinates and notes. Model,
 * role/tool contracts, recursive definitions and effective inputs remain semantic. */
export function workflowSemanticDigest(graph:Workflow,context:unknown={}):string {
  let effective=context
  if(context&&typeof context==='object'&&!Array.isArray(context)){
    const fields=context as Record<string,unknown>,dependencies=fields.dependencySnapshots
    effective={...fields,environment:fields.environment??envValues(graph),...(dependencies&&typeof dependencies==='object'&&!Array.isArray(dependencies)?{
      dependencySnapshots:Object.fromEntries(Object.entries(dependencies).map(([id,flow])=>[id,flow&&typeof flow==='object'&&Array.isArray((flow as Workflow).nodes)&&Array.isArray((flow as Workflow).edges)?workflowSemantics(flow as Workflow):flow]))}:{}),}
  }
  return digest({workflow:workflowSemantics(graph),context:effective})
}
const executionContext=(source:WorkflowRun):WorkflowSemanticContext=>({modelDefaults:source.modelDefaults,rolePrompts:source.rolePrompts,toolConstraints:source.toolConstraints,dependencySnapshots:source.dependencySnapshots,dependencyRolePrompts:source.dependencyRolePrompts,environment:source.environment,inputs:source.inputs,systemVariables:source.systemVariables})
const selectedTools=(node:WorkflowNode)=>[node.config.toolId,...(node.config.tools??[])].filter((id):id is string=>!!id)
function dependencySignature(id:string,context:WorkflowSemanticContext,visited=new Set<string>()):unknown {
  if(visited.has(id))return {id,recursive:true}
  const graph=context.dependencySnapshots?.[id];if(!graph)return {id,missing:true}
  const seen=new Set([...visited,id]),nodes=[...inventory(graph).values()].map(info=>info.node),tools=[...new Set(nodes.flatMap(selectedTools))].sort()
  return {id,graph:workflowSemantics(graph),roles:context.dependencyRolePrompts?.[id],modelDefaults:context.modelDefaults,
    tools:Object.fromEntries(tools.filter(tool=>!tool.startsWith('workflow:')).map(tool=>[tool,context.toolConstraints?.[tool]])),
    children:tools.filter(tool=>tool.startsWith('workflow:')).map(tool=>dependencySignature(tool.slice('workflow:'.length),context,seen))}
}

interface NodeInfo {node:WorkflowNode;parents:string[];incoming:string[]}
function inventory(graph:NodeGraph):Map<string,NodeInfo> {
  const result=new Map<string,NodeInfo>()
  const visit=(current:NodeGraph,parents:string[])=>{for(const node of current.nodes){
    if(result.has(node.id))throw new Error(`恢复快照含重复节点身份：${node.id}`)
    result.set(node.id,{node,parents,incoming:current.edges.filter(e=>e.target===node.id).map(e=>serialize({source:e.source,port:e.port??'default'})).sort()})
    if(node.config.body)visit(node.config.body,[...parents,node.id])
  }}
  visit(graph,[]);return result
}
const effects=new Set(['agent','tool','http','document'])
const pure=new Set(['input','template','if','output','assigner','aggregator','list','exit_loop'])
const containers=new Set(['iteration','loop'])
const executed=(record:NodeExecution)=>!!(record.startedAt||record.subagentId||record.childRunId||(record.attempt??0)>0||['running','failed','cancelled','success'].includes(record.status))
const prefix=(executionId:string,nodeId:string)=>executionId===nodeId?'':executionId.endsWith(`/${nodeId}`)?executionId.slice(0,-nodeId.length):undefined
function containerInstance(executionId:string,containerId:string):{id:string;iteration:number}|undefined {
  const pieces=executionId.split('/'),at=pieces.findIndex(part=>part.startsWith(`${containerId}[`)&&/^\d+\]$/.test(part.slice(containerId.length+1)))
  if(at<0)return
  return {id:[...pieces.slice(0,at),containerId].join('/'),iteration:Number(pieces[at]!.slice(containerId.length+1,-1))}
}
interface Candidate {item:RecoveryPlanItem;record?:NodeExecution;old?:NodeInfo;next?:NodeInfo;invalid:boolean;contextInvalid:boolean;scope?:string;placeholder:boolean}

/** A cached caller must not hide a protected operation in a frozen child flow. */
function usesProtectedCredential(node:WorkflowNode,context:WorkflowSemanticContext,visited=new Set<string>()):boolean {
  if(node.kind==='http'&&node.config.credentialOperation)return true
  for(const tool of selectedTools(node)){
    if(!tool.startsWith('workflow:'))continue
    const id=tool.slice('workflow:'.length),graph=context.dependencySnapshots?.[id]
    if(!graph||visited.has(id))continue
    const seen=new Set([...visited,id])
    if([...inventory(graph).values()].some(info=>usesProtectedCredential(info.node,context,seen)))return true
  }
  return false
}
function nonReusable(node:WorkflowNode,context:WorkflowSemanticContext,preservesIdentity=false,visited=new Set<string>()):string|undefined {
  if(usesProtectedCredential(node,context,visited))return '受控凭据操作及其调用方必须重新核验当前授权并取得原生批准；历史结果和显式缓存不能代替当前凭据权限'
  const config=ownConfig(node),text=serialize({config,role:context.rolePrompts?.[node.id]})
  const identities=[...text.matchAll(/\bsys\.(workflow_run_id|timestamp|session_id|user_id|app_id)\b/g)].map(match=>match[1]!)
  if(identities.length&&(!preservesIdentity||identities.some(name=>!Object.hasOwn(context.systemVariables??{},name))))return '依赖运行时间或调用者身份；新运行或未确认相同身份时必须重新计算，显式复用不能覆盖此规则'
  if(node.kind==='input'&&node.config.fields?.some(field=>field.type==='file'||field.type==='files'))return '文件输入需要重新物化并核验内容，旧结果不能默认复用'
  if(node.config.verification?.requiredFiles?.length||node.config.verification?.requiredReadFiles?.length||node.config.verification?.requiredChangedFiles?.length)return '依赖文件产物，缺少当前内容指纹，必须重新验证后执行'
  if(node.kind==='document'||node.kind==='knowledge')return '依赖文件或外部资料，当前没有可验证的内容指纹'
  if(node.kind==='human')return '人工决定依赖当前调用者，必须重新确认'
  if(selectedTools(node).some(id=>builtinReadsCurrentTime(id,node.kind==='tool'?node.config.inputs:undefined)))return '工具读取当前时间，不能复用旧运行的时间结果'
  if(node.kind==='code'&&/\b(?:Date|performance|crypto)\b|\bMath\s*\.\s*random\b|\b(?:datetime|random|time)\s*\./.test(node.config.code??''))return '代码依赖时间或随机值，显式复用不能代替重新计算'
  for(const tool of selectedTools(node)){
    if(!tool.startsWith('workflow:'))continue
    const id=tool.slice('workflow:'.length),graph=context.dependencySnapshots?.[id]
    if(!graph)return `引用子流程 ${id} 缺少冻结快照，无法核验结果的动态依赖`
    if(visited.has(id))return `引用子流程 ${id} 存在递归调用，不能确认历史结果可复用`
    const seen=new Set([...visited,id])
    // A newly invoked child receives a fresh run identity and clock, even when
    // the parent resumes in place. Roles belong to that child's frozen scope.
    const childContext={...context,rolePrompts:context.dependencyRolePrompts?.[id],systemVariables:undefined}
    for(const {node:child} of inventory(graph).values()){
      const reason=nonReusable(child,childContext,false,seen)??(child.config.cache==='never'?'节点明确禁止结果复用':undefined)
      if(reason)return `引用子流程 ${id} 的节点 ${child.id} 不可复用：${reason}`
    }
  }
}

/** A read-only plan, not execution or authorization. Callers must separately
 * validate graphs, fixed nodes, current permissions and source lifecycle, then
 * recompute planDigest at confirmation. Removed pure nodes are reported as
 * rerun/invalidated but must not be recreated outside targetGraph. */
export function buildRecoveryPlan(source:WorkflowRun,mode:'resume'|'rerun',targetGraph?:Workflow,targetContext?:WorkflowSemanticContext):RecoveryPlan {
  const explicitTarget=targetGraph!==undefined
  targetGraph??=source.graph
  const preservesIdentity=explicitTarget&&source.systemVariables!==undefined&&targetContext?.systemVariables!==undefined&&compare(source.systemVariables,targetContext.systemVariables)
  const oldNodes=inventory(source.graph),newNodes=inventory(targetGraph),blockedReasons:string[]=[],candidates:Candidate[]=[],seen=new Set<string>()
  if(mode!=='resume'&&mode!=='rerun')throw new Error('无效的恢复模式')
  if(source.graph.id!==targetGraph.id||source.graph.workspaceId!==targetGraph.workspaceId)blockedReasons.push('恢复修订不能改变工作流或工作区身份')
  if(source.rootRunId)blockedReasons.push('子工作流必须从所属根运行恢复，避免绕过根运行协调或重放动作')
  if(['running','pausing'].includes(source.status))blockedReasons.push('来源运行尚未停稳，不能确认恢复计划')
  const sourceContext=executionContext(source),effectiveTargetContext={...sourceContext,...targetContext}
  const sourceEnv=source.environment??envValues(source.graph),targetEnv=targetContext?.environment??(targetGraph===source.graph?sourceEnv:envValues(targetGraph))
  effectiveTargetContext.environment=targetEnv
  const oldEnv=new Map(envDefinitions(source.graph).map(v=>[v.id,v])),newEnv=new Map(envDefinitions(targetGraph).map(v=>[v.id,v]))
  const changedEnv=new Set([...new Set([...Object.keys(sourceEnv),...Object.keys(targetEnv),...oldEnv.keys(),...newEnv.keys()])].filter(id=>!compare(sourceEnv[id],targetEnv[id])||!compare(oldEnv.get(id),newEnv.get(id))))
  const add=(nodeId:string,executionId:string,record?:NodeExecution)=>{
    const old=oldNodes.get(nodeId),next=newNodes.get(nodeId),item:RecoveryPlanItem={nodeId,executionId,title:next?.node.title??old?.node.title??record?.title??nodeId,action:'reuse',reason:'已成功完成，执行定义与依赖未变化，可复用纯结果'}
    const candidate:Candidate={item,record,old,next,invalid:false,contextInvalid:false,scope:prefix(executionId,nodeId),placeholder:!record};candidates.push(candidate)
    const invalidate=(reason:string,context=false)=>{candidate.invalid=true;candidate.contextInvalid=context;item.action='rerun';item.reason=reason}
    if(seen.has(executionId)){candidate.invalid=true;item.action='blocked';item.reason='执行实例身份重复，无法确定对应结果';blockedReasons.push(`${executionId}：${item.reason}`);return}seen.add(executionId)
    if(mode==='rerun'){invalidate(next?'用户选择按快照重新执行；不复用旧结果':'节点已从目标图移除，旧结果作废且不再执行',true);return}
    if(!old&&record){candidate.invalid=true;item.action='blocked';item.reason='执行记录不属于来源快照，无法安全判断原操作';blockedReasons.push(`${executionId}：${item.reason}`);return}
    if(!next){invalidate('节点已从目标图移除，旧结果作废且不再执行',true);return}
    if(candidate.scope===undefined){candidate.invalid=true;item.action='blocked';item.reason='执行实例路径与节点身份不一致，不能复用';blockedReasons.push(`${executionId}：${item.reason}`);return}
    if(record&&old?.parents.some(id=>!containerInstance(executionId,id))){candidate.invalid=true;item.action='blocked';item.reason='容器内执行记录缺少明确的实例路径，不能安全复用';blockedReasons.push(`${executionId}：${item.reason}`);return}
    if(!old){invalidate(next.parents.length?'新增容器内节点；实际实例将在容器执行时建立':'目标图新增节点，需要执行',true);return}
    if(old.node.kind!==next.node.kind||!compare(ownConfig(old.node),ownConfig(next.node))){invalidate('节点执行配置已变化，旧结果失效',true);return}
    if(!compare(old.parents,next.parents)||!compare(old.incoming,next.incoming)){invalidate('节点的容器位置或上游输入连线已变化',true);return}
    if(!compare(sourceContext.rolePrompts?.[nodeId]??'',effectiveTargetContext.rolePrompts?.[nodeId]??'')){invalidate('节点实际角色提示词已变化，旧结果失效',true);return}
    const tools=selectedTools(next.node)
    if(tools.some(id=>!id.startsWith('workflow:')&&!compare(sourceContext.toolConstraints?.[id],effectiveTargetContext.toolConstraints?.[id]))){invalidate('节点使用的工具契约已变化，旧结果失效',true);return}
    if(tools.some(id=>id.startsWith('workflow:')&&!compare(dependencySignature(id.slice('workflow:'.length),sourceContext),dependencySignature(id.slice('workflow:'.length),effectiveTargetContext)))){invalidate('引用子流程的有效定义、角色或工具依赖已变化',true);return}
    if(next.node.kind==='input'&&!compare(sourceContext.inputs,effectiveTargetContext.inputs)){invalidate('运行输入已变化，输入节点及下游结果失效',true);return}
    if(!next.node.config.model&&['llm','agent','classifier','extractor'].includes(next.node.kind)&&!compare(sourceContext.modelDefaults,effectiveTargetContext.modelDefaults)){invalidate('节点继承的模型默认配置已变化',true);return}
    const configText=serialize({config:ownConfig(next.node),role:effectiveTargetContext.rolePrompts?.[nodeId]})
    if([...changedEnv].some(id=>configText.includes(`env.${id}`))){invalidate('引用的环境变量定义或有效值已变化',true);return}
    const dynamic=nonReusable(next.node,effectiveTargetContext,preservesIdentity)
    if(dynamic){invalidate(dynamic,true);return}
    if(next.node.config.cache==='never'){invalidate('节点明确禁止结果复用',true);return}
    if(!record||record.status!=='success'||record.data===undefined){invalidate(record?`来源实例状态为 ${record.status}，没有可复用的成功结果`:'来源运行没有这个执行实例，需要执行');return}
    if(record.verification?.status==='failed'){invalidate('来源结果验证失败，不能复用');return}
    if(containers.has(next.node.kind)){item.action='rerun';item.reason='重建容器作用域及汇总；可复用的内部实例逐项列出，不直接重放已完成动作';return}
    if(!pure.has(next.node.kind)&&next.node.config.cache!=='reuse'){invalidate(next.node.kind==='code'?'代码不能默认视为确定性结果；未显式允许复用':'该节点不是默认可复用的纯计算，未显式允许复用');return}
    if(!pure.has(next.node.kind))item.reason=effects.has(next.node.kind)?'明确允许复用已成功的外部结果；不重新发送外部动作，当前授权仍须核验':'明确允许复用已成功结果，且没有检测到动态身份或内容依赖'
  }
  for(const record of [...source.executions].sort((a,b)=>(a.executionId??a.nodeId).localeCompare(b.executionId??b.nodeId)))add(record.nodeId,record.executionId??record.nodeId,record)
  // Introduce new/missing node instances in every already known container scope.
  // A body never entered yet is represented by a declaration placeholder only.
  for(const [nodeId,info] of newNodes){
    const existing=candidates.filter(c=>c.item.nodeId===nodeId)
    if(!info.parents.length){if(!existing.some(c=>c.item.executionId===nodeId))add(nodeId,nodeId);continue}
    const scopes=new Set(candidates.filter(c=>c.record&&c.old&&compare(c.old.parents,info.parents)&&c.scope!==undefined).map(c=>c.scope!))
    if(!scopes.size){if(!existing.length)add(nodeId,nodeId);continue}
    for(const scope of scopes)if(!seen.has(`${scope}${nodeId}`))add(nodeId,`${scope}${nodeId}`)
  }
  if(mode==='resume'){
    const changed=(candidate:Candidate,reason:string,context=false)=>{
      const didChange=!candidate.invalid||context&&!candidate.contextInvalid
      if(candidate.item.action!=='blocked'&&!candidate.invalid){candidate.item.action='rerun';candidate.item.reason=reason}
      candidate.invalid=true;candidate.contextInvalid ||= context;return didChange
    }
    let progress=true
    while(progress){progress=false
      for(const candidate of candidates){
        const info=candidate.next??candidate.old;if(!info)continue
        // Only dependencies in the same concrete iteration may invalidate a peer.
        for(const incoming of info.incoming){const from=(JSON.parse(incoming) as {source:string}).source
          const dependency=candidates.find(c=>c.item.executionId===`${candidate.scope??''}${from}`)
          if(dependency?.invalid)progress=changed(candidate,`上游实例 ${dependency.item.executionId} 需要重算，其下游结果失效`,true)||progress
        }
        for(const parentId of info.parents){
          const instance=containerInstance(candidate.item.executionId,parentId)
          const parent=candidates.find(c=>c.item.executionId===(instance?.id??parentId))
          if(parent?.contextInvalid)progress=changed(candidate,`容器 ${parentId} 的输入或配置已变化，内部实例失效`,true)||progress
          if(candidate.invalid&&parent)progress=changed(parent,`容器内部实例 ${candidate.item.executionId} 需要重算，汇总结果失效`)||progress
          if(instance&&(newNodes.get(parentId)??oldNodes.get(parentId))?.node.kind==='loop'){
            const prior=candidates.find(c=>c.invalid&&(()=>{const other=containerInstance(c.item.executionId,parentId);return other?.id===instance.id&&other.iteration<instance.iteration})())
            if(prior)progress=changed(candidate,`循环较早轮次 ${prior.item.executionId} 已失效，后续状态不能复用`,true)||progress
          }
        }
      }
    }
    for(const candidate of candidates){
      const {record,old,item}=candidate
      if(!record||!old||!effects.has(old.node.kind))continue
      item.reviewCanComplete=!candidate.contextInvalid
      if(executed(record)&&record.status!=='success'){
        item.action='blocked';item.reason='外部操作已启动但结果未确认，必须先核验，不能自动重复执行';candidate.invalid=true
      }else if(record.status==='success'&&candidate.invalid){
        item.action='blocked';item.reason=`已完成的外部操作不能自动重放：${item.reason}；请核验后明确选择重跑`;candidate.invalid=true
      }
      if(item.action==='blocked')blockedReasons.push(`${item.executionId}：${item.reason}`)
    }
  }
  const items=candidates.map(c=>c.item).sort((a,b)=>a.executionId.localeCompare(b.executionId)),invalidNodeIds=[...new Set(candidates.filter(c=>c.item.action!=='reuse').map(c=>c.item.nodeId))].sort()
  const executionState=source.executions.map(({title:_,number:__,...state})=>state).sort((a,b)=>(a.executionId??a.nodeId).localeCompare(b.executionId??b.nodeId))
  const planDigest=digest({version:2,mode,preservesIdentity,sourceRunId:source.id,status:source.status,sourceSemantic:workflowSemanticDigest(source.graph,sourceContext),targetSemantic:workflowSemanticDigest(targetGraph,effectiveTargetContext),inputs:source.inputs,systemVariables:source.systemVariables,usage:usageEvidence(source.usage),executions:executionState,outputs:source.outputs})
  return {sourceRunId:source.id,planDigest,allowed:blockedReasons.length===0,blockedReasons:[...new Set(blockedReasons)],items,invalidNodeIds}
}
