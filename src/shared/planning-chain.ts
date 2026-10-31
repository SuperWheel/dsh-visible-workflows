import type { NodeGraph, WorkflowNode, NodeConfig, Workflow } from './types.ts'
import type { PlanningContext } from './planning-types.ts'
import { allNodes } from './workflow-validation.ts'
import { AuthoringCore } from './planning-authoring-core.ts'
import { createTemplateBinding } from './planning-node-templates.ts'
import { planningNodeOutputType } from './planning-projection.ts'
import { planningEditDigest, planningNodeRefs, rewritePlanningConfig, maskPlanningTemplateLocals, type PlanningAliases } from './planning-edits.ts'
import { CompilerError, compilerJson, jsonDigest } from './planning-repair.ts'
import { isChainAlias, planningChainLocatorSchema, planningChainRequestSchema, type PlanningChainLocator, type PlanningChainRequest, type ChainForm } from './planning-chain-contract.ts'
import { applyChainSplice, confirmChainDraft, createChainDraft, resolveChainAlias, type ChainDraft } from './planning-chain-draft.ts'

export { planningChainLocatorSchema, planningChainRequestSchema, type PlanningChainRequest, type PlanningChainLocator } from './planning-chain-contract.ts'
export { applyChainSplice, compareChainAliases, confirmChainDraft, createChainDraft } from './planning-chain-draft.ts'
const fail=(code:string,message:string):never=>{throw new CompilerError(code,message,undefined,true)}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
type Edge=NodeGraph['edges'][number]
interface Location {node:WorkflowNode;graph:NodeGraph;scope:string[];fixed:boolean}
function locations(graph:NodeGraph):Map<string,Location> {
  const result=new Map<string,Location>()
  const visit=(current:NodeGraph,scope:string[],fixed=false)=>{for(const node of current.nodes){result.set(node.id,{node,graph:current,scope,fixed:fixed||node.fixed});if(node.config.body)visit(node.config.body,[...scope,node.id],fixed||node.fixed)}}
  visit(graph,[]);return result
}
function segment(context:PlanningContext,raw:PlanningChainLocator) {
  const locator=planningChainLocatorSchema.parse({chainKey:raw.chainKey,anchorNodeId:raw.anchorNodeId,...(raw.scope?{scope:raw.scope}:{}),...(raw.nodeIds?{nodeIds:raw.nodeIds}:{}),...(raw.boundary?{boundary:raw.boundary}:{})}),places=locations(context.workflow),anchor=places.get(locator.anchorNodeId)
  if(!anchor)fail('CHAIN_ANCHOR_MISSING','链定位节点不存在：'+locator.anchorNodeId)
  if(locator.scope&&!equal(locator.scope,anchor!.scope))fail('CHAIN_SCOPE','anchorNodeId 与显式 scope 不一致')
  const graph=anchor!.graph,byId=new Map(graph.nodes.map(node=>[node.id,node]))
  const incoming=new Map(graph.nodes.map(node=>[node.id,[] as Edge[]])),outgoing=new Map(graph.nodes.map(node=>[node.id,[] as Edge[]]))
  for(const edge of graph.edges){incoming.get(edge.target)?.push(edge);outgoing.get(edge.source)?.push(edge)}
  const linear=(id:string)=>{const node=byId.get(id);return !!node&&!['if','classifier','loop','iteration','exit_loop'].includes(node.kind)&&!node.config.body}
  if(!linear(locator.anchorNodeId))fail('CHAIN_TOPOLOGY','链定位必须是无分支普通节点；分支插入请选具体 edgeId 的普通端点')
  let ids=locator.nodeIds?[...locator.nodeIds]:[locator.anchorNodeId]
  if(!locator.nodeIds){
    const seen=new Set(ids)
    const grow=(before:boolean)=>{
      for(;;){
        const current=before?ids[0]!:ids.at(-1)!,edges=(before?incoming:outgoing).get(current)??[]
        if(edges.length!==1)break
        const edge=edges[0]!
        if(edge.id===(before?locator.boundary?.entryEdgeId:locator.boundary?.exitEdgeId))break
        const next=before?edge.source:edge.target
        if((edge.port??'default')!=='default'||!linear(next)||places.get(next)?.fixed||(before?outgoing:incoming).get(next)?.length!==1)break
        if(seen.has(next))fail('CHAIN_CYCLE','顺序片段存在循环，不能自动接边')
        seen.add(next);if(before)ids.unshift(next);else ids.push(next)
      }
    }
    grow(true);grow(false)
  }
  if(!ids.includes(locator.anchorNodeId)||new Set(ids).size!==ids.length)fail('CHAIN_SEGMENT','显式片段须包含定位节点且不能重复')
  for(const id of ids){if(!places.has(id)||!equal(places.get(id)!.scope,anchor!.scope))fail('CHAIN_SCOPE','片段节点不在同一 scope：'+id);if(!linear(id))fail('CHAIN_TOPOLOGY','片段不能包含分支、容器或 exit_loop：'+id)}
  const set=new Set(ids),internal=graph.edges.filter(edge=>set.has(edge.source)&&set.has(edge.target))
  if(internal.length!==ids.length-1||ids.slice(1).some((id,i)=>internal.filter(edge=>edge.source===ids[i]&&edge.target===id&&(edge.port??'default')==='default').length!==1))fail('CHAIN_TOPOLOGY','显式片段不是唯一无分支顺序段；需要显式连线合同')
  const entries=graph.edges.filter(edge=>!set.has(edge.source)&&set.has(edge.target)),exits=graph.edges.filter(edge=>set.has(edge.source)&&!set.has(edge.target))
  if(entries.some(edge=>edge.target!==ids[0])||exits.some(edge=>edge.source!==ids.at(-1)))fail('CHAIN_AMBIGUOUS_BOUNDARY','片段内部存在外部入口或出口；不能自动组合边界')
  const boundary=(edges:Edge[],selected:string|undefined,direction:string)=>{
    if(selected){const edge=edges.find(edge=>edge.id===selected);if(!edge)fail('CHAIN_BOUNDARY_EDGE',direction+' edgeId 不在该片段边界');return edge}
    if(edges.length>1)fail('CHAIN_AMBIGUOUS_BOUNDARY',direction+'有多个边；请提供具体 entryEdgeId/exitEdgeId，不能自动笛卡尔连接')
    return edges[0]
  }
  const entry=boundary(entries,locator.boundary?.entryEdgeId,'入口'),exit=boundary(exits,locator.boundary?.exitEdgeId,'出口')
  if(exit&&(exit.port??'default')!=='default')fail('CHAIN_BRANCH_PORT','片段出口不是 default；请使用显式分支映射')
  return {locator,places,graph,ids,internal,entry,exit,extras:[...entries.filter(edge=>edge!==entry),...exits.filter(edge=>edge!==exit)],scope:anchor!.scope}
}

/** Chain aliases expose actual display numbers. Bind those numbers as well as
 * semantic content, since an ordinary save can renumber without a new revision.
 * Navigation remains outside the binding, just as in the canonical edit digest.
 */
export function planningChainDigest(workflow:Workflow):string {
  return jsonDigest({version:1,definitionDigest:planningEditDigest(workflow),numbers:allNodes(workflow).map(node=>[node.id,node.number]).sort(([left],[right])=>left!<right!?-1:left!>right!?1:0)})
}

/** Read-only initial binding. Host derives topology once; callers submit only local operations. */
export function planningChainView(context:PlanningContext,locator:PlanningChainLocator) {
  if(context.operation!=='revise')fail('CHAIN_OPERATION','顺序片段编辑仅用于已有工作流')
  const bound=segment(context,locator),draft=createChainDraft({chainKey:bound.locator.chainKey,baseDigest:planningChainDigest(context.workflow),baseRevision:context.workflow.revision,nodeIds:bound.ids})
  return {version:1 as const,baseDigest:draft.baseDigest,baseRevision:draft.baseRevision,draftRevision:0,chainKey:draft.chainKey,anchorNodeId:bound.locator.anchorNodeId,scope:bound.scope,boundary:{...(bound.entry?{entryEdgeId:bound.entry.id}:{}),...(bound.exit?{exitEdgeId:bound.exit.id}:{})},nodes:draft.active.map(entry=>({alias:entry.alias,nodeId:entry.nodeId!,title:bound.places.get(entry.nodeId!)!.node.title,actualNumber:bound.places.get(entry.nodeId!)!.node.number})),rules:'临时编号仅属于本基线与 draftRevision。# 表示顺序展开，不表示分支。只交 insert/replace/delete/update 和 key/template/values；update 原地改已有节点字段、ID 不变，values 可引用本次新 key；链段外的节点也用 update，target 写它的 key（n+数字），和其他操作合成一个提案；insert 后原节点仍可用原编号指代；新 key 用描述性名字，不用 n+数字（那是 Host 给已有节点的名字）；读取的 nodes 无须回传。标准别名不改写既有 WorkflowNode.number。'}
}

function unavailableReference(value:unknown,removed:ReadonlySet<string>):string|undefined {
  if(typeof value==='string')for(const id of removed)if(new RegExp('(?:^|[^A-Za-z0-9_-])'+id+'(?:[^A-Za-z0-9_-]|$)').test(value))return id
  if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){const found=unavailableReference(key,removed)??unavailableReference(child,removed);if(found)return found}
  return undefined
}
function unavailableConfigReference(config:Record<string,unknown>,kind:WorkflowNode['kind'],removed:ReadonlySet<string>):string|undefined {
  if(kind!=='template')return unavailableReference(config,removed)
  const inputs=config.inputs&&typeof config.inputs==='object'&&!Array.isArray(config.inputs)?config.inputs as Record<string,unknown>:{}
  // Input names are local declarations; their values remain ordinary data and
  // still undergo the conservative removed-identity scan.
  const scan={...config,...(config.inputs?{inputs:Object.fromEntries(Object.values(inputs).map((value,i)=>['__local_input_'+i,value]))}:{}),...(typeof config.text==='string'?{text:maskPlanningTemplateLocals(config.text,Object.keys(inputs))}:{})}
  return unavailableReference(scan,removed)
}

/** Pure programmatic entry. Templates and boundaries compile through the existing AuthoringCore and proposal materializer. */
export function compilePlanningChain(raw:PlanningChainRequest|unknown,context:PlanningContext) {
  const request=planningChainRequestSchema.parse(compilerJson(raw))
  if(context.operation!=='revise')fail('CHAIN_OPERATION','顺序片段编辑仅用于已有工作流')
  if(request.baseRevision!==context.workflow.revision||request.baseDigest!==planningChainDigest(context.workflow))fail('CHAIN_BASE_CONFLICT','操作属于旧工作流版本或显示编号已变化；请重新读取链草稿')
  const bound=segment(context,request),allowed=new Set(context.targetNodeIds)
  for(const id of context.targetNodeIds){const node=bound.places.get(id)?.node;if(node?.config.body)for(const child of allNodes(node.config.body))allowed.add(child.id)}
  const authorize=(id:string)=>{if(bound.places.get(id)?.fixed)fail('CHAIN_FIXED_NODE','固定节点或固定祖先中的节点不能修改：'+id);if(context.targetNodeIds.length&&!allowed.has(id))fail('CHAIN_TARGET_SCOPE','操作或消费者不在授权范围：'+id)}
  let draft:ChainDraft=createChainDraft({chainKey:request.chainKey,baseDigest:request.baseDigest,baseRevision:request.baseRevision,nodeIds:bound.ids})
  const templates=new Map(createTemplateBinding(context.tools,context.toolOutputs).templates.map(template=>[template.id,template])),forms=new Map<string,ChainForm>()
  const refs=planningNodeRefs(context.workflow),hostNames=new Set([...refs.values()].map(ref=>'n'+ref.slice(1))),problems:string[]=[]
  const byKey=new Map([...refs].map(([id,ref])=>['n'+ref.slice(1),id])),outside=new Map<string,Record<string,unknown>>()
  for(let operation of request.operations){
    if(operation.op==='update'&&!isChainAlias(operation.target)){
      const nodeId=byKey.get(operation.target)??(refs.has(operation.target)?operation.target:undefined),current=draft.active.find(entry=>entry.nodeId===nodeId)
      if(current)operation={...operation,target:current.alias}
      else{
        // An update of a node outside the chain changes its fields in place; it never touches edges, so no chain position is needed.
        if(!nodeId||bound.ids.includes(nodeId))problems.push(nodeId?'update 的目标 '+operation.target+' 已在本次修改中删除或替换':'update 的目标 '+operation.target+' 不是链段别名，也不是已有节点的 key（n+数字）或 ID')
        else if(operation.draftRevision!==draft.draftRevision)fail('CHAIN_DRAFT_REVISION','操作属于旧草稿版本；请读取当前 draftRevision')
        else if(Object.hasOwn(operation.values,'body'))problems.push('链段外节点 '+operation.target+' 不能整体改 body；容器内部节点用它们自己的 key 分别 update')
        else{authorize(nodeId);outside.set(nodeId,{...outside.get(nodeId),...operation.values})}
        draft={...draft,draftRevision:draft.draftRevision+1};continue
      }
    }
    const target=draft.active.find(entry=>entry.alias===resolveChainAlias(draft,operation.target))
    if(target?.nodeId)authorize(target.nodeId)
    if(operation.op==='insert'||operation.op==='replace')for(const form of operation.nodes){
      const template=templates.get(form.template)
      if(!template)fail('CHAIN_UNKNOWN_TEMPLATE','模板不在当前冻结目录：'+form.template)
      if(['input','output','if','classifier','loop','iteration','exit_loop'].includes(template!.kind))fail('CHAIN_TEMPLATE_TOPOLOGY','顺序展开模板必须是普通节点；入口/出口、分支或容器需要显式合同')
      if(Object.keys(template!.fixed).some(field=>Object.hasOwn(form.values,field)))fail('CHAIN_TEMPLATE_FIXED','模板固定字段由 Host 注入：'+form.template)
      forms.set(form.key,form)
    }
    // Desktop r60 E: report every bad target and key of one submission together, not one per round.
    try{draft=applyChainSplice(draft,operation)}
    catch(error){if(!(error instanceof CompilerError)||error.code!=='CHAIN_TARGET_INACTIVE')throw error;problems.push(error.message);draft={...draft,draftRevision:draft.draftRevision+1}}
  }
  const clashing=[...forms.keys()].filter(key=>hostNames.has(key))
  if(clashing.length)problems.push(`新模板 key ${clashing.join('、')} 与已有 Host 别名冲突：n+数字是 Host 给已有节点的名字，新节点换成描述性 key（如 extRow）`)
  if(problems.length)fail(problems[0]!.startsWith('新模板 key')?'CHAIN_DUPLICATE_KEY':'CHAIN_TARGET_INACTIVE',problems.join('；另外，'))
  const confirmed=confirmChainDraft(draft),kept=new Set(draft.active.flatMap(entry=>entry.nodeId?[entry.nodeId]:[])),removed=new Set(bound.ids.filter(id=>!kept.has(id)))
  for(const id of removed)if(!allowed.has(id))fail('CHAIN_TARGET_SCOPE','删除/替换节点必须由原请求明确授权目标范围：'+id)
  for(const edge of bound.extras)if(removed.has(edge.source)||removed.has(edge.target))fail('CHAIN_AMBIGUOUS_BOUNDARY','被删除/替换节点仍有未映射外部边 '+edge.id+'；请提供显式多入口/多出口合同')
  const name=(id:string)=>{const ref=refs.get(id);if(!ref)fail('CHAIN_NODE_MISSING','节点不存在：'+id);return 'n'+ref!.slice(1)}
  const finalForms=new Map(draft.active.flatMap(entry=>entry.form?[[entry.form.key,entry.form] as const]:[])),maps:PlanningAliases={nodes:new Map([...refs].map(([id])=>[id,name(id)])),agents:new Map((context.workflow.subAgents??[]).map((item,i)=>[item.id,'r'+(i+1)])),environment:new Map((context.workflow.environmentVariables??[]).map((item,i)=>[item.id,'e'+(i+1)]))}
  const exports=new Map<string,{key:string;field:string}>(),usedExports=new Set<string>()
  for(const item of request.exports){
    const source=bound.places.get(item.from.nodeId)?.node,form=finalForms.get(item.to.key),template=form?templates.get(form.template):undefined
    if(!removed.has(item.from.nodeId)||!source||!form||!template)fail('CHAIN_EXPORT_TARGET','exports 必须从本次删除的旧节点字段指向最终有效的新节点字段')
    const path=item.from.nodeId+'.'+item.from.field
    if(exports.has(path))fail('CHAIN_EXPORT_DUPLICATE','旧输出字段重复映射：'+path)
    const before=planningNodeOutputType(source!,item.from.field,context.toolOutputs),after=planningNodeOutputType({kind:template!.kind,config:{...form!.values,...template!.fixed} as NodeConfig},item.to.field,context.toolOutputs)
    if(!before||!after)fail('CHAIN_EXPORT_TYPE_UNKNOWN','无法证明 exports 输出字段存在且类型明确：'+path+' → '+item.to.key+'.'+item.to.field)
    if(before!==after)fail('CHAIN_EXPORT_TYPE','exports 字段类型不一致：'+before+' → '+after)
    exports.set(path,item.to)
  }
  const rewrite=(reference:string)=>{
    const [id,field,...suffix]=reference.split('.')
    if(!id||!removed.has(id))return reference
    const key=id+'.'+field,mapping=exports.get(key)
    if(!mapping)fail('CHAIN_EXPORT_REQUIRED','旧节点仍有消费者；需要明确 exports：'+reference)
    if(suffix.length)fail('CHAIN_EXPORT_PATH_UNKNOWN','不能证明嵌套输出路径可用：'+reference+'；请使用有确定类型的顶层字段')
    usedExports.add(key);return mapping!.key+'.'+mapping!.field
  }
  const rewriteConfig=(config:Record<string,unknown>,kind:WorkflowNode['kind'],id:string)=>{
    const value=rewritePlanningConfig(config,maps,false,kind,'',new Set(Object.keys(config.inputs??{})),rewrite) as Record<string,unknown>
    const dangling=unavailableConfigReference(value,kind,removed)
    if(dangling)fail('CHAIN_REFERENCE_UNRESOLVED','无法按合法静态引用语法更新 '+id+' 中对 '+dangling+' 的引用或文字；动态、代码、未知位置必须显式处理')
    return value
  }
  const updates:Record<string,unknown>={},edited=new Map([...draft.active.flatMap(entry=>entry.nodeId&&entry.values?[[entry.nodeId,entry.values] as const]:[]),...outside])
  for(const [id,place]of bound.places){
    if(removed.has(id))continue
    const {body:_,...original}=place.node.config,config={...original,...edited.get(id)}
    // Only inspect updated nodes and potential consumers; avoid reserializing unrelated fields.
    if(!edited.has(id)&&!unavailableReference(config,removed))continue
    const value=rewriteConfig(config,place.node.kind,id),named=edited.get(id)??{}
    // Desktop r65 E: send only the fields an update names or that read a removed node. Rewriting turns every reference
    // into a key, so an untouched inputs field reading a module's internal node would look changed and be refused.
    const changed=Object.fromEntries(Object.entries(value).filter(([field,item])=>(Object.hasOwn(named,field)||unavailableReference((original as Record<string,unknown>)[field],removed))&&!equal(item,(original as Record<string,unknown>)[field])))
    if(Object.keys(changed).length){authorize(id);updates[name(id)]={set:changed}}
  }
  const addNodesByKey=Object.fromEntries([...finalForms].map(([key,form])=>{const template=templates.get(form.template)!;return [key,{kind:template.kind,title:form.title??template.title,config:rewriteConfig({...form.values,...template.fixed},template.kind,key),scope:bound.scope.map(name)}]}))
  for(const path of exports.keys())if(!usedExports.has(path))fail('CHAIN_EXPORT_UNUSED','exports 没有匹配任何合法消费者：'+path)
  const oldEdges=[...bound.internal,...(bound.entry?[bound.entry]:[]),...(bound.exit?[bound.exit]:[])],desired:{source:string;target:string;port?:string}[]=[]
  const ordered=draft.active.map(entry=>entry.nodeId?name(entry.nodeId):entry.form!.key),edgeName=(edge:Edge)=>({source:name(edge.source),target:name(edge.target),...(edge.port!==undefined?{port:edge.port}:{})})
  if(ordered.length){
    if(bound.entry)desired.push({...edgeName(bound.entry),target:ordered[0]!})
    for(let i=1;i<ordered.length;i++)desired.push({source:ordered[i-1]!,target:ordered[i]!})
    if(bound.exit)desired.push({...edgeName(bound.exit),source:ordered.at(-1)!})
  }else if(bound.entry&&bound.exit)desired.push({source:name(bound.entry.source),target:name(bound.exit.target),...(bound.entry.port!==undefined?{port:bound.entry.port}:{})})
  const fingerprint=(edge:{source:string;target:string;port?:string})=>JSON.stringify([edge.source,edge.target,edge.port??'default'])
  const oldKeys=new Set(oldEdges.map(edge=>fingerprint(edgeName(edge)))),nextKeys=new Set(desired.map(fingerprint)),scope=bound.scope.map(name)
  for(const edge of oldEdges)if(!nextKeys.has(fingerprint(edgeName(edge)))&&(bound.places.get(edge.source)?.fixed||bound.places.get(edge.target)?.fixed))fail('CHAIN_FIXED_NODE','不能重接固定节点或固定祖先中的节点边界：'+edge.id)
  const removeLinks=oldEdges.filter(edge=>!nextKeys.has(fingerprint(edgeName(edge)))).map(edge=>({...edgeName(edge),scope})),addLinksByKey=Object.fromEntries(desired.filter(edge=>!oldKeys.has(fingerprint(edge))).map((edge,i)=>['chainEdge'+i,{...edge,scope}]))
  const coverage=[...new Set([...ordered,...Object.keys(updates),...(bound.exit&&!removed.has(bound.exit.target)?[name(bound.exit.target)]:[])])]
  if(!coverage.length)fail('CHAIN_EMPTY','编辑后没有可发布的有效片段或出口')
  const compiled=new AuthoringCore(context).compile({mode:'edit',updates,addNodesByKey,removeNodes:[...removed].map(name),removeLinks,addLinksByKey,coverage:{R1:coverage},summary:'按版本绑定临时别名编译局部顺序片段；Host 接边及保留稳定身份'})
  if(!compiled.candidate)fail('CHAIN_CANDIDATE','顺序片段没有生成候选')
  const nextNodes=new Map(allNodes(compiled.candidate!).map(node=>[node.id,node])),added=[...finalForms.keys()],pool=[...new Set(context.nodeIds.filter(id=>!refs.has(id)))],allocated=new Map(added.map((key,i)=>[key,pool[i]!]))
  const mapping=confirmed.entries.map(entry=>{const nodeId=entry.nodeId??allocated.get(entry.form!.key)!,node=nextNodes.get(nodeId);if(!node)fail('CHAIN_ALLOCATION','Host 分配结果缺少节点');return {temporaryAlias:entry.alias,standardAlias:entry.standardAlias,nodeId,actualNumber:node!.number}})
  return {...compiled,chain:{version:1 as const,baseDigest:request.baseDigest,baseRevision:request.baseRevision,draftRevision:draft.draftRevision,mapping,retiredAliases:[...draft.retired],aliasWrites:draft.aliasWrites}}
}
