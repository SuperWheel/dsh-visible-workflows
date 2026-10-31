import { AUTHORING_TOPOLOGY_GUIDANCE } from './planning-authoring-core.ts'
import type { NodeKind } from './types.ts'
import type { PlanningContext } from './planning-types.ts'
import { planningEditView, rewritePlanningConfig, type PlanningAliases } from './planning-edits.ts'
import { allNodes } from './workflow-validation.ts'
import { contextSelection, planningContextSlice, selectedConfigFields } from './planning-context-slice.ts'
import { CANONICAL_INPUT_GUIDANCE, CANONICAL_TEMPLATE_GUIDANCE, CANONICAL_EXIT_GUIDANCE, TEMPLATE_RENDER_BOUNDARY_GUIDANCE, queryWorkflowSemantics, NODE_SEMANTICS } from './workflow-semantics.ts'
import { planningNodeOutputType } from './planning-projection.ts'
import type { WorkflowNode } from './types.ts'

/** Read-only context projection. IDs, unrelated configs and repeated catalog schemas stay Host-side. */
/** Outputs shown to the planner use the same per-kind inference as reference
 * checking: runtime wrapper fields keep their meaning, declared fields add types. */
function nodeOutputs(n:{kind:NodeKind;config:Record<string,unknown>},toolOutputs:PlanningContext['toolOutputs']):Record<string,string>{
  const node=n as Pick<WorkflowNode,'kind'|'config'>,wrappers=NODE_SEMANTICS[n.kind].outputs as Record<string,string>
  const declared=[...((node.config.outputSchema??[]) as {name:string;type?:string}[]),...(n.kind==='extractor'?(node.config.parameters??[]) as {name:string;type?:string}[]:[]),...(['input','human'].includes(n.kind)?(node.config.fields??[]) as {name:string;type?:string}[]:[])]
  const result:Record<string,string>={...wrappers}
  // Optional declared fields may be absent at runtime; keep their type, marked optional.
  for(const field of declared)if(n.kind==='input'||!Object.hasOwn(wrappers,field.name))result[field.name]=planningNodeOutputType(node,field.name,toolOutputs)??(field.type?field.type+'?':'unknown')
  return result
}
export function authoringGraphContext(context:PlanningContext){
  const view=planningEditView(context),name=(ref:string)=>ref.startsWith('@')?'n'+ref.slice(1):ref
  const maps:PlanningAliases={nodes:new Map(view.nodes.map(n=>[n.ref,name(n.ref)])),agents:new Map(view.subAgents.map(a=>[a.ref,'r'+a.ref.slice(2)])),environment:new Map(view.environmentVariables.map(e=>[e.ref,'e'+e.ref.slice(2)]))}
  return view.nodes.map(n=>({key:name(n.ref),kind:n.kind,title:n.title,...(n.note===undefined?{}:{note:n.note}),scope:n.scope.map(name),config:rewritePlanningConfig(n.config,maps,false,n.kind)}))
}
export function authoringContext(context:PlanningContext,instruction:string){
  const view=planningEditView(context),name=(ref:string)=>ref.startsWith('@')?'n'+ref.slice(1):ref
  const maps:PlanningAliases={nodes:new Map(view.nodes.map(n=>[n.ref,name(n.ref)])),agents:new Map(view.subAgents.map(a=>[a.ref,'r'+a.ref.slice(2)])),environment:new Map(view.environmentVariables.map(e=>[e.ref,'e'+e.ref.slice(2)]))}
  const selection=contextSelection(context),slice=planningContextSlice(context,selection)
  const ids=allNodes(context.workflow).map(n=>n.id),idByRef=new Map(view.nodes.map(n=>[n.ref,ids[Number(n.ref.slice(1))-1]!])),refById=new Map(view.nodes.map(n=>[ids[Number(n.ref.slice(1))-1]!,n.ref]))
  const selected=new Set(slice.targetNodeIds.map(id=>refById.get(id)!)),read=new Set(slice.readNodeIds.map(id=>refById.get(id)!))
  const graphNodes=view.nodes.filter(n=>read.has(n.ref))
  const configFor=(n:typeof view.nodes[number])=>{
    const config=rewritePlanningConfig(n.config,maps,false,n.kind) as Record<string,unknown>
    if(!selected.has(n.ref))return Object.fromEntries(Object.entries(config).filter(([key,value])=>['conditions','branches','categories','outputSchema','fields'].includes(key)||JSON.stringify(value).includes('{{')))
    const fields=selectedConfigFields(selection?.targetFields?.[idByRef.get(n.ref)!])
    return fields?Object.fromEntries(Object.entries(config).filter(([key])=>fields.includes(key))):config
  }
  const configEntry=(n:typeof view.nodes[number]):{config?:Record<string,unknown>;dependencyInputs?:Record<string,unknown>}=>selected.has(n.ref)?{config:configFor(n)}:{dependencyInputs:configFor(n)}
  const kinds:NodeKind[]=graphNodes.map(n=>n.kind)
  if(/代码|计算|统计|排序|JSON|求和/i.test(instruction))kinds.unshift('code')
  if(/人工|确认|核对|人审|审核|\breview\b|\bapproval\b/i.test(instruction))kinds.unshift('human')
  kinds.push('input','output','template','llm')
  const prefetchedKinds=[...new Set(kinds)].slice(0,5)
  const semantics=queryWorkflowSemantics({kinds:prefetchedKinds})
  const operations=context.tools.filter(tool=>tool.operationContract&&graphNodes.some(node=>node.kind==='tool'&&node.config.toolId===tool.id)).map(tool=>({toolId:tool.id,operations:tool.operationContract}))
  // Read dependencies are projected independently from the Host edit allowlist.
  return {
    operation:context.operation,model:context.model,...(context.effort?{effort:context.effort}:{}),
    graph:context.operation==='create'?undefined:{
      title:view.title,description:view.description,...(view.modules?{modules:view.modules}:{}),
      nodes:graphNodes.map(n=>({key:name(n.ref),kind:n.kind,title:n.title,...(n.note===undefined||!selected.has(n.ref)?{}:{note:n.note}),scope:n.scope.map(name),fixed:view.fixedNodeRefs.includes(n.ref),outputs:nodeOutputs(n,context.toolOutputs),
        ...configEntry(n),dependencyReasons:slice.reasons[idByRef.get(n.ref)!],editable:slice.editableNodeIds.includes(idByRef.get(n.ref)!)})),
      edges:view.edges.filter(e=>(read.has(e.source)||view.modules?.some(m=>m.ref===e.source))&&(read.has(e.target)||view.modules?.some(m=>m.ref===e.target))).map(e=>({...e,source:name(e.source),target:name(e.target),scope:e.scope?.map(name)})),
      targetKeys:slice.targetNodeIds.filter(id=>refById.has(id)).map(id=>name(refById.get(id)!)),
      selection:{readOnlyKeys:slice.readNodeIds.filter(id=>refById.has(id)&&!slice.editableNodeIds.includes(id)).map(id=>name(refById.get(id)!)),conservative:slice.conservative},
      roles:view.subAgents.map(({ref,...a})=>({key:maps.agents.get(ref),...a})),
      environment:view.environmentVariables.map(({ref,...e})=>({key:maps.environment.get(ref),...e})),
    },
    semantics,prefetchedKinds,
    toolOutputContracts:context.toolOutputs?.contracts.filter(contract=>graphNodes.some(node=>node.kind==='tool'&&node.config.toolId===contract.toolId)).map(({toolId,guarantee})=>({toolId,guarantee})),
    ...(operations.length?{toolOperationContracts:operations}:{}),
    tools:context.tools.map(tool=>({id:tool.id,name:tool.name,available:tool.available})),
    rules:'note 是目标节点的只读备注（最多300字），修改备注用 description，null 清除；固定节点也仅允许改备注。使用已给出的节点字段。省略的节点配置如确有必要，用 planner_graph_context 的 keys 批量读取。缺少类型时只查一次所需 kinds 的目录。input 是表单；template/llm 输出 text。其他上游节点引用用 {{key.text}}；不得猜测不存在的输出字段。业务不在规划阶段执行。'+CANONICAL_INPUT_GUIDANCE+CANONICAL_TEMPLATE_GUIDANCE+TEMPLATE_RENDER_BOUNDARY_GUIDANCE+CANONICAL_EXIT_GUIDANCE+AUTHORING_TOPOLOGY_GUIDANCE,
  }
}
