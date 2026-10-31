import type { NodeGraph, Workflow, WorkflowNode } from './types.ts'
import type { PlanningContext, PlanningIssue } from './planning-types.ts'
import { executionConditions } from './reference-scope.ts'
import { EXACT_TARGET_EXISTS_CODE, validateToolOperation } from './tool-operation-contract.ts'
import { VERIFIED_TARGET_CODE } from './planning-verified-file-recipe.ts'
import { reviewDraftPath, REVIEW_DRAFT_PREFIX } from './planning-review-path.ts'

const reference=(v:unknown)=>typeof v==='string'?/^\{\{([A-Za-z0-9_-]+)\.value\}\}$/.exec(v)?.[1]:undefined
function samePath(a:unknown,b:unknown,reviewDrafts=false):boolean {
  if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false
  // Bare workflow variables can be reassigned between read and write. Only
  // identical immutable inputs (and gated run-draft paths) establish a match.
  if(a.includes('{{')||b.includes('{{'))return a===b&&(/^\{\{input\.[A-Za-z0-9_.-]+\}\}$/.test(a)||reviewDrafts&&reviewDraftPath(a))
  // Do not infer filesystem aliases, case folding, symlinks or traversal.
  const simple=(p:string)=>p.replace(/^(\.\/)+/,'')
  return simple(a)===simple(b)
}
function exactProbePath(value:unknown,reviewDrafts=false):value is string {
  // Dynamic queries, globs, aliases and non-root-relative paths are unproved.
  const path=reviewDrafts&&reviewDraftPath(value)?value.slice(REVIEW_DRAFT_PREFIX.length):value
  return typeof path==='string'&&!!path&&!/[{}()*?\[\]\\!\x00:]/.test(path)&&!path.startsWith('/')&&!path.split('/').includes('..')
}

export function toolObservationProven(graph:NodeGraph,consumerId:string,write:WorkflowNode,context:PlanningContext,reviewDrafts=false,nativeStructure=false):boolean {
  return observationProof(graph,consumerId,write,context,reviewDrafts,nativeStructure).proven
}
function observationProof(graph:NodeGraph,consumerId:string,write:WorkflowNode,context:PlanningContext,reviewDrafts:boolean,nativeStructure=false,nativeGuard=false):{proven:boolean;imprecise:PlanningIssue[]} {
  const contracts=new Map(context.tools.map(tool=>[tool.id,tool.operationContract?validateToolOperation(tool.operationContract,tool.id):undefined]))
  const action=(node:WorkflowNode)=>{
    const c=contracts.get(node.config.toolId??'')
    if(node.kind!=='tool')return undefined
    if(nativeGuard){
      if(node.config.toolId==='native:read')return {kind:'file-read' as const,pathInput:'file_path'}
      if(['native:write','native:edit'].includes(node.config.toolId??''))return {kind:'file-write' as const,pathInput:'file_path',readToolIds:['native:read'],listToolIds:node.config.toolId==='native:write'?['native:glob']:[]}
      if(node.config.toolId==='native:glob')return {kind:'file-list' as const,rootField:'value.root',pathsField:'value.paths',coverage:{kind:'exact-path' as const,pathInput:'pattern',root:'.'}}
      return undefined
    }
    if(c?.status==='known')return c.declaration.scope.owner==='agent-session'&&c.declaration.scope.target==='canonical-filesystem-path'?c.declaration.action:undefined
    // REVIEW checks native graph structure without claiming a trusted contract.
    // T18 callers never enable this fallback; registration provenance stays unknown.
    if(!nativeStructure)return undefined
    if(node.config.toolId==='native:read')return {kind:'file-read' as const,pathInput:'file_path'}
    if(node.config.toolId==='native:write')return {kind:'file-write' as const,pathInput:'file_path',readToolIds:['native:read'],listToolIds:['native:glob']}
    if(node.config.toolId==='native:glob')return {kind:'file-list' as const,rootField:'value.root',pathsField:'value.paths',coverage:{kind:'exact-path' as const,pathInput:'pattern',root:'.'}}
    return undefined
  }
  const operation=action(write)
  if(operation?.kind!=='file-write')return {proven:false,imprecise:[]}
  const byId=new Map(graph.nodes.map(n=>[n.id,n])),conditions=executionConditions(graph),parents=new Map(graph.nodes.map(n=>[n.id,[] as string[]])),ancestorCache=new Map<string,Set<string>>()
  for(const edge of graph.edges)parents.get(edge.target)?.push(edge.source)
  const ancestors=(id:string)=>{
    const cached=ancestorCache.get(id);if(cached)return cached
    const found=new Set<string>(),pending=[...(parents.get(id)??[])]
    for(let at=0;at<pending.length;at++){const id=pending[at]!;if(found.has(id))continue;found.add(id);pending.push(...(parents.get(id)??[]))}
    ancestorCache.set(id,found)
    return found
  }
  const target=write.config.inputs?.[operation.pathInput],upstream=ancestors(consumerId)
  const matches=(a:unknown,b:unknown)=>{
    if(!nativeGuard&&samePath(a,b,reviewDrafts))return true
    if(typeof a!=='string'||!a||a!==b)return false
    if(!a.includes('{{'))return true
    const ref=/^\{\{([A-Za-z0-9_-]+)\.[A-Za-z0-9_.-]+\}\}$/.exec(a)
    return !!ref&&(ref[1]==='input'||byId.has(ref[1]!))||reviewDrafts&&reviewDraftPath(a)
  }
  const guardedTarget=(listingId:string)=>{
    if(typeof target!=='string'||!/^\{\{input\.[A-Za-z_][A-Za-z0-9_-]*\}\}$/.test(target))return false
    return [...ancestors(listingId)].some(id=>{
      const guard=byId.get(id)!
      return guard.kind==='code'&&(guard.config.language??'javascript')==='javascript'&&guard.config.code===VERIFIED_TARGET_CODE&&guard.config.inputs?.target===target
        &&conditions.implies(conditions.active(listingId),conditions.active(id))
    })
  }
  let proof=0
  const imprecise:PlanningIssue[]=[]
  for(const id of upstream){
    const node=byId.get(id);if(!node)continue
    const read=action(node)
    if(read?.kind==='file-read'&&node.config.cache!=='reuse'&&operation.readToolIds.includes(node.config.toolId!)&&matches(node.config.inputs?.[read.pathInput],target))proof=conditions.union(proof,conditions.active(id))
    // Only the pinned, side-effect-free selector is accepted as absence
    // evidence. Arbitrary JavaScript is not proved by a substring match.
    if(node.kind==='if'&&!node.config.cases?.length&&!node.config.logicGate){
      const match=/^([A-Za-z0-9_-]+)\.exists$/.exec(node.config.variable??'')
      const selector=match&&byId.get(match[1]!),listingId=selector&&reference(selector.config.inputs?.listing),listing=listingId&&byId.get(listingId)
      const listAction=listing&&action(listing)
      if(selector?.kind==='code'&&(selector.config.language??'javascript')==='javascript'&&selector.config.code===EXACT_TARGET_EXISTS_CODE&&matches(selector.config.inputs?.target,target)
        &&upstream.has(selector.id)&&ancestors(node.id).has(selector.id)&&listing&&ancestors(selector.id).has(listing.id)
        &&conditions.implies(conditions.active(node.id),conditions.active(selector.id))&&conditions.implies(conditions.active(selector.id),conditions.active(listing.id))
        &&listAction&&listAction.kind==='file-list'&&listAction.rootField==='value.root'&&listAction.pathsField==='value.paths'&&operation.listToolIds.includes(listing.config.toolId!)
        &&listing.config.cache!=='reuse'&&listAction.coverage?.kind==='exact-path'&&listAction.coverage.root==='.'
        &&(exactProbePath(listing.config.inputs?.[listAction.coverage.pathInput],reviewDrafts)||guardedTarget(listing.id))&&matches(listing.config.inputs?.[listAction.coverage.pathInput],target)){
        const {operator,value}=node.config
        const trueMeansExists=operator==='equals'&&value==='true'||operator==='not_equals'&&value==='false'
        const trueMeansAbsent=operator==='equals'&&value==='false'||operator==='not_equals'&&value==='true'
        if(trueMeansExists||trueMeansAbsent)proof=conditions.union(proof,conditions.route(node.id,trueMeansAbsent?'true':'false'))
      }
    }
    const conditionsToCheck=node.kind==='if'?[{variable:node.config.variable,operator:node.config.operator,path:'config.variable'},...(node.config.cases??[]).flatMap((c,i)=>c.conditions.map((v,j)=>({...v,path:`config.cases[${i}].conditions[${j}].variable` })))]:[]
    for(const check of conditionsToCheck)if(check.variable?.endsWith('.value.paths')&&['not_empty','empty'].includes(check.operator??''))
      imprecise.push({code:'IMPRECISE_TARGET_EXISTENCE',nodeId:node.id,path:check.path,message:`目标 ${String(target)} 的存在性不能由 ${check.variable} 非空判断；子目录同名文件不是精确目标命中。`})
    const listed=reference(node.config.inputs?.listing),source=listed&&byId.get(listed)
    const controlsRoute=graph.nodes.some(n=>upstream.has(n.id)&&n.kind==='if'&&(n.config.variable??'').startsWith(node.id+'.'))
    if(node.kind==='code'&&source&&action(source)?.kind==='file-list'&&controlsRoute&&/\bpaths\s*\.\s*length\s*(?:>\s*0|!==?\s*0)/.test(node.config.code??''))
      imprecise.push({code:'IMPRECISE_TARGET_EXISTENCE',nodeId:node.id,path:'config.code',message:`目标 ${String(target)} 不能由 paths.length 非零判断存在；须按 root 和完整相对路径精确匹配。`})
  }
  return {proven:conditions.implies(conditions.active(consumerId),proof),imprecise}
}

/** Static ordering/proof checks only. A passing plan cannot establish existence,
 * permissions, current owner observations or freshness; SDK execution owns those. */
export function planningToolPreconditionIssues(workflow:Workflow,context:PlanningContext):PlanningIssue[] {
  const hasGate=(g:NodeGraph):boolean=>g.nodes.some(n=>n.kind==='human'&&(n.config.actions?.length??0)>=2||!!n.config.body&&hasGate(n.config.body)),reviewDrafts=hasGate(workflow)
  const issues:PlanningIssue[]=[],contracts=new Map(context.tools.map(tool=>[tool.id,tool.operationContract?validateToolOperation(tool.operationContract,tool.id):undefined]))
  if(![...contracts.values()].some(c=>c?.status==='known'&&c.declaration.action.kind!=='other'))return issues
  const action=(node:WorkflowNode)=>{
    if(node.kind!=='tool')return undefined
    const contract=contracts.get(node.config.toolId??'')
    return contract?.status==='known'&&contract.declaration.scope.owner==='agent-session'&&contract.declaration.scope.target==='canonical-filesystem-path'?contract.declaration.action:undefined
  }
  const visit=(graph:NodeGraph,parents:{graph:NodeGraph;consumerId:string}[]=[])=>{
    for(const write of graph.nodes){
      if(write.config.body)visit(write.config.body,[...parents,{graph,consumerId:write.id}])
      const declared=contracts.get(write.config.toolId??'')
      // Document execution prepares attachment values and replaces the source
      // argument. File-operation path/owner proofs do not apply to that adapter.
      if(write.kind==='document'&&write.config.documentMode==='tool'&&declared?.status==='known'&&declared.declaration.action.kind!=='other'){
        issues.push({code:'TOOL_DOCUMENT_OPERATION_UNSUPPORTED',nodeId:write.id,path:'config.toolId',message:'文档工具模式会转换附件来源参数，不支持文件操作合同；请使用显式工具节点执行读取、精确探测或写入。'})
        if(write.config.cache==='reuse')issues.push({code:'TOOL_OBSERVATION_REUSE_UNSAFE',nodeId:write.id,path:'config.cache',message:'文件动作／读取观察不能用历史文档缓存替代本次 SDK 调用。'})
        continue
      }
      const operation=action(write)
      if(write.kind==='tool'&&declared?.status==='known'&&declared.declaration.action.kind==='file-write'&&!operation)
        issues.push({code:'TOOL_PRECONDITION_UNSUPPORTED_SCOPE',nodeId:write.id,path:'config.toolId',message:'文件写入合同的 owner／路径范围超出当前可验证范围，不能据此声称覆盖可复用。'})
      if(operation&&operation.kind!=='other'&&write.config.cache==='reuse')issues.push({code:'TOOL_OBSERVATION_REUSE_UNSAFE',nodeId:write.id,path:'config.cache',message:'文件动作／读取观察与当前 owner、路径和版本关联；不能用历史缓存替代本次 SDK 调用。'})
      if(operation?.kind!=='file-write')continue
      const target=write.config.inputs?.[operation.pathInput],{proven,imprecise}=observationProof(graph,write.id,write,context,reviewDrafts)
      // A loop retains its run owner across rounds. Only unconditional proofs at
      // the container entry propagate; iteration items and dynamic vars do not.
      const inherited=reviewDrafts&&parents.every(p=>p.graph.nodes.find(n=>n.id===p.consumerId)?.kind==='loop')&&parents.some(p=>toolObservationProven(p.graph,p.consumerId,write,context,reviewDrafts))
      if(!proven&&!inherited){
        issues.push(...imprecise,{code:'TOOL_PRECONDITION_UNPROVEN',nodeId:write.id,path:`config.inputs.${operation.pathInput}`,
          message:`写入目标 ${String(target)}：覆盖分支缺少同一执行 owner 对精确目标的前置 read，或首建分支缺少精确不存在判断。glob 不是读取证明；输出字段合同与动作前置条件分别校验。可用固定精确路径选择代码，不能无条件读取缺失目标。`})
      }
    }
  }
  visit(workflow)
  return issues
}

/** Planner-only structural guard, independent of optional SDK attestations. */
export function planningNativeFileWriteIssues(workflow:Workflow,context:PlanningContext):PlanningIssue[] {
  const issues:PlanningIssue[]=[]
  const hasGate=(g:NodeGraph):boolean=>g.nodes.some(n=>n.kind==='human'&&(n.config.actions?.length??0)>=2||!!n.config.body&&hasGate(n.config.body)),reviewDrafts=hasGate(workflow)
  const visit=(graph:NodeGraph,parents:{graph:NodeGraph;consumerId:string}[]=[])=>{
    for(const node of graph.nodes){
      if(node.config.body)visit(node.config.body,[...parents,{graph,consumerId:node.id}])
      if(!(node.kind==='tool'||node.kind==='document'&&node.config.documentMode==='tool')||!['native:write','native:edit'].includes(node.config.toolId??''))continue
      const proof=(g:NodeGraph,id:string)=>observationProof(g,id,node,context,reviewDrafts,false,true).proven
      // Iteration bodies use separate owners; loop entry observations can persist.
      const inherited=parents.every(p=>p.graph.nodes.find(n=>n.id===p.consumerId)?.kind==='loop')&&parents.some(p=>proof(p.graph,p.consumerId))
      if(node.kind==='tool'&&node.config.cache!=='reuse'&&(proof(graph,node.id)||inherited))continue
      issues.push({code:'FILE_WRITE_NEEDS_READ',nodeId:node.id,path:'config.inputs.file_path',message:`节点 ${node.id} 的 ${node.config.toolId} 缺少同一路径表达式的前置 native:read（必须覆盖每条到达路径，不能复用缓存）。请使用 verified-file-write@1.1.0（支持 target: "{{input.outputPath}}"），或先读取同一路径；可能缺失的文件须按固定精确探测→存在时 read→write 配方首建，不能无条件读取缺失文件。native:edit 必须读取已有目标；文档工具模式会转换参数，请改用显式工具节点。`})
    }
  }
  visit(workflow)
  return issues
}
